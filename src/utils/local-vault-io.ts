import { normalizePath, Platform, TFile, Vault } from 'obsidian'
import { ensureParentDirectory } from './adapter-io'
import { atomicReplaceContent } from './atomic-replace'

/**
 * Reject explicit `..` path segments. Obsidian's `normalizePath` behaviour is
 * not guaranteed to resolve dot segments (and the test mock does not), so a
 * hidden-directory route such as `.agents/../../x` could otherwise escape the
 * vault root through the raw adapter. Callers must pass vault-relative paths.
 */
export function assertNoLocalPathTraversal(path: string) {
	if (path.split(/[\\/]+/).some((segment) => segment === '..')) {
		throw new Error(`Path traversal is not allowed: ${path}`)
	}
}

function isAdapterPathNormalized(vault: Vault, normalizedPath: string) {
	assertNoLocalPathTraversal(normalizedPath)
	const pathForCheck = normalizedPath.replace(/^\/+/, '').replace(/\/+$/, '')
	const configDir = normalizePath(vault.configDir)
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
	if (
		configDir &&
		(pathForCheck === configDir || pathForCheck.startsWith(`${configDir}/`))
	) {
		return true
	}
	return pathForCheck
		.split('/')
		.some(
			(segment) =>
				segment !== '.' && segment !== '..' && segment.startsWith('.'),
		)
}

export function isAdapterPath(vault: Vault, path: string) {
	assertNoLocalPathTraversal(path)
	return isAdapterPathNormalized(vault, normalizePath(path))
}

export async function existsLocalPath(vault: Vault, path: string) {
	assertNoLocalPathTraversal(path)
	const normalizedPath = normalizePath(path)
	return await vault.adapter.exists(normalizedPath)
}

export async function readLocalBinary(vault: Vault, path: string) {
	assertNoLocalPathTraversal(path)
	const normalizedPath = normalizePath(path)
	if (isAdapterPathNormalized(vault, normalizedPath)) {
		return await vault.adapter.readBinary(normalizedPath)
	}
	const file = vault.getAbstractFileByPath(normalizedPath)
	if (!file) {
		throw new Error('cannot find file in local fs: ' + normalizedPath)
	}
	if (!(file instanceof TFile)) {
		throw new Error('local path is not a file: ' + normalizedPath)
	}
	return await vault.readBinary(file)
}

export async function writeLocalBinary(
	vault: Vault,
	path: string,
	data: ArrayBuffer,
) {
	assertNoLocalPathTraversal(path)
	const normalizedPath = normalizePath(path)
	if (isAdapterPathNormalized(vault, normalizedPath)) {
		await ensureParentDirectory(vault.adapter, normalizedPath)
		await vault.adapter.writeBinary(normalizedPath, data)
		return
	}
	const file = vault.getAbstractFileByPath(normalizedPath)
	if (file instanceof TFile) {
		await vault.modifyBinary(file, data)
		return
	}
	if (await vault.adapter.exists(normalizedPath)) {
		await vault.adapter.writeBinary(normalizedPath, data)
		return
	}
	await vault.createBinary(normalizedPath, data)
}

export async function writeLocalText(vault: Vault, path: string, data: string) {
	assertNoLocalPathTraversal(path)
	const normalizedPath = normalizePath(path)
	if (isAdapterPathNormalized(vault, normalizedPath)) {
		await ensureParentDirectory(vault.adapter, normalizedPath)
		await vault.adapter.write(normalizedPath, data)
		return
	}
	const file = vault.getAbstractFileByPath(normalizedPath)
	if (file instanceof TFile) {
		await vault.modify(file, data)
		return
	}
	if (await vault.adapter.exists(normalizedPath)) {
		await vault.adapter.write(normalizedPath, data)
		return
	}
	await vault.create(normalizedPath, data)
}

export async function readLocalText(vault: Vault, path: string) {
	assertNoLocalPathTraversal(path)
	const normalizedPath = normalizePath(path)
	if (isAdapterPathNormalized(vault, normalizedPath)) {
		return await vault.adapter.read(normalizedPath)
	}
	const file = vault.getAbstractFileByPath(normalizedPath)
	if (!file) {
		throw new Error('cannot find file in local fs: ' + normalizedPath)
	}
	if (!(file instanceof TFile)) {
		throw new Error('local path is not a file: ' + normalizedPath)
	}
	return await vault.read(file)
}

/**
 * Atomic write for whole-file JSON payloads (e.g. chat sessions).
 *
 * Obsidian's DataAdapter.rename refuses to overwrite an existing destination
 * ("Destination file already exists!"), so a tmp-file + rename dance is NOT a
 * valid strategy here. Instead we rely on `adapter.write`, which on
 * FileSystemAdapter (desktop) is already atomic internally (writes a temp
 * sibling then renames over the target) and auto-creates parent folders.
 *
 * On mobile the adapter write is not guaranteed atomic, so hidden/adapter
 * paths go through `atomicReplaceContent` (write temp, then backup+rename).
 * Visible vault files fall through to the standard vault write path.
 */
export async function writeLocalTextAtomic(
	vault: Vault,
	path: string,
	data: string,
) {
	assertNoLocalPathTraversal(path)
	const normalizedPath = normalizePath(path)
	if (Platform.isMobileApp && isAdapterPathNormalized(vault, normalizedPath)) {
		await atomicReplaceContent(vault, normalizedPath, data, 'text')
		return
	}
	await writeLocalText(vault, normalizedPath, data)
}

export async function removeLocalPath(
	vault: Vault,
	path: string,
	recursive = false,
) {
	assertNoLocalPathTraversal(path)
	const normalizedPath = normalizePath(path)
	if (isAdapterPathNormalized(vault, normalizedPath)) {
		const stat = await vault.adapter.stat(normalizedPath)
		if (!stat) {
			return
		}
		if (stat.type === 'folder') {
			await vault.adapter.rmdir(normalizedPath, recursive)
			return
		}
		await vault.adapter.remove(normalizedPath)
		return
	}
	const file = vault.getAbstractFileByPath(normalizedPath)
	if (!file) {
		return
	}
	await vault.trash(file, false)
}
