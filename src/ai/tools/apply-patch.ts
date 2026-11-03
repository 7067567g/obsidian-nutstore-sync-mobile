import { tool } from 'ai'
import { z } from 'zod/mini'
import i18n from '~/i18n'
import { ReversibleOpRecorder } from '~/ai/tools/bash/fs'
import {
	AGENTS_MOUNT_POINT,
	BASH_TMP_MOUNT_POINT,
	SETTINGS_FILE_PATH,
	VAULT_MOUNT_POINT,
} from '~/ai/tools/bash/mount-points'
import { createVaultFileSystem } from './vault-filesystem'
import { applyHunks } from './apply-patch-hunks'
import { invalidPatch, parsePatch } from './apply-patch-parse'
import {
	assertUniqueVirtualPaths,
	readBinaryText,
	resolveVirtualPath,
	toDisplayKey,
	toReadKey,
} from './apply-patch-paths'
import { withPermissionPurpose } from './permission-guard'
import { textValue } from './shared'
import {
	appDep,
	fileSystemManagerDep,
	getSettingsSnapshotDep,
	permissionGuardDep,
	readTrackerDep,
	recordMetadataDep,
	updateSettingsDep,
} from './tool-context'

type PlannedOperation =
	| { kind: 'add'; path: string; content: string }
	| { kind: 'delete'; path: string; before: string }
	| {
			kind: 'update'
			path: string
			moveTo?: string
			before: string
			after: string
	  }

export { parsePatch } from './apply-patch-parse'
export { applyHunks } from './apply-patch-hunks'

