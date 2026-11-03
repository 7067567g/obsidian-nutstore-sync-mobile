import { posix as pathPosix } from 'path-browserify'
import { tool } from 'ai'
import { z } from 'zod/mini'
import {
	AGENTS_MOUNT_POINT,
	BUILTIN_SKILLS_MOUNT_POINT,
	execVaultBash,
	SETTINGS_MOUNT_POINT,
	VAULT_MOUNT_POINT,
} from './runtime'
import { BASH_TMP_MOUNT_POINT } from './tmp-fs'
import {
	appDep,
	fileSystemManagerDep,
	getSettingsSnapshotDep,
	permissionGuardDep,
	readTrackerDep,
	recordMetadataDep,
	sessionDep,
	updateSettingsDep,
} from '~/ai/tools/tool-context'
import {
	TOOL_OUTPUT_INLINE_BUDGET_BYTES,
	retainToolOutputForModel,
} from '~/ai/chat/runtime/tool-output-retention'
import { PermissionDeniedError } from '~/ai/chat/tool-outcome'
import i18n from '~/i18n'
import { perfMetrics } from '~/diagnostics/perf-metrics'
import logger from '~/utils/logger'
import { booleanValue, textValue } from '~/ai/tools/shared'

function isAllowedBashCwd(pathValue: string) {
	const normalized = pathPosix.normalize(
		pathPosix.resolve('/', pathValue || '/'),
	)
	return normalized.startsWith('/')
}

export const bashTool = tool({
	description: [
		`Execute a browser-based bash subset against a virtual filesystem where the Obsidian vault is rooted at ${VAULT_MOUNT_POINT}, agent data is available at ${AGENTS_MOUNT_POINT}, built-in Skills are read-only under ${BUILTIN_SKILLS_MOUNT_POINT}, and plugin settings are editable at ${SETTINGS_MOUNT_POINT}/settings.json.`,
		'This is not the host shell: node, python, xxd, and some command flags are unavailable.',
		'For ordinary vault note listing, reading, and content search, prefer the native vault_list / vault_read / vault_grep tools. Use this bash tool only when you need shell pipelines or non-vault filesystem access.',
		'Prefer supported commands such as ls, cat, rg, jq, sed, awk, od, gzip, gunzip, zcat, zip, unzip, mkdir, mv, cp, and rm. zip and unzip support standard store/deflate archives, but not encrypted, Zip64, or uncommon compression formats.',
		`Wildcards expand against a snapshot index of the vault (notes and attachments, plus ${AGENTS_MOUNT_POINT}); other hidden dot-folders are not in that index, so globs can report no matches for files that do exist. When a glob or rg finds nothing, list the parent directory or read the explicit path directly before concluding a file is missing.`,
		`Treat the filesystem root as the user's personal knowledge base — only write there for content the user intends to keep; use ${BASH_TMP_MOUNT_POINT} for intermediate or scratch work.`,
		`The plugin settings file ${SETTINGS_MOUNT_POINT}/settings.json is virtual and reflects live settings (whitelist only, never credentials). To change settings, write the complete file as valid JSON — prefer jq or a full-file rewrite; the plugin validates and applies it on save.`,
		`The required "purpose" field is a very short (up to 120 characters) plain-language summary of what this command does and why it is being run, written in the same language as the user's request and safe for users who cannot read shell — no code, no markdown, no newlines, no shell syntax.`,
	].join(' '),
	inputSchema: z.object({
		purpose: textValue('purpose').check(
			z.maxLength(
				120,
				i18n.t('chatbox.errors.toolFieldTooLong', { field: 'purpose' }),
			),
		),
		script: textValue('script'),
		cwd: z._default(z.string(), VAULT_MOUNT_POINT),
		stdin: z.optional(z.string()),
		rawScript: z._default(booleanValue('rawScript'), false),
	}),
	contextSchema: z.object({
		app: appDep,
		session: sessionDep,
		fileSystemManager: fileSystemManagerDep,
		permissionGuard: permissionGuardDep,
		readTracker: readTrackerDep,
		recordMetadata: recordMetadataDep,
		getSettingsSnapshot: getSettingsSnapshotDep,
		updateSettings: updateSettingsDep,
	}),
	outputSchema: z.string(),
	execute: async (params, { context, toolCallId, abortSignal }) => {
		const {
			app,
			session,
			fileSystemManager,
			permissionGuard,
			readTracker,
			recordMetadata,
			getSettingsSnapshot,
			updateSettings,
		} = context
		const cwd = params.cwd || VAULT_MOUNT_POINT
		if (!isAllowedBashCwd(cwd)) {
			throw new Error(
				`Invalid bash cwd: ${cwd}. The cwd must be an absolute virtual path.`,
			)
		}

		const bashAccess = getSettingsSnapshot?.()?.ai?.bashAccess ?? 'deny'
		if (bashAccess === 'deny') {
			throw new Error('BASH_DISABLED: bash is disabled in settings.')
		}
		// AUD-03: `bashAccess` describes the configured gate; the actual
		// authorization source (`once` / `session` / `always`) is only known
		// after the guard returns, so resolve it before the execution audit.
		let authorization: string = bashAccess
		if (bashAccess === 'ask') {
			if (!permissionGuard) {
				throw new PermissionDeniedError(
					'BASH_ACCESS_DENIED: permission guard unavailable.',
				)
			}
			try {
				authorization =
					(await permissionGuard({
						type: 'bash',
						command: params.script,
						purpose: params.purpose,
					})) ?? 'once'
			} catch (error) {
				logger.info('Bash access denied', {
					toolCallId,
					sessionId: session.id,
					access: 'denied',
					requestedAccess: bashAccess,
					purpose: params.purpose,
					reason: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
		}

		logger.info('Bash execution audit', {
			toolCallId,
			sessionId: session.id,
			access: authorization,
			purpose: params.purpose,
			cwd,
			scriptBytes: params.script.length,
		})

		const timeoutMs = getSettingsSnapshot?.()?.ai?.toolTimeoutMs
		let result
		try {
			result = await execVaultBash(app, params.script, {
				cwd,
				stdin: params.stdin,
				rawScript: params.rawScript,
				abortSignal,
				timeoutMs,
				heartbeatIntervalMs: 2000,
				onHeartbeat: () => perfMetrics.recordBridgeCall('bash.heartbeat'),
				permissionGuard: undefined,
				// The command was already authorized at the tool boundary above
				// (bashAccess 'always', or 'ask' + the command-level approval).
				// Declare that explicitly so the fail-closed vault FS keeps the
				// 1.5.7 one-prompt-per-command model instead of denying writes.
				unguardedWrite: 'bash-command',
				onRead: readTracker?.markRead.bind(readTracker),
				getSettingsSnapshot,
				updateSettings,
				fileSystemManager,
			})
		} catch (error) {
			logger.info('Bash execution failed', {
				toolCallId,
				sessionId: session.id,
				access: bashAccess,
				purpose: params.purpose,
				reason: error instanceof Error ? error.message : String(error),
			})
			throw error
		}
		const output = `${result.stdout}\n\n${result.stderr}`
		recordMetadata?.(toolCallId, {
			reversibleOps: result.reversibleOps,
		})
		if (
			new TextEncoder().encode(output).byteLength >
			TOOL_OUTPUT_INLINE_BUDGET_BYTES
		) {
			return await retainToolOutputForModel(app.vault, session.id, output, {
				toolName: 'bash',
				toolCallId,
			})
		}
		return output
	},
	toModelOutput: ({ output }) => ({
		type: 'text',
		value: output,
	}),
})
