import { dirname, normalize } from 'path-browserify'
import { DeltaEntry, getDelta } from '~/api/delta'
import { getLatestDeltaCursor } from '~/api/latest-delta-cursor'
import { getDirectoryContents } from '~/api/webdav'
import { StatModel } from '~/model/stat.model'
import type { NutstoreSettings } from '~/settings'
import { apiLimiter } from './api-limiter'
import { fileStatToStatModel } from './file-stat-to-stat-model'
import { getRootFolderName } from './get-root-folder-name'
import logger from './logger'
import { stdRemotePath } from './std-remote-path'
import { executeWithRetry, getTraversalLock } from './traverse-webdav-retry'
import {
	clearTraversalState,
	isTraversalStateValid,
	loadTraversalState,
	saveTraversalState,
} from './traverse-webdav-state'
import { MaybePromise } from './types'

const getContents = apiLimiter.wrap(getDirectoryContents)

/**
 * WS-5 / H9 (K20 negative-result freshness bound): an empty directory listing
 * is a negative result. It may be served from cache, but only within this
 * explicit upper bound; afterwards the directory is re-listed. Non-empty
 * listings are kept authoritative (the delta stream maintains them).
 */
const DEFAULT_EMPTY_DIR_REVALIDATE_MS = 5 * 60_000

export interface WebDAVTraversalProgress {
	phase: 'scanning' | 'incremental' | 'retrying' | 'complete'
	currentPath?: string
	processedDirectories: number
	queuedDirectories: number
	discoveredItems: number
	processedChanges: number
}

export class ResumableWebDAVTraversal {
	private token: string
	private remoteBaseDir: string
	private kvKey: string
	private saveInterval: number
	private settings: NutstoreSettings
	private onProgress?: (progress: WebDAVTraversalProgress) => void
	private throwIfCancelled?: () => void

	private rootCursor: string = ''
	private queue: string[] = []
	private nodes: Record<string, StatModel[]> = {}
	/**
	 * Directories whose listing we fetched (or refreshed) in this process.
	 * `nodes[dir]` keys alone cannot distinguish "listed and truly empty" from
	 * "exists but never listed" — the H9 bug fabricated `[]` for delta-created
	 * directories. This in-memory set (K19/K20) is the sentinel that makes an
	 * empty node trustworthy only after a real listing, and only while fresh.
	 */
	private readonly listedDirs = new Map<string, number>()
	private emptyDirRevalidateMs = DEFAULT_EMPTY_DIR_REVALIDATE_MS
	private processedCount: number = 0
	private discoveredCount: number = 0
	private processedChanges: number = 0

	/**
	 * Normalize directory path for use as nodes key
	 */
	private normalizeDirPath(path: string): string {
		return stdRemotePath(path)
	}

	/**
	 * Normalize file/directory path for comparison
	 * Uses normalize to handle //, ./, etc, then removes trailing slash for consistent comparison
	 */
	private normalizeForComparison(path: string): string {
		let normalized = normalize(path)
		if (normalized.endsWith('/') && normalized.length > 1) {
			normalized = normalized.slice(0, -1)
		}
		return normalized
	}

	constructor(options: {
		settings: NutstoreSettings
		token: string
		remoteBaseDir: string
		kvKey: string
		saveInterval?: number
		onProgress?: (progress: WebDAVTraversalProgress) => void
		throwIfCancelled?: () => void
	}) {
		this.settings = options.settings
		this.token = options.token
		this.remoteBaseDir = options.remoteBaseDir
		this.kvKey = options.kvKey
		this.saveInterval = Math.max(options.saveInterval || 1, 1)
		this.onProgress = options.onProgress
		this.throwIfCancelled = options.throwIfCancelled
	}

