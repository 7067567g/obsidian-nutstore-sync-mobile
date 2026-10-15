import { posix as pathPosix } from 'path-browserify'
import type {
	BufferEncoding,
	CpOptions,
	FileContent,
	IFileSystem,
	MkdirOptions,
	RmOptions,
} from 'just-bash/browser'
import type {
	ReversibleDirSnapshot,
	ReversibleFileSnapshot,
} from '~/ai/chat/types'
import {
	createCompressedFileContent,
	createSkippedFileSnapshot,
} from '~/ai/chat/messages/reversible-content'
import type { ReversibleOpRecorder } from './fs'

type Snapshot = ReversibleFileSnapshot | ReversibleDirSnapshot
type ReadOptions = Parameters<IFileSystem['readFile']>[1]
type WriteOptions = Parameters<IFileSystem['writeFile']>[2]

/**
 * Mobile-safe snapshot budgets. Reversible snapshots run on the single JS
 * thread, so a huge file or directory must not trigger unbounded synchronous
 * deflate work. Contents above the byte/entry budget are recorded as skipped
 * ({ path, size, reason }) instead; undo/diff for those operations is
 * unavailable, but the UI stays responsive.
 */
export const MAX_REVERSIBLE_SNAPSHOT_BYTES = 1024 * 1024
export const MAX_REVERSIBLE_SNAPSHOT_ENTRIES = 512

interface SnapshotBudget {
	remainingBytes: number
	remainingEntries: number
}

function createSnapshotBudget(): SnapshotBudget {
	return {
		remainingBytes: MAX_REVERSIBLE_SNAPSHOT_BYTES,
		remainingEntries: MAX_REVERSIBLE_SNAPSHOT_ENTRIES,
	}
}

export interface ReversibleFsOptions {
	/**
	 * Virtual mount points whose paths must remain absolute in persisted
	 * reversible operations. All other paths are files in the Vault root and
	 * are recorded as Vault-relative paths.
	 */
	absoluteMountPoints?: readonly string[]
}

function normalizePath(path: string) {
	return pathPosix.normalize(pathPosix.resolve('/', path))
}

function joinPath(parent: string, child: string) {
	return parent === '/' ? `/${child}` : `${parent}/${child}`
}

export class ReversibleFs implements IFileSystem {
	private depth = 0

	constructor(
		private readonly inner: IFileSystem,
		private readonly recorder: ReversibleOpRecorder,
		private readonly options: ReversibleFsOptions = {},
	) {}

	private toRecordedPath(path: string) {
		const normalized = normalizePath(path)
		if (!this.options.absoluteMountPoints) return normalized
		if (
			normalized === '/' ||
			this.options.absoluteMountPoints?.some(
				(mountPoint) =>
					normalized === mountPoint || normalized.startsWith(`${mountPoint}/`),
			)
		) {
			return normalized
		}
		return normalized.slice(1)
	}

	private async snapshot(
		path: string,
		result = new Map<string, Snapshot>(),
		budget = createSnapshotBudget(),
	) {
		const normalized = normalizePath(path)
		if (!(await this.inner.exists(normalized))) return result
		const stat = await this.inner.stat(normalized)
		if (stat.isDirectory) {
			const directory: ReversibleDirSnapshot = { kind: 'dir' }
			result.set(normalized, directory)
			if (budget.remainingEntries <= 0) {
				directory.skipped = { entries: 0, reason: 'entry-budget' }
				return result
			}
			budget.remainingEntries -= 1
			const children = await this.inner.readdir(normalized)
			let visited = 0
			for (const child of children) {
				if (budget.remainingEntries <= 0) {
					directory.skipped = {
						entries: children.length - visited,
						reason: 'entry-budget',
					}
					break
				}
				await this.snapshot(joinPath(normalized, child), result, budget)
				visited += 1
			}
			return result
		}

		if (budget.remainingEntries <= 0) {
			result.set(normalized, createSkippedFileSnapshot(stat.size, 'entries'))
			return result
		}
		budget.remainingEntries -= 1
		if (
			stat.size > MAX_REVERSIBLE_SNAPSHOT_BYTES ||
			stat.size > budget.remainingBytes
		) {
			result.set(
				normalized,
				createSkippedFileSnapshot(
					stat.size,
					stat.size > MAX_REVERSIBLE_SNAPSHOT_BYTES ? 'too-large' : 'budget',
				),
			)
			return result
		}
		const bytes = await this.inner.readFileBuffer(normalized)
		budget.remainingBytes -= bytes.byteLength
		result.set(normalized, {
			kind: 'file',
			contentCompressed: createCompressedFileContent(bytes),
		})
		return result
	}

