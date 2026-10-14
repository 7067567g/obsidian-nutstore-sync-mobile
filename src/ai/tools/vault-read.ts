import { z } from 'zod/mini'
import { tool } from 'ai'
import { appDep, readTrackerDep } from './tool-context'
import {
	clampInt,
	getNodeSize,
	normalizeVaultVirtualPath,
	readVaultText,
	toVaultPath,
} from './vault-native'

const MAX_LINES = 2000
const MAX_FILE_BYTES = 5 * 1024 * 1024

const vaultReadInputSchema = z.object({
	path: z.string(),
	offset: z.optional(z.number()),
	limit: z.optional(z.number()),
})

export async function executeVaultRead(
	app: import('obsidian').App,
	virtualPath: string,
	offset = 1,
	limit = 400,
) {
	const normalized = normalizeVaultVirtualPath(virtualPath)
	const vaultPath = toVaultPath(normalized)
	const node = app.vault.getAbstractFileByPath(vaultPath)
	let fileSize = getNodeSize(node)
	if (fileSize === undefined && !node) {
		const stat = await app.vault.adapter.stat(vaultPath)
		fileSize = stat?.size
	}
	if (fileSize !== undefined && fileSize > MAX_FILE_BYTES) {
		throw new Error(
			'File is too large for mobile vault_read (' +
				fileSize +
				' bytes). Use bash/desktop MCP for large binary or minified files.',
		)
	}
	const text = await readVaultText(app, vaultPath)
	const lines = text.split('\n')
	const start = clampInt(offset, 1, 1, Number.MAX_SAFE_INTEGER) - 1
	const size = clampInt(limit, 400, 1, MAX_LINES)
	// Clamp a start beyond EOF so the reported range never inverts
	// (e.g. "lines 100-3 of 3" for an out-of-range offset).
	const from = Math.min(start, lines.length)
	const end = Math.min(lines.length, from + size)
	const selected = from >= lines.length ? [] : lines.slice(from, end)
	const numbered = selected.map(
		(line, index) => `${from + index + 1} | ${line}`,
	)
	const header =
		from >= lines.length
			? `${normalized} (no lines in range: file has ${lines.length} line(s))`
			: `${normalized} (lines ${from + 1}-${end} of ${lines.length})`
	return {
		header,
		text: numbered.join('\n'),
		vaultPath,
	}
}

export const vaultReadTool = tool({
	description: [
		'Read a text file from the Obsidian vault without creating a browser-bash filesystem.',
		'Use this instead of bash cat/head/tail for ordinary vault notes and hidden agent files addressed explicitly by path.',
		'Input path is a vault virtual path: "/" is the vault root. offset is 1-based line number.',
	].join(' '),
	inputSchema: vaultReadInputSchema,
	contextSchema: z.object({
		app: appDep,
		readTracker: readTrackerDep,
	}),
	outputSchema: z.string(),
	execute: async ({ path, offset, limit }, { context }) => {
		const result = await executeVaultRead(
			context.app,
			path,
			offset ?? 1,
			limit ?? 400,
		)
		context.readTracker?.markRead(result.vaultPath)
		return `${result.header}\n${result.text}`
	},
})
