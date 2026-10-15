import { sha256Hex } from '~/utils/sha256'
import { tool } from 'ai'
import type { App } from 'obsidian'
import { z } from 'zod/mini'
import { appDep } from './tool-context'
import {
	getNodeSize,
	isFileNode,
	normalizeVaultVirtualPath,
	readVaultBinary,
	toVaultPath,
} from './vault-native'

export const VAULT_HASH_MAX_PATHS = 200
export const VAULT_HASH_DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024
export const VAULT_HASH_HARD_MAX_FILE_BYTES = 128 * 1024 * 1024
const MIN_MAX_FILE_BYTES = 1024

export const vaultHashInputSchema = z.object({
	paths: z.array(z.string()),
	maxFileBytes: z.optional(z.number()),
})

export async function executeVaultHash(
	app: App,
	paths: string[],
	options: { maxFileBytes?: number } = {},
) {
	if (paths.length === 0) return 'No paths provided.'
	if (paths.length > VAULT_HASH_MAX_PATHS) {
		throw new Error(
			`Too many paths: ${paths.length} (max ${VAULT_HASH_MAX_PATHS}).`,
		)
	}
	const requested = Math.floor(
		options.maxFileBytes ?? VAULT_HASH_DEFAULT_MAX_FILE_BYTES,
	)
	const limit = Math.max(
		MIN_MAX_FILE_BYTES,
		Math.min(VAULT_HASH_HARD_MAX_FILE_BYTES, requested),
	)
	const output: string[] = []

	for (const inputPath of paths) {
		const normalized = normalizeVaultVirtualPath(inputPath)
		const vaultPath = toVaultPath(normalized)
		const node = app.vault.getAbstractFileByPath(vaultPath)
		if (!isFileNode(node)) {
			const adapterStat = await app.vault.adapter.stat(vaultPath)
			if (!adapterStat) {
				output.push(`${normalized}: not found`)
				continue
			}
			if (adapterStat.type !== 'file') {
				output.push(`${normalized}: not a file (use vault_stat for folders)`)
				continue
			}
		}
		const size = isFileNode(node)
			? (getNodeSize(node) ?? 0)
			: ((await app.vault.adapter.stat(vaultPath))?.size ?? 0)
		if (size > limit) {
			output.push(
				`${normalized}: skipped, ${size} bytes exceeds maxFileBytes=${limit}`,
			)
			continue
		}
		const bytes = await readVaultBinary(app, vaultPath)
		if (bytes.byteLength > limit) {
			output.push(
				`${normalized}: skipped, ${bytes.byteLength} bytes exceeds maxFileBytes=${limit}`,
			)
			continue
		}
		output.push(
			`sha256  ${await sha256Hex(bytes)}  ${normalized} (${bytes.byteLength} B)`,
		)
	}

	return output.join('\n')
}

export const vaultHashTool = tool({
	description: [
		'Compute the SHA-256 hash of files inside the Obsidian vault.',
		'Use this instead of bash sha256sum for package archives or other large files; it avoids loading the whole sandbox and re-serializing large reversible operations.',
		'Input paths are vault virtual paths. Folders are rejected: use vault_stat for folder metadata.',
		'Large files are skipped above maxFileBytes (default 64 MiB, hard limit 128 MiB). For thousands of files, prefer a desktop/remote shell instead of hashing through the phone WebView.',
	].join(' '),
	inputSchema: vaultHashInputSchema,
	contextSchema: z.object({ app: appDep }),
	outputSchema: z.string(),
	execute: async ({ paths, maxFileBytes }, { context }) =>
		executeVaultHash(context.app, paths, { maxFileBytes }),
})