	private emitProgress(
		phase: WebDAVTraversalProgress['phase'],
		currentPath?: string,
	): void {
		this.onProgress?.({
			phase,
			currentPath,
			processedDirectories: this.processedCount,
			queuedDirectories: this.queue.length,
			discoveredItems: this.discoveredCount,
			processedChanges: this.processedChanges,
		})
	}

	private checkCancelled(): void {
		this.throwIfCancelled?.()
	}

	private executeWithRetry<T>(
		func: () => MaybePromise<T>,
		currentPath?: string,
	): Promise<T> {
		return executeWithRetry(func, {
			throwIfCancelled: this.throwIfCancelled,
			onRetry: () => this.emitProgress('retrying', currentPath),
		})
	}

	get lock() {
		return getTraversalLock(this.kvKey)
	}

	get cursor(): string {
		return this.rootCursor
	}

	/**
	 * H9 / K19+K20: only a real listing may satisfy the BFS cache short-circuit.
	 * An empty node is usable only if this process listed it and the negative
	 * result is still inside the freshness bound.
	 */
	private isCachedListingUsable(dirPath: string, items: StatModel[]): boolean {
		if (items.length > 0) return true
		const listedAt = this.listedDirs.get(dirPath)
		if (listedAt === undefined) return false
		return Date.now() - listedAt < this.emptyDirRevalidateMs
	}

	private markDirectoryListed(dirPath: string) {
		this.listedDirs.delete(dirPath)
		this.listedDirs.set(dirPath, Date.now())
	}

	/**
	 * H9: a newly observed directory must be listed before its (empty) node is
	 * trusted. Queue it once so the next BFS pass fetches its real contents.
	 */
	private enqueueDirectoryForListing(path: string): void {
		const normalized = this.normalizeDirPath(path)
		if (normalized === this.normalizeDirPath(this.remoteBaseDir)) return
		const alreadyQueued = this.queue.some(
			(queued) => this.normalizeDirPath(queued) === normalized,
		)
		if (!alreadyQueued) this.queue.push(path)
	}

	private resetDirectoryListings() {
		this.listedDirs.clear()
	}

	async traverse(): Promise<StatModel[]> {
		return await this.lock.runExclusive(async () => {
			this.checkCancelled()
			await this.loadState()

			// Use incremental scan if already traversed once
			const isIncrementalScan =
				this.queue.length === 0 && Object.keys(this.nodes).length > 0

			if (isIncrementalScan) {
				await this.incrementalScan()
			} else {
				// Initial scan or resume: BFS traversal
				if (this.queue.length === 0) {
					const { response } = await this.executeWithRetry(() =>
						getLatestDeltaCursor({
							token: this.token,
							settings: this.settings,
							folderName: getRootFolderName(this.remoteBaseDir),
						}),
					)
					this.rootCursor = response.cursor
					this.queue = [this.remoteBaseDir]
				}

				await this.bfsTraverse()
			}

			await this.saveState()
			this.emitProgress('complete')

			return this.getAllFromCache()
		})
	}