export const applyPatchTool = tool({
	description: [
		'Apply a file-oriented patch against the virtual filesystem.',
		'The required "purpose" field is a very short (up to 120 characters) plain-language summary of what this patch changes and why it is being applied, written in the same language as the user\'s request and safe for users who cannot read diffs — no code, no markdown, no newlines, no patch syntax.',
		`Use a vault-relative path for files in the vault (relative paths resolve from ${VAULT_MOUNT_POINT}), or an absolute virtual path for any writable mounted filesystem. For example, scratch files live under ${BASH_TMP_MOUNT_POINT}, agent data under ${AGENTS_MOUNT_POINT}, and live plugin settings at ${SETTINGS_FILE_PATH}.`,
		'Every patch, including one that only adds, deletes, updates, or moves a single file, MUST start with "*** Begin Patch" and end with "*** End Patch".',
		'An Add patch has this complete form: "*** Begin Patch\\n*** Add File: notes/example.md\\n+Example line\\n+\\n+示例行 🌱\\n*** End Patch".',
		'Every line in an Add File section, including blank lines, must start with +.',
		'A Delete patch has this complete form: "*** Begin Patch\\n*** Delete File: notes/example.md\\n*** End Patch".',
		'An Update patch has this complete form: "*** Begin Patch\\n*** Update File: notes/example.md\\n@@\\n-old text\\n+new text\\n*** End Patch".',
		'File operation headers always use the colon syntax: "*** Add File: path", "*** Delete File: path", "*** Update File: path", and "*** Move to: path".',
		'Update sections contain @@ hunks; unified numeric headers such as @@ -10,3 +10,4 @@ are also accepted.',
		'Unchanged lines start with a space, removals with -, and additions with +.',
		'Include *** Move to immediately after an Update File header only when renaming the file; its value must be the destination vault path, never a description of the edit.',
		'Include enough unchanged context for every hunk to match exactly once.',
		'Read existing files before updating, deleting, or moving them.',
	].join(' '),
	inputSchema: z.object({
		purpose: textValue('purpose').check(
			z.maxLength(
				120,
				i18n.t('chatbox.errors.toolFieldTooLong', { field: 'purpose' }),
			),
		),
		patch: textValue('patch'),
	}),
	contextSchema: z.object({
		app: appDep,
		fileSystemManager: fileSystemManagerDep,
		permissionGuard: permissionGuardDep,
		readTracker: readTrackerDep,
		recordMetadata: recordMetadataDep,
		getSettingsSnapshot: getSettingsSnapshotDep,
		updateSettings: updateSettingsDep,
	}),
	outputSchema: z.object({
		applied: z.literal(true),
		files: z.array(z.string()),
	}),
	execute: async ({ patch, purpose }, { context, toolCallId }) => {
		const {
			app,
			fileSystemManager,
			permissionGuard,
			readTracker,
			recordMetadata,
			getSettingsSnapshot,
			updateSettings,
		} = context
		const operations = parsePatch(patch)

		const virtualPaths = new Map<string, string>()
		for (const operation of operations) {
			virtualPaths.set(operation.path, resolveVirtualPath(operation.path))
			if (operation.kind === 'update' && operation.moveTo) {
				virtualPaths.set(operation.moveTo, resolveVirtualPath(operation.moveTo))
			}
		}
		assertUniqueVirtualPaths([...virtualPaths.values()])

		const recorder = new ReversibleOpRecorder()
		const mountable = await createVaultFileSystem(app, {
			permissionGuard: withPermissionPurpose(permissionGuard, purpose),
			recorder,
			onRead: (vaultPath) => readTracker?.markRead(vaultPath),
			getSettingsSnapshot,
			updateSettings,
			fileSystemManager,
		})

		const planned: PlannedOperation[] = []
		for (const operation of operations) {
			const path = virtualPaths.get(operation.path)!
			if (operation.kind === 'add') {
				if (await mountable.exists(path)) {
					invalidPatch(
						`cannot add "${operation.path}" because it already exists`,
					)
				}
				planned.push({ kind: 'add', path, content: operation.content })
				continue
			}
			if (
				!readTracker?.hasRead(path) &&
				!readTracker?.hasRead(toReadKey(path))
			) {
				throw new Error(
					i18n.t('chatbox.errors.fileNotRead', { path: operation.path }),
				)
			}
			if (!(await mountable.exists(path))) {
				throw new Error(
					i18n.t('chatbox.errors.fileNotFound', { path: operation.path }),
				)
			}
			const before = readBinaryText(await mountable.readFileBuffer(path))
			if (operation.kind === 'delete') {
				planned.push({ kind: 'delete', path, before })
				continue
			}
			const moveTo = operation.moveTo
				? virtualPaths.get(operation.moveTo)
				: undefined
			if (moveTo && moveTo !== path && (await mountable.exists(moveTo))) {
				invalidPatch(
					`cannot move "${operation.path}" to "${operation.moveTo}" because the destination exists`,
				)
			}
			planned.push({
				kind: 'update',
				path,
				moveTo,
				before,
				after: applyHunks(before, operation.hunks, operation.path),
			})
		}

		for (const operation of planned) {
			if (operation.kind === 'add') {
				await mountable.writeFile(operation.path, operation.content)
			} else if (operation.kind === 'delete') {
				await mountable.rm(operation.path)
			} else {
				if (operation.after !== operation.before) {
					await mountable.writeFile(operation.path, operation.after)
				}
				if (operation.moveTo && operation.moveTo !== operation.path) {
					await mountable.mv(operation.path, operation.moveTo)
				}
			}
		}

		const reversibleOps = await recorder.getNetOperations()
		recordMetadata?.(toolCallId, { reversibleOps })
		const files = [
			...new Set(
				planned.flatMap((operation) =>
					operation.kind === 'update' && operation.moveTo
						? [toDisplayKey(operation.path), toDisplayKey(operation.moveTo)]
						: [toDisplayKey(operation.path)],
				),
			),
		]
		return { applied: true as const, files }
	},
	toModelOutput: ({ output }) => ({
		type: 'text',
		value: `Done!\n${output.files.map((path) => `- ${path}`).join('\n')}`,
	}),
})
