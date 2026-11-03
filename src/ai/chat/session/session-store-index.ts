import type { ChatSession } from '~/ai/chat/domain'
import { ChatSessionIndexItem } from '~/ai/chat/domain'
import type { ChatMetaRecord } from '~/storage'
import { SessionFileCorruptError, type ChatMetaFile } from './session-files'
import {
	decodeChatSessionFromStorage,
	encodeChatSessionForStorage,
	type PersistedChatSession,
} from './session-persistence'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import { SessionStoreWritesBase } from './session-store-writes'

interface LegacyMigrationResult {
	meta: ChatMetaRecord | null
	index: ChatSessionIndexItem[]
	migrated: boolean
}

export class SessionStoreIndexBase extends SessionStoreWritesBase {
	async loadSessionIndex() {
		const legacyMigration = await this.ensureMigratedFromLegacy()
		const diskIds = new Set(await this.backend.listSessionIds())
		const meta = await this.backend.readMetaFile()
		const cachedIndex = legacyMigration?.migrated
			? null
			: buildSessionIndexFromMeta(meta, diskIds)
		if (cachedIndex) {
			this.state.sessionIndex = cachedIndex
			this.state.activeSessionId =
				meta?.activeSessionId && diskIds.has(meta.activeSessionId)
					? meta.activeSessionId
					: cachedIndex[0]?.id
			return
		}
		await this.reconcileSessionIndex(legacyMigration, { diskIds, meta })
	}

	/** Incrementally migrates IndexedDB sessions missing from vault storage. */
	private async ensureMigratedFromLegacy(): Promise<LegacyMigrationResult | null> {
		let keys: string[]
		try {
			keys = await this.legacy.listSessionKeys()
		} catch {
			return null
		}
		if (keys.length === 0) {
			return null
		}
		let meta = {
			meta: null as ChatMetaRecord | null,
			index: [] as ChatSessionIndexItem[],
		}
		try {
			meta = await this.legacy.getMeta()
		} catch {
			/* keep defaults */
		}
		const diskIds = new Set(await this.backend.listSessionIds())
		let migrated = false
		for (const key of keys) {
			if (diskIds.has(key)) {
				continue
			}
			let stored: unknown
			try {
				stored = await this.legacy.getSession(key)
			} catch {
				stored = undefined
			}
			if (!stored || typeof stored !== 'object') {
				continue
			}
			try {
				const decoded = decodeChatSessionFromStorage(
					stored as PersistedChatSession,
				)
				const { session } = this.rehydrateSession(decoded)
				const snapshot = await encodeChatSessionForStorage(session)
				const item = meta.index.find((entry) => entry.id === key)
				await this.backend.writeSessionFile(key, {
					session: snapshot,
					title: item?.title,
				})
				migrated = true
			} catch (error) {
				logger.warn(`Failed to migrate chat session ${key}, skipping it`, error)
			}
		}
		return { ...meta, migrated }
	}