	/**
	 * BFS traversal (initial scan or resume)
	 */
	private async bfsTraverse(): Promise<StatModel[]> {
		// Outer loop to handle reset scenarios without recursion
		while (true) {
			const traverseStartCursor = this.rootCursor
			const results: StatModel[] = []

			while (this.queue.length > 0) {
				this.checkCancelled()
				const currentPath = this.queue[0]
				this.emitProgress('scanning', currentPath)
				const normalizedPath = this.normalizeDirPath(currentPath)
				const resultItems: StatModel[] = []

				try {
					const cachedItems = this.nodes[normalizedPath]

					if (
						cachedItems &&
						this.isCachedListingUsable(normalizedPath, cachedItems)
					) {
						resultItems.push(...cachedItems)
					} else {
						const contents = await this.executeWithRetry(
							() => getContents(this.settings, this.token, currentPath),
							currentPath,
						)

						for (const item of contents) {
							const stat = fileStatToStatModel(item)
							resultItems.push(stat)
						}
						this.discoveredCount += resultItems.length
						// Only a fetched listing makes `nodes[dir]` authoritative,
						// including the empty (negative) case.
						this.markDirectoryListed(normalizedPath)
					}

					results.push(...resultItems)

					for (const item of resultItems) {
						if (item.isDir) {
							this.queue.push(item.path)
						}
					}

					this.nodes[normalizedPath] = resultItems

					this.queue.shift()
					this.processedCount++
					this.emitProgress('scanning', currentPath)

					if (this.processedCount % this.saveInterval === 0) {
						await this.saveState()
					}
				} catch (err) {
					logger.error(`Error processing ${currentPath}`, err)
					await this.saveState()
					throw err
				}
			}

			const { response: endResponse } = await this.executeWithRetry(() =>
				getLatestDeltaCursor({
					token: this.token,
					settings: this.settings,
					folderName: getRootFolderName(this.remoteBaseDir),
				}),
			)
			const traverseEndCursor = endResponse.cursor

			if (traverseStartCursor && traverseStartCursor !== traverseEndCursor) {
				logger.info('Changes detected during traversal, applying delta')
				const newCursor =
					await this.applyDeltaDuringTraversal(traverseStartCursor)
				this.rootCursor = newCursor

				// If reset occurred, queue is non-empty, need to re-traverse
				if (this.queue.length > 0) {
					logger.info(
						'Reset detected during delta apply, performing full re-scan',
					)
					continue
				}

				return this.getAllFromCache()
			}

			this.rootCursor = traverseEndCursor

			return results
		}
	}

	/**
	 * Fetch all delta changes by paginating through hasMore
	 * Yields batches of delta entries as they are fetched
	 */
	private async *fetchAllDelta(startCursor: string): AsyncGenerator<{
		entries: DeltaEntry[]
		cursor: string
		reset: boolean
		hasMore: boolean
	}> {
		let currentCursor = startCursor

		while (true) {
			const { response } = await this.executeWithRetry(() =>
				getDelta({
					token: this.token,
					settings: this.settings,
					folderName: getRootFolderName(this.remoteBaseDir),
					cursor: currentCursor,
				}),
			)

			if (response.reset) {
				yield {
					entries: [],
					cursor: response.cursor,
					reset: true,
					hasMore: false,
				}
				return
			}

			currentCursor = response.cursor

			yield {
				entries: response.delta.entry,
				cursor: currentCursor,
				reset: false,
				hasMore: response.hasMore,
			}

			if (!response.hasMore) {
				break
			}
		}
	}

	/**
	 * Apply changes during traversal without re-scanning
	 * Returns the new cursor. If reset occurred, clears cache and sets queue for re-scan.
	 */
	private async applyDeltaDuringTraversal(
		startCursor: string,
	): Promise<string> {
		let finalCursor = startCursor
		let processedEntries = 0

		for await (const { entries, cursor, reset } of this.fetchAllDelta(
			startCursor,
		)) {
			this.checkCancelled()
			if (reset) {
				logger.warn(
					'Delta reset during traversal, clearing cache and will trigger full re-scan',
				)
				this.nodes = {}
				this.queue = [this.remoteBaseDir]
				this.processedCount = 0
				this.resetDirectoryListings()
				const { response: cursorResponse } = await this.executeWithRetry(() =>
					getLatestDeltaCursor({
						token: this.token,
						settings: this.settings,
						folderName: getRootFolderName(this.remoteBaseDir),
					}),
				)
				return cursorResponse.cursor
			}

			if (entries.length > 0) {
				processedEntries += this.applyDeltaEntries(entries)

				// Save state periodically based on number of processed entries
				if (processedEntries >= this.saveInterval) {
					await this.saveState()
					processedEntries = 0
				}
			}

			finalCursor = cursor
		}

		await this.saveState()

		return finalCursor
	}

