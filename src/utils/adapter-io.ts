import { normalizePath, type DataAdapter } from 'obsidian'
import { dirname } from 'path-browserify'

async function directoryExists(adapter: DataAdapter, path: string) {
	try {
		const stat = await adapter.stat(path)
		return stat?.type === 'folder'
	} catch {
		return false
	}
}

/**
 * Ensure every parent segment of an adapter path exists. Mobile adapters do
 * not always create parent folders for write/append; hidden `.agents` paths
 * are the common failure case.
 */
export async function ensureParentDirectory(
	adapter: DataAdapter,
	path: string,
): Promise<void> {
	const normalized = normalizePath(path)
	const parent = dirname(normalized)
	if (!parent || parent === '.' || parent === '/') return
	const segments = parent.split('/').filter(Boolean)
	let current = ''
	for (const segment of segments) {
		current = current ? `${current}/${segment}` : segment
		if (await directoryExists(adapter, current)) continue
		try {
			await adapter.mkdir(current)
		} catch {
			// Another writer may have created it; re-check before giving up.
			if (!(await directoryExists(adapter, current)))
				throw new Error(`Unable to create directory: ${current}`)
		}
	}
}

export async function writeTextWithParents(
	adapter: DataAdapter,
	path: string,
	data: string,
) {
	const normalized = normalizePath(path)
	await ensureParentDirectory(adapter, normalized)
	await adapter.write(normalized, data)
}

export async function writeBinaryWithParents(
	adapter: DataAdapter,
	path: string,
	data: ArrayBuffer,
) {
	const normalized = normalizePath(path)
	await ensureParentDirectory(adapter, normalized)
	await adapter.writeBinary(normalized, data)
}

export async function appendTextWithParents(
	adapter: DataAdapter,
	path: string,
	data: string,
) {
	const normalized = normalizePath(path)
	await ensureParentDirectory(adapter, normalized)
	if (typeof adapter.append !== 'function') {
		throw new Error('adapter.append is unavailable on this platform')
	}
	await adapter.append(normalized, data)
}
