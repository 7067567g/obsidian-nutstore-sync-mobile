import type { App } from 'obsidian'
import {
	getNodeSize,
	isFolderNode,
	isHiddenVaultPath,
	isVaultFileNode,
} from './vault-native'

const MAX_FILE_BYTES = 2 * 1024 * 1024

export function wildcardToRegExp(glob: string) {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/\?/g, '.')
	return new RegExp('^' + escaped + '$')
}

export function replaceExact(text: string, find: string, replacement: string) {
	return text.split(find).join(replacement)
}

export function countExact(text: string, find: string) {
	if (!find) return 0
	return text.split(find).length - 1
}

export function selectFiles(
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
