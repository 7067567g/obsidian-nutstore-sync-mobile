import { tool } from 'ai'
import { z } from 'zod/mini'
import type { App } from 'obsidian'
import type { PermissionGuard } from './permission-guard'
import { appDep, permissionGuardDep } from './tool-context'
import {
	clampInt,
	getNodeSize,
	isVaultFileNode,
	isFolderNode,
	isHiddenVaultPath,
	normalizeVaultVirtualPath,
	toVaultPath,
} from './vault-native'

const DEFAULT_MAX_FILES = 200
const MAX_FILES = 1000
const MAX_FILE_BYTES = 2 * 1024 * 1024

function wildcardToRegExp(glob: string) {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/\?/g, '.')
	return new RegExp('^' + escaped + '$')
}

function replaceExact(text: string, find: string, replacement: string) {
	return text.split(find).join(replacement)
}

function countExact(text: string, find: string) {
	if (!find) return 0
	return text.split(find).length - 1
}

export interface VaultBatchEditReplacement {
	find: string
	replace: string
}

export interface VaultBatchEditOptions {
	path?: string
	glob?: string
	replacements: VaultBatchEditReplacement[]
	maxFiles?: number
	dryRun?: boolean
	purpose?: string
	permissionGuard?: PermissionGuard
}

function selectFiles(
	app: App,
	normalized: string,
	vaultPath: string,
	glob: string | undefined,
	maxFiles: number,
) {
	const node = vaultPath
		? app.vault.getAbstractFileByPath(vaultPath)
		: app.vault.getRoot()
	if (isVaultFileNode(node)) {
		const size = getNodeSize(node)
		if (size !== undefined && size > MAX_FILE_BYTES) {
			throw new Error(
				'File is too large for mobile vault_batch_edit (' +
					size +
					' bytes). Use desktop MCP for large files.',
			)
		}
		return { files: [node], skippedLarge: 0 }
	}
	if (!isFolderNode(node)) {
		throw new Error(
			'vault_batch_edit supports visible vault files only: ' + normalized,
		)
	}
	const prefix = vaultPath ? vaultPath + '/' : ''
	const globRe = glob ? wildcardToRegExp(glob) : undefined
	const files = []
	let skippedLarge = 0
	for (const file of app.vault.getFiles()) {
		if (isHiddenVaultPath(file.path)) continue
		if (prefix && !file.path.startsWith(prefix)) continue
		if (globRe && !globRe.test(file.path)) continue
		const size = getNodeSize(file)
		if (size !== undefined && size > MAX_FILE_BYTES) {
			skippedLarge++
			continue
		}
		files.push(file)
	}
	return { files: files.slice(0, maxFiles), skippedLarge }
}

export async function executeVaultBatchEdit(
	app: App,
	options: VaultBatchEditOptions,
) {
	const normalized = normalizeVaultVirtualPath(options.path ?? '/')
	const vaultPath = toVaultPath(normalized)
	const maxFiles = clampInt(options.maxFiles, DEFAULT_MAX_FILES, 1, MAX_FILES)
	if (options.replacements.length === 0) {
		throw new Error('vault_batch_edit requires at least one replacement')
	}
	for (const replacement of options.replacements) {
		if (!replacement.find) {
			throw new Error('vault_batch_edit find strings must not be empty')
		}
	}
	const { files, skippedLarge } = selectFiles(
		app,
		normalized,
		vaultPath,
		options.glob,
		maxFiles,
	)
	const pending: Array<{
		file: (typeof files)[number]
		content: string
		nextContent: string
		matches: number
	}> = []
	for (const file of files) {
		const content = await app.vault.read(file)
		let nextContent = content
		let matches = 0
		for (const replacement of options.replacements) {
			matches += countExact(nextContent, replacement.find)
			nextContent = replaceExact(
				nextContent,
				replacement.find,
				replacement.replace,
			)
		}
		if (nextContent !== content) {
			pending.push({ file, content, nextContent, matches })
		}
	}

	if (options.dryRun) {
		if (pending.length === 0) {
			return normalized + ': no replacements would be made'
		}
		return (
			normalized +
			': ' +
			pending.length +
			' file(s) would change, ' +
			pending.reduce((total, item) => total + item.matches, 0) +
			' replacement(s)\n' +
			pending.map((item) => item.file.path + ': ' + item.matches).join('\n')
		)
	}
	if (pending.length === 0) {
		return normalized + ': no replacements needed'
	}

	await options.permissionGuard?.({
		type: 'fs',
		fs: {
			kind: 'edit',
			paths: pending.map((item) => item.file.path),
		},
		purpose: options.purpose,
	})

	let changed = 0
	let applied = 0
	for (const item of pending) {
		if (typeof app.vault.process === 'function') {
			await app.vault.process(item.file, (current) => {
				if (current !== item.content) {
					throw new Error('File changed during batch edit: ' + item.file.path)
				}
				return item.nextContent
			})
		} else {
			await app.vault.modify(item.file, item.nextContent)
		}
		changed++
		applied += item.matches
	}

	const skipped =
		skippedLarge > 0 ? ' (' + skippedLarge + ' large file(s) skipped)' : ''
	return (
		'Updated ' + changed + ' file(s), ' + applied + ' replacement(s)' + skipped
	)
}

export const vaultBatchEditTool = tool({
	description: [
		'Apply exact string replacements across multiple visible vault files without shell loops.',
		'Use this instead of bash sed/cp/head loops for repetitive document edits.',
		'Input path is a vault virtual path; optional glob filters file paths (for example *.md).',
		'replacements is an ordered list of find/replace pairs; find must be a non-empty exact string.',
		'Set dryRun true to preview which files would change without writing or requesting permission.',
	].join(' '),
	inputSchema: z.object({
		purpose: z.string(),
		path: z.optional(z.string()),
		glob: z.optional(z.string()),
		replacements: z.array(
			z.object({
				find: z.string(),
				replace: z.string(),
			}),
		),
		maxFiles: z.optional(z.number()),
		dryRun: z.optional(z.boolean()),
	}),
	contextSchema: z.object({
		app: appDep,
		permissionGuard: permissionGuardDep,
	}),
	outputSchema: z.string(),
	execute: async (
		{ path, glob, replacements, maxFiles, dryRun, purpose },
		{ context },
	) =>
		executeVaultBatchEdit(context.app, {
			path,
			glob,
			replacements,
			maxFiles,
			dryRun,
			purpose,
			permissionGuard: context.permissionGuard,
		}),
})
