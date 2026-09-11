import { parseYaml, stringifyYaml } from 'obsidian'
import type { App } from 'obsidian'
import { tool } from 'ai'
import { z } from 'zod/mini'
import { appDep, permissionGuardDep, readTrackerDep } from './tool-context'
import type { PermissionGuard } from './permission-guard'
import {
	clampInt,
	isFolderNode,
	isVaultFileNode,
	normalizeVaultVirtualPath,
	toVaultPath,
} from './vault-native'

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const DEFAULT_MAX_FILES = 200
const MAX_FILES = 1000

function wildcardToRegExp(glob: string) {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/\?/g, '.')
	return new RegExp('^' + escaped + '$')
}

function stripPosition(frontmatter: Record<string, unknown>) {
	const fields: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(frontmatter)) {
		if (key === 'position') continue
		fields[key] = value
	}
	return fields
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
		if (node.extension && node.extension !== 'md') {
			throw new Error(
				'vault_frontmatter only supports markdown files: ' + node.path,
			)
		}
		if (glob && !wildcardToRegExp(glob).test(node.path)) {
			throw new Error('File does not match glob: ' + node.path)
		}
		return [node]
	}
	if (!isFolderNode(node)) {
		throw new Error(
			'vault_frontmatter supports visible vault markdown files only: ' +
				normalized,
		)
	}
	const prefix = vaultPath ? vaultPath + '/' : ''
	const globRe = glob ? wildcardToRegExp(glob) : undefined
	return app.vault
		.getMarkdownFiles()
		.filter((file) => !prefix || file.path.startsWith(prefix))
		.filter((file) => !globRe || globRe.test(file.path))
		.sort((left, right) => left.path.localeCompare(right.path))
		.slice(0, maxFiles)
}

export interface VaultFrontmatterOptions {
	action: 'read' | 'update'
	path?: string
	glob?: string
	keys?: string[]
	set?: Record<string, unknown>
	deleteKeys?: string[]
	maxFiles?: number
	purpose?: string
	permissionGuard?: PermissionGuard
	readTracker?: { markRead(path: string): void }
}

export async function executeVaultFrontmatter(
	app: App,
	options: VaultFrontmatterOptions,
) {
	const normalized = normalizeVaultVirtualPath(options.path ?? '/')
	const vaultPath = toVaultPath(normalized)
	const maxFiles = clampInt(options.maxFiles, DEFAULT_MAX_FILES, 1, MAX_FILES)
	const files = selectFiles(app, normalized, vaultPath, options.glob, maxFiles)
	if (files.length === 0) {
		return normalized + ': no markdown files selected'
	}

	if (options.action === 'read') {
		const rows = files.map((file) => {
			const frontmatter = stripPosition(
				app.metadataCache.getFileCache(file)?.frontmatter ?? {},
			)
			const selected = options.keys
				? Object.fromEntries(
						options.keys
							.filter((key) => key in frontmatter)
							.map((key) => [key, frontmatter[key]]),
					)
				: frontmatter
			options.readTracker?.markRead(file.path)
			return { path: file.path, frontmatter: selected }
		})
		return JSON.stringify(rows, null, 2)
	}

	const set = options.set ?? {}
	const deleteKeys = new Set(options.deleteKeys ?? [])
	if (Object.keys(set).length === 0 && deleteKeys.size === 0) {
		throw new Error('frontmatter update requires set and/or deleteKeys')
	}
	const pending: Array<{
		file: (typeof files)[number]
		content: string
		nextContent: string
	}> = []
	for (const file of files) {
		const content = await app.vault.read(file)
		const cacheFields = stripPosition(
			app.metadataCache.getFileCache(file)?.frontmatter ?? {},
		)
		const match = FRONTMATTER_PATTERN.exec(content)
		let existing: Record<string, unknown>
		if (match) {
			let parsedFields: Record<string, unknown> | undefined
			if (match[1].trim() === '') {
				parsedFields = {}
			} else {
				try {
					const parsed = parseYaml(match[1])
					if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
						parsedFields = stripPosition(parsed as Record<string, unknown>)
					}
				} catch {
					parsedFields = undefined
				}
			}
			if (!parsedFields) {
				if (Object.keys(cacheFields).length === 0) {
					throw new Error(
						'Cannot safely update frontmatter for ' +
							file.path +
							': existing YAML could not be parsed.',
					)
				}
				parsedFields = cacheFields
			}
			existing = parsedFields
		} else {
			existing = {}
		}
		for (const key of deleteKeys) delete existing[key]
		for (const [key, value] of Object.entries(set)) existing[key] = value
		const hasFrontmatter = match !== null
		const hasFields = Object.keys(existing).length > 0
		if (!hasFrontmatter && !hasFields) continue

		const body = match ? content.slice(match[0].length) : content
		const yaml = stringifyYaml(existing).replace(/\s+$/, '')
		const nextContent = hasFields ? '---\n' + yaml + '\n---\n' + body : body
		if (nextContent === content) continue
		pending.push({ file, content, nextContent })
	}
	if (pending.length === 0) {
		return normalized + ': frontmatter already up to date'
	}
	await options.permissionGuard?.({
		type: 'fs',
		fs: {
			kind: 'write',
			paths: pending.map((item) => item.file.path),
		},
		purpose: options.purpose,
	})
	const changed: string[] = []
	for (const item of pending) {
		if (typeof app.vault.process === 'function') {
			await app.vault.process(item.file, (current) => {
				if (current !== item.content) {
					throw new Error(
						'File changed during frontmatter update: ' + item.file.path,
					)
				}
				return item.nextContent
			})
		} else {
			await app.vault.modify(item.file, item.nextContent)
		}
		options.readTracker?.markRead(item.file.path)
		changed.push(item.file.path)
	}
	if (changed.length === 0) {
		return normalized + ': frontmatter already up to date'
	}
	return (
		'Updated frontmatter in ' +
		changed.length +
		' file(s):\n' +
		changed.join('\n')
	)
}

export const vaultFrontmatterTool = tool({
	description: [
		'Read or batch-update YAML frontmatter on visible vault markdown files without shell loops.',
		'Use this instead of bash grep/sed/awk loops for title, tags, see-also, source, canonical, review-due, and similar fields.',
		'action "read" returns JSON rows. action "update" applies set/deleteKeys to the selected files in one tool call.',
		'Input path is a vault virtual path; optional glob filters file paths (for example *.md).',
	].join(' '),
	inputSchema: z.object({
		purpose: z.string(),
		action: z.union([z.literal('read'), z.literal('update')]),
		path: z.optional(z.string()),
		glob: z.optional(z.string()),
		keys: z.optional(z.array(z.string())),
		set: z.optional(z.record(z.string(), z.unknown())),
		deleteKeys: z.optional(z.array(z.string())),
		maxFiles: z.optional(z.number()),
	}),
	contextSchema: z.object({
		app: appDep,
		permissionGuard: permissionGuardDep,
		readTracker: readTrackerDep,
	}),
	outputSchema: z.string(),
	execute: async (
		{ action, path, glob, keys, set, deleteKeys, maxFiles, purpose },
		{ context },
	) =>
		executeVaultFrontmatter(context.app, {
			action,
			path,
			glob,
			keys,
			set,
			deleteKeys,
			maxFiles,
			purpose,
			permissionGuard: context.permissionGuard,
			readTracker: context.readTracker,
		}),
})
