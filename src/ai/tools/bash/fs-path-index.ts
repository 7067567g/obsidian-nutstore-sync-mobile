import { posix as pathPosix } from 'path-browserify'

export function getPathDepth(path: string) {
	return path.split('/').filter(Boolean).length
}

function normalizeVirtualPath(inputPath: string) {
	const normalized = pathPosix.normalize(pathPosix.resolve('/', inputPath))
	return normalized === '' ? '/' : normalized
}

export function joinVirtualPath(parent: string, name: string) {
	return parent === '/' ? `/${name}` : `${parent}/${name}`
}

export function ensureNotEscapingRoot(inputPath: string) {
	const normalized = normalizeVirtualPath(inputPath)
	if (!normalized.startsWith('/')) {
		throw new Error(`EINVAL: invalid path '${inputPath}'`)
	}
	return normalized
}

export interface VaultPathIndex {
	getAllPaths(): string[]
	recordPath(path: string): void
	forgetPath(path: string): void
}

export class MutableVaultPathIndex implements VaultPathIndex {
	private readonly paths = new Set<string>(['/'])

	constructor(initialPaths: string[] = []) {
		for (const path of initialPaths) this.recordPath(path)
	}

	recordPath(inputPath: string) {
		const normalized = ensureNotEscapingRoot(inputPath)
		this.paths.add('/')
		let current = ''
		for (const part of normalized.split('/').filter(Boolean)) {
			current = `${current}/${part}`
			this.paths.add(current)
		}
	}

	forgetPath(inputPath: string) {
		const normalized = ensureNotEscapingRoot(inputPath)
		for (const path of [...this.paths]) {
			if (path === normalized || path.startsWith(`${normalized}/`)) {
				this.paths.delete(path)
			}
		}
		this.paths.add('/')
	}

	getAllPaths() {
		return [...this.paths].sort()
	}
}