	private async mutate<T>(paths: string[], action: () => Promise<T>) {
		if (this.depth > 0) return action()
		this.depth++
		try {
			const before = new Map<string, Snapshot>()
			const beforeBudget = createSnapshotBudget()
			this.recorder.beginCapture()
			try {
				for (const path of paths)
					await this.snapshot(path, before, beforeBudget)
			} finally {
				this.recorder.endCapture()
			}
			let result: T | undefined
			let failure: unknown
			let failed = false
			try {
				result = await action()
			} catch (error) {
				failed = true
				failure = error
			}
			const after = new Map<string, Snapshot>()
			const afterBudget = createSnapshotBudget()
			this.recorder.beginCapture()
			try {
				for (const path of paths) await this.snapshot(path, after, afterBudget)
			} finally {
				this.recorder.endCapture()
			}
			for (const path of new Set([...before.keys(), ...after.keys()])) {
				this.recorder.recordVirtualTransition(
					this.toRecordedPath(path),
					before.get(path),
					after.get(path),
				)
			}
			if (failed) throw failure
			return result as T
		} finally {
			this.depth--
		}
	}

	private async writePaths(path: string) {
		const paths = [normalizePath(path)]
		let parent = pathPosix.dirname(paths[0])
		while (parent !== '/' && !(await this.inner.exists(parent))) {
			paths.push(parent)
			parent = pathPosix.dirname(parent)
		}
		return paths
	}

	readFile(path: string, options?: ReadOptions | BufferEncoding) {
		return this.inner.readFile(path, options)
	}

	readFileBuffer(path: string) {
		return this.inner.readFileBuffer(path)
	}

	async writeFile(
		path: string,
		content: FileContent,
		options?: WriteOptions | BufferEncoding,
	) {
		return this.mutate(await this.writePaths(path), () =>
			this.inner.writeFile(path, content, options),
		)
	}

	async appendFile(
		path: string,
		content: FileContent,
		options?: WriteOptions | BufferEncoding,
	) {
		return this.mutate(await this.writePaths(path), () =>
			this.inner.appendFile(path, content, options),
		)
	}

	exists(path: string) {
		return this.inner.exists(path)
	}
	stat(path: string) {
		return this.inner.stat(path)
	}
	lstat(path: string) {
		return this.inner.lstat?.(path) ?? this.inner.stat(path)
	}

	async mkdir(path: string, options?: MkdirOptions) {
		return this.mutate(await this.writePaths(path), () =>
			this.inner.mkdir(path, options),
		)
	}

	readdir(path: string) {
		return this.inner.readdir(path)
	}

	rm(path: string, options?: RmOptions) {
		return this.mutate([path], () => this.inner.rm(path, options))
	}

	async cp(src: string, dest: string, options?: CpOptions) {
		return this.mutate(await this.writePaths(dest), () =>
			this.inner.cp(src, dest, options),
		)
	}

	async mv(src: string, dest: string) {
		return this.mutate([src, ...(await this.writePaths(dest))], () =>
			this.inner.mv(src, dest),
		)
	}

	resolvePath(base: string, path: string) {
		return this.inner.resolvePath(base, path)
	}
	getAllPaths() {
		return this.inner.getAllPaths()
	}
	chmod(path: string, mode: number) {
		return this.inner.chmod(path, mode)
	}
	symlink(target: string, linkPath: string) {
		return this.mutate([linkPath], () => this.inner.symlink(target, linkPath))
	}
	link(existingPath: string, newPath: string) {
		return this.mutate([newPath], () => this.inner.link(existingPath, newPath))
	}
	readlink(path: string) {
		return this.inner.readlink(path)
	}
	realpath(path: string) {
		return this.inner.realpath(path)
	}
	utimes(path: string, atime: Date, mtime: Date) {
		return this.inner.utimes(path, atime, mtime)
	}
}