	/**
	 * Incremental scan using fetchAllDelta
	 */
	private async incrementalScan(): Promise<StatModel[]> {
		let hasAnyEntries = false
		let processedEntries = 0

		for await (const deltas of this.fetchAllDelta(this.rootCursor)) {
			this.checkCancelled()
			const { entries, cursor, reset } = deltas

			this.rootCursor = cursor

			if (reset) {
				logger.info('Delta reset, performing full scan')
				this.queue = [this.remoteBaseDir]
				this.nodes = {}
				this.processedCount = 0
				this.resetDirectoryListings()
				return await this.bfsTraverse()
			}

			if (entries.length > 0) {
				hasAnyEntries = true
				processedEntries += this.applyDeltaEntries(entries)

				// Save state periodically based on number of processed entries
				if (processedEntries >= this.saveInterval) {
					await this.saveState()
					processedEntries = 0
				}
			} else {
				this.emitProgress('incremental')
			}
		}

		await this.saveState()

		if (!hasAnyEntries) {
			logger.info('No changes detected, returning from cache')
		}

		return this.getAllFromCache()
	}

	/**
	 * Apply delta changes to nodes
	 */
	private applyDeltaToNodes(entries: Array<DeltaEntry>): void {
		// Prepare baseDir prefix for filtering
		const baseDirPrefix = this.remoteBaseDir.endsWith('/')
			? this.remoteBaseDir
			: this.remoteBaseDir + '/'

		// Sort by path length to process parents first
		const sortedEntries = [...entries].sort(
			(a, b) => a.path.length - b.path.length,
		)

		for (const entry of sortedEntries) {
			// Filter out changes that don't belong to remoteBaseDir scope
			const normalizedBaseDir = this.normalizeDirPath(this.remoteBaseDir)
			const normalizedEntryPath = this.normalizeDirPath(entry.path)
			const isSelf = normalizedEntryPath === normalizedBaseDir
			const isChild = entry.path.startsWith(baseDirPrefix)

			if (!isSelf && !isChild) {
				continue
			}
			if (entry.isDir) {
				if (entry.isDeleted) {
					const parentPath = dirname(entry.path)
					if (parentPath) {
						const normalizedParentPath = this.normalizeDirPath(parentPath)
						const parentItems = this.nodes[normalizedParentPath]
						if (parentItems) {
							const normalizedEntryPathForCmp = this.normalizeForComparison(
								entry.path,
							)
							this.nodes[normalizedParentPath] = parentItems.filter(
								(item) =>
									this.normalizeForComparison(item.path) !==
									normalizedEntryPathForCmp,
							)
						}
					}

					for (const nodePath in this.nodes) {
						if (
							nodePath === normalizedEntryPath ||
							nodePath.startsWith(normalizedEntryPath)
						) {
							delete this.nodes[nodePath]
							this.listedDirs.delete(nodePath)
						}
					}
				} else {
					const parentPath = dirname(entry.path)

					// Only update parent's children list if parent already exists
					// (Avoid creating incomplete parent records)
					if (parentPath) {
						const normalizedParentPath = this.normalizeDirPath(parentPath)
						const parentItems = this.nodes[normalizedParentPath]

						if (parentItems) {
							const dirStat: StatModel = {
								path: entry.path,
								basename: entry.path.split('/').pop() || '',
								isDir: true,
								isDeleted: false,
								mtime: entry.modified
									? new Date(entry.modified).getTime()
									: undefined,
							}

							const normalizedEntryPathForCmp = this.normalizeForComparison(
								entry.path,
							)
							this.nodes[normalizedParentPath] = [
								...parentItems.filter(
									(item) =>
										this.normalizeForComparison(item.path) !==
										normalizedEntryPathForCmp,
								),
								dirStat,
							]
						}
					}

					// H9 / K19: a delta entry proves the directory exists but not
					// what it contains. Do NOT fabricate `nodes[dir] = []`; that
					// empty array would make BFS treat the directory as already
					// listed and permanently hide its existing children. Queue a
					// real listing instead.
					const knownListing = this.nodes[normalizedEntryPath]
					if (
						!this.listedDirs.has(normalizedEntryPath) &&
						(knownListing === undefined || knownListing.length === 0)
					) {
						this.enqueueDirectoryForListing(entry.path)
					}
				}
			} else {
				// is file
				const parentPath = dirname(entry.path)

				// Only update parent's children list if parent exists
				if (parentPath) {
					const normalizedParentPath = this.normalizeDirPath(parentPath)
					if (entry.isDeleted) {
						const parentItems = this.nodes[normalizedParentPath]
						if (parentItems) {
							const normalizedEntryPathForCmp = this.normalizeForComparison(
								entry.path,
							)
							this.nodes[normalizedParentPath] = parentItems.filter(
								(item) =>
									this.normalizeForComparison(item.path) !==
									normalizedEntryPathForCmp,
							)
						}
					} else {
						// Only update if parent directory already exists in cache
						// (Avoid creating incomplete parent records that would hide other files)
						const parentItems = this.nodes[normalizedParentPath]

						if (parentItems) {
							const stat: StatModel = {
								path: entry.path,
								basename: entry.path.split('/').pop() || '',
								isDir: false,
								isDeleted: false,
								mtime: new Date(entry.modified).getTime(),
								size: entry.size,
							}

							const normalizedEntryPathForCmp = this.normalizeForComparison(
								entry.path,
							)
							this.nodes[normalizedParentPath] = [
								...parentItems.filter(
									(item) =>
										this.normalizeForComparison(item.path) !==
										normalizedEntryPathForCmp,
								),
								stat,
							]
						}
					}
				}
			}
		}
	}