	protected async reconcileSessionIndex(
		legacyMigration: LegacyMigrationResult | null,
		known?: {
			diskIds: Set<string>
			meta: ChatMetaFile | null
		},
	) {
		const diskIds =
			known?.diskIds ?? new Set(await this.backend.listSessionIds())
		const meta = known?.meta ?? (await this.backend.readMetaFile())
		const validItems = new Map<string, ChatSessionIndexItem>()
		for (const id of diskIds) {
			try {
				const payload = await this.backend.readSessionFile(id, {
					hydrateOperations: false,
				})
				const stored = decodeChatSessionFromStorage(payload.session)
				const { session } = this.rehydrateSession(stored)
				const cached = meta?.sessions?.[id]
				validItems.set(id, {
					id,
					title: payload.title || cached?.title || i18n.t('chatbox.newChat'),
					createdAt: cached?.createdAt ?? numberOrZero(session.createdAt),
					updatedAt: cached?.updatedAt ?? numberOrZero(session.updatedAt),
				})
			} catch (error) {
				// N3: a transient read failure (file still on disk, not corrupt)
				// must not trim the session from the index. Keep the previously
				// known item (from meta or the in-memory index) so a WebDAV/sync
				// hiccup cannot make the conversation list lose an entry.
				const fallback =
					this.state.sessionIndex.find((item) => item.id === id) ??
					(meta?.sessions?.[id] ? { id, ...meta.sessions[id] } : undefined)
				if (!(error instanceof SessionFileCorruptError) && fallback) {
					let stillOnDisk = false
					try {
						stillOnDisk = await this.backend.hasSessionFile(id)
					} catch {
						/* treat an existence probe failure as "not present" */
					}
					if (stillOnDisk) {
						validItems.set(id, fallback)
						continue
					}
				}
				/* skip genuinely corrupt or missing session files */
			}
		}

		const legacyOrder =
			legacyMigration?.meta?.orderedSessionIds ??
			legacyMigration?.index.map((item) => item.id) ??
			[]
		const preferredOrders =
			legacyMigration?.migrated || !meta
				? [legacyOrder, meta?.orderedSessionIds ?? []]
				: [meta.orderedSessionIds, legacyOrder]
		const items: ChatSessionIndexItem[] = []
		const indexedIds = new Set<string>()
		for (const id of [...preferredOrders.flat(), ...diskIds]) {
			const item = validItems.get(id)
			if (!item || indexedIds.has(id)) {
				continue
			}
			items.push(item)
			indexedIds.add(id)
		}

		this.state.sessionIndex = items
		const preferredActive =
			legacyMigration?.migrated || !meta
				? [legacyMigration?.meta?.activeSessionId, meta?.activeSessionId]
				: [meta.activeSessionId, legacyMigration?.meta?.activeSessionId]
		this.state.activeSessionId =
			preferredActive.find((id): id is string => !!id && validItems.has(id)) ??
			items[0]?.id
		await this.persistMetaAndIndex()
	}

	async persistMetaAndIndex() {
		const sessions: ChatMetaFile['sessions'] = {}
		for (const item of this.state.sessionIndex) {
			sessions[item.id] = {
				title: item.title,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
			}
		}
		const meta: ChatMetaFile = {
			activeSessionId: this.state.activeSessionId,
			orderedSessionIds: this.state.sessionIndex.map((item) => item.id),
			sessions,
		}
		await this.backend.writeMetaFile(meta)
	}

	upsertSessionIndexItem(
		session: ChatSession,
		title?: string,
		prepend = false,
	) {
		if (this.state.deletedSessionIds.has(session.id)) {
			return
		}
		const existingTitle =
			this.state.sessionIndex.find((e) => e.id === session.id)?.title ??
			i18n.t('chatbox.newChat')
		const item: ChatSessionIndexItem = {
			id: session.id,
			title: title ?? existingTitle,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
		}
		const existingIndex = this.state.sessionIndex.findIndex(
			(entry) => entry.id === session.id,
		)
		if (existingIndex === -1) {
			this.state.sessionIndex = prepend
				? [item, ...this.state.sessionIndex]
				: [...this.state.sessionIndex, item]
			return
		}

		const nextIndex = this.state.sessionIndex.slice()
		nextIndex[existingIndex] = item
		if (prepend && existingIndex > 0) {
			nextIndex.splice(existingIndex, 1)
			nextIndex.unshift(item)
		}
		this.state.sessionIndex = nextIndex
	}
}

function numberOrZero(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function buildSessionIndexFromMeta(
	meta: ChatMetaFile | null,
	diskIds: Set<string>,
): ChatSessionIndexItem[] | null {
	if (!meta || meta.orderedSessionIds.length !== diskIds.size) return null

	const indexedIds = new Set<string>()
	const items: ChatSessionIndexItem[] = []
	for (const id of meta.orderedSessionIds) {
		const info = meta.sessions[id]
		if (
			!diskIds.has(id) ||
			indexedIds.has(id) ||
			!info ||
			typeof info.title !== 'string' ||
			!Number.isFinite(info.createdAt) ||
			!Number.isFinite(info.updatedAt)
		) {
			return null
		}
		indexedIds.add(id)
		items.push({ id, ...info })
	}

	return Object.keys(meta.sessions).length === diskIds.size ? items : null
}
