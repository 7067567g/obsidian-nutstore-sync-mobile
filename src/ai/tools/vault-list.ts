import { z } from 'zod/mini'
import { tool } from 'ai'
import { appDep } from './tool-context'
import {
	describeVaultEntries,
	entryFromNode,
	isFileNode,
	isFolderNode,
	normalizeVaultVirtualPath,
	toVaultPath,
	type VaultEntry,
} from './vault-native'

const MAX_ENTRIES = 800

const vaultListInputSchema = z.object({
	path: z.optional(z.string()),
	depth: z.optional(z.number()),
})

export async function executeVaultList(
	app: import('obsidian').App,
	virtualPath: string,
	depth: number,
) {
	const normalized = normalizeVaultVirtualPath(virtualPath)
	const vaultPath = toVaultPath(normalized)
	const entries: VaultEntry[] = []
	let truncated = false

	const pushEntry = (entry: VaultEntry) => {
		if (entries.length >= MAX_ENTRIES) {
			truncated = true
			return false
		}
		entries.push(entry)
		return true
	}

	const visitVisibleFolder = (folder: unknown, remainingDepth: number) => {
		if (!isFolderNode(folder)) return
		for (const child of folder.children) {
			const entry = entryFromNode(child, '')
			if (!entry) continue
			if (!pushEntry(entry)) return
			if (entry.isDirectory && remainingDepth > 0) {
				visitVisibleFolder(child, remainingDepth - 1)
				if (truncated) return
			}
		}
	}

	const node = vaultPath
		? app.vault.getAbstractFileByPath(vaultPath)
		: app.vault.getRoot()

	if (isFileNode(node)) {
		const entry = entryFromNode(node, vaultPath)
		if (entry) pushEntry(entry)
	} else if (isFolderNode(node)) {
		visitVisibleFolder(node, depth)
	} else {
		// Hidden directories are deliberately not part of Obsidian's loaded-file
		// index. They are still addressable explicitly, but only one level at a
		// time so a single listing cannot recursively walk .agents.
		if (!(await app.vault.adapter.exists(vaultPath))) {
			throw new Error(`Vault path not found: ${normalized}`)
		}
		const listed = await app.vault.adapter.list(vaultPath)
		for (const file of listed.files) {
			if (!pushEntry(entryFromNode(undefined, file)!)) break
		}
		if (!truncated) {
			for (const folder of listed.folders) {
				if (!pushEntry(entryFromNode(undefined, folder, true)!)) break
			}
		}
	}

	entries.sort((left, right) => {
		if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
		return left.path.localeCompare(right.path)
	})

	if (entries.length === 0) {
		return `${normalized}: empty`
	}
	const header = `${normalized} (${entries.length}${truncated ? '+' : ''} entries)`
	return `${header}\n${describeVaultEntries(entries, { basePath: vaultPath, truncated })}`
}

export const vaultListTool = tool({
	description: [
		'List files and folders in the Obsidian vault without creating a browser-bash filesystem.',
		'Use this instead of bash ls/ls -R for ordinary vault directories.',
		'Visible vault files come from Obsidian in-memory index. Hidden dot-directories such as .agents can be listed explicitly, but only one level at a time.',
		'Input path is a vault virtual path: "/" for the vault root.',
	].join(' '),
	inputSchema: vaultListInputSchema,
	contextSchema: z.object({ app: appDep }),
	outputSchema: z.string(),
	execute: async ({ path, depth }, { context }) =>
		executeVaultList(
			context.app,
			path ?? '/',
			Math.max(0, Math.min(3, Math.floor(depth ?? 0))),
		),
})