	/**
	 * Get all results from cache
	 */
	private getAllFromCache(): StatModel[] {
		const results: StatModel[] = []
		for (const items of Object.values(this.nodes)) {
			results.push(...items)
		}
		return results
	}

	private countDiscoveredItems(): number {
		return Object.values(this.nodes).reduce(
			(total, items) => total + items.length,
			0,
		)
	}

	private applyDeltaEntries(entries: DeltaEntry[]): number {
		this.applyDeltaToNodes(entries)
		this.processedChanges += entries.length
		this.discoveredCount = this.countDiscoveredItems()
		this.emitProgress('incremental')
		return entries.length
	}

	/**
	 * Load state
	 */
	private async loadState(): Promise<void> {
		const state = await loadTraversalState(this.kvKey, this.remoteBaseDir)
		if (state.kind === 'empty') {
			return
		}
		if (state.kind === 'incompatible') {
			this.rootCursor = ''
			this.queue = []
			this.nodes = {}
			this.resetDirectoryListings()
			return
		}
		this.rootCursor = state.rootCursor
		this.queue = state.queue
		this.nodes = state.nodes
		// H9: freshness is process-local, a restored cache has no listed-dir
		// sentinel, so empty nodes are re-listed on the next BFS.
		this.resetDirectoryListings()
		this.processedCount = Object.keys(this.nodes).length
		this.discoveredCount = this.countDiscoveredItems()
	}

	/**
	 * Save current state
	 */
	private async saveState(): Promise<void> {
		await saveTraversalState(
			this.kvKey,
			this.rootCursor,
			this.queue,
			this.nodes,
		)
	}

	/**
	 * Clear cache (force re-traversal)
	 */
	async clearCache(): Promise<void> {
		await clearTraversalState(this.kvKey)
		this.rootCursor = ''
		this.queue = []
		this.nodes = {}
		this.resetDirectoryListings()
		this.processedCount = 0
		this.discoveredCount = 0
		this.processedChanges = 0
	}

	/**
	 * Check if cache is valid
	 */
	async isCacheValid(): Promise<boolean> {
		return await isTraversalStateValid(this.kvKey)
	}
}
