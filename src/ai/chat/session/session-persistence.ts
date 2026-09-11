import type { ChatSession, LegacyChatSession } from '~/ai/chat/domain'

// V1 (IndexedDB era) kept binary payloads as ArrayBuffers, which IndexedDB
// stores natively but which cannot survive JSON.stringify (they degenerate into
// numeric-indexed objects). V2 encodes every binary payload as a base64url
// string so whole sessions can be persisted as plain JSON files. V1 marker
// records AND bare ArrayBuffer/ArrayBufferView values are still accepted on
// decode so legacy IndexedDB records can be decoded, migrated to the current
// session schema, and encoded directly as final JSON snapshots.
const BLOB_RECORD_MARKER_V1 = '__nutstore_chat_blob_v1'
const BLOB_RECORD_MARKER_V2 = '__nutstore_chat_blob_v2'
const URL_RECORD_MARKER = '__nutstore_chat_url_v1'
const BINARY_RECORD_MARKER_V2 = '__nutstore_chat_binary_v2'

interface PersistedBlobRecord {
	[BLOB_RECORD_MARKER_V2]: true
	type: string
	data: string
}

interface LegacyPersistedBlobRecord {
	[BLOB_RECORD_MARKER_V1]: true
	type: string
	data: ArrayBuffer
}

interface PersistedUrlRecord {
	[URL_RECORD_MARKER]: true
	href: string
}

/** Kinds emitted by current writes. Older V2 records may contain other views. */
type PersistedBinaryKind = 'arraybuffer' | 'Uint8Array'

interface PersistedBinaryRecord {
	[BINARY_RECORD_MARKER_V2]: true
	kind: string
	data: string
}

type WritablePersistedBinaryRecord = Omit<PersistedBinaryRecord, 'kind'> & {
	kind: PersistedBinaryKind
}

type LegacyViewConstructor = new (buffer: ArrayBuffer) => ArrayBufferView

const LEGACY_VIEW_CONSTRUCTORS: Record<string, LegacyViewConstructor> = {
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array,
}

if (typeof BigInt64Array !== 'undefined') {
	LEGACY_VIEW_CONSTRUCTORS.BigInt64Array = BigInt64Array
}
if (typeof BigUint64Array !== 'undefined') {
	LEGACY_VIEW_CONSTRUCTORS.BigUint64Array = BigUint64Array
}

type PersistedValue<T> = T extends Blob
	? PersistedBlobRecord
	: T extends URL
		? PersistedUrlRecord
		: T extends ArrayBuffer | Uint8Array
			? PersistedBinaryRecord
			: T extends readonly (infer Item)[]
				? PersistedValue<Item>[]
				: T extends object
					? { [Key in keyof T]: PersistedValue<T[Key]> }
					: T

export type PersistedChatSession = PersistedValue<
	ChatSession | LegacyChatSession
>

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer)
	// Keep the spread call below the argument limit on older Android WebViews.
	const chunkSize = 0x2000
	let binary = ''
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
	}
	// One pass instead of three full-string replaces. Padding only ever appears
	// at the end, so dropping every '=' is equivalent to /(=+)$/.
	return btoa(binary).replace(/[+/=]/g, (char) =>
		char === '+' ? '-' : char === '/' ? '_' : '',
	)
}

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
	const binary = atob(padded)
	const buffer = new ArrayBuffer(binary.length)
	const bytes = new Uint8Array(buffer)
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i)
	}
	return buffer
}

function viewBytes(view: Uint8Array): ArrayBuffer {
	return view.buffer.slice(
		view.byteOffset,
		view.byteOffset + view.byteLength,
	) as ArrayBuffer
}

function createBinaryRecord(
	value: ArrayBuffer | Uint8Array,
): WritablePersistedBinaryRecord {
	if (value instanceof ArrayBuffer) {
		return {
			[BINARY_RECORD_MARKER_V2]: true,
			kind: 'arraybuffer',
			data: arrayBufferToBase64Url(value),
		}
	}
	return {
		[BINARY_RECORD_MARKER_V2]: true,
		kind: 'Uint8Array',
		data: arrayBufferToBase64Url(viewBytes(value)),
	}
}

function isPersistedBlobRecord(value: unknown): value is PersistedBlobRecord {
	return (
		!!value &&
		typeof value === 'object' &&
		(value as Partial<PersistedBlobRecord>)[BLOB_RECORD_MARKER_V2] === true &&
		typeof (value as Partial<PersistedBlobRecord>).type === 'string' &&
		typeof (value as Partial<PersistedBlobRecord>).data === 'string'
	)
}

function isLegacyPersistedBlobRecord(
	value: unknown,
): value is LegacyPersistedBlobRecord {
	return (
		!!value &&
		typeof value === 'object' &&
		(value as Partial<LegacyPersistedBlobRecord>)[BLOB_RECORD_MARKER_V1] ===
			true &&
		typeof (value as Partial<LegacyPersistedBlobRecord>).type === 'string' &&
		(value as Partial<LegacyPersistedBlobRecord>).data instanceof ArrayBuffer
	)
}

function isPersistedBinaryRecord(
	value: unknown,
): value is PersistedBinaryRecord {
	return (
		!!value &&
		typeof value === 'object' &&
		(value as Partial<PersistedBinaryRecord>)[BINARY_RECORD_MARKER_V2] ===
			true &&
		typeof (value as Partial<PersistedBinaryRecord>).kind === 'string' &&
		typeof (value as Partial<PersistedBinaryRecord>).data === 'string'
	)
}

function isPersistedUrlRecord(value: unknown): value is PersistedUrlRecord {
	return (
		!!value &&
		typeof value === 'object' &&
		(value as Partial<PersistedUrlRecord>)[URL_RECORD_MARKER] === true &&
		typeof (value as Partial<PersistedUrlRecord>).href === 'string'
	)
}

// Cache the in-flight promise, not the resolved record: encodeBlobs encodes
// object entries concurrently, so two references to one Blob would otherwise
// both read and base64-encode it before either could populate the cache.
const encodedBlobCache = new WeakMap<Blob, Promise<PersistedBlobRecord>>()
const encodedArrayBufferCache = new WeakMap<
	ArrayBuffer,
	PersistedBinaryRecord
>()
const encodedUint8ArrayCache = new WeakMap<Uint8Array, PersistedBinaryRecord>()

function encodeBinary(value: ArrayBuffer | Uint8Array): PersistedBinaryRecord {
	const cache =
		value instanceof ArrayBuffer
			? encodedArrayBufferCache
			: encodedUint8ArrayCache
	const cached = cache.get(value as never)
	if (cached) return cached
	const record = createBinaryRecord(value)
	cache.set(value as never, record)
	return record
}

function encodeBlob(value: Blob): Promise<PersistedBlobRecord> {
	const cached = encodedBlobCache.get(value)
	if (cached) return cached
	const promise = (async (): Promise<PersistedBlobRecord> => {
		return {
			[BLOB_RECORD_MARKER_V2]: true,
			type: value.type,
			data: arrayBufferToBase64Url(await value.arrayBuffer()),
		}
	})().catch((error: unknown) => {
		encodedBlobCache.delete(value)
		throw error
	})
	encodedBlobCache.set(value, promise)
	return promise
}

async function encodeBlobs(value: unknown): Promise<unknown> {
	if (value instanceof Blob) {
		return encodeBlob(value)
	}
	if (value instanceof URL) {
		return {
			[URL_RECORD_MARKER]: true,
			href: value.href,
		} satisfies PersistedUrlRecord
	}
	if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
		return encodeBinary(value)
	}
	if (ArrayBuffer.isView(value)) {
		throw new TypeError(
			'Only ArrayBuffer and Uint8Array are supported in chat session persistence',
		)
	}
	if (Array.isArray(value)) {
		return Promise.all(value.map(encodeBlobs))
	}
	if (!value || typeof value !== 'object') {
		return value
	}

	const entries = await Promise.all(
		Object.entries(value).map(async ([key, entry]) => [
			key,
			await encodeBlobs(entry),
		]),
	)
	return Object.fromEntries(entries)
}

function decodeBinaryRecord(
	value: PersistedBinaryRecord,
): ArrayBuffer | ArrayBufferView {
	const buffer = base64UrlToArrayBuffer(value.data)
	if (value.kind === 'arraybuffer') {
		return buffer
	}
	if (value.kind === 'dataview') {
		return new DataView(buffer)
	}
	if (value.kind === 'Buffer' && typeof Buffer !== 'undefined') {
		return Buffer.from(buffer)
	}
	const viewCtor = LEGACY_VIEW_CONSTRUCTORS[value.kind]
	if (viewCtor) {
		try {
			return new viewCtor(buffer)
		} catch {
			/* Preserve the bytes when a legacy view constructor is unavailable. */
		}
	}
	return buffer
}

function decodeBlobs(value: unknown): unknown {
	if (isPersistedBlobRecord(value)) {
		return new Blob([base64UrlToArrayBuffer(value.data)], {
			type: value.type,
		})
	}
	if (isLegacyPersistedBlobRecord(value)) {
		return new Blob([value.data], { type: value.type })
	}
	if (isPersistedBinaryRecord(value)) {
		return decodeBinaryRecord(value)
	}
	if (isPersistedUrlRecord(value)) {
		return new URL(value.href)
	}
	if (Array.isArray(value)) {
		return value.map(decodeBlobs)
	}
	if (
		!value ||
		typeof value !== 'object' ||
		value instanceof Blob ||
		value instanceof ArrayBuffer ||
		ArrayBuffer.isView(value)
	) {
		return value
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, decodeBlobs(entry)]),
	)
}

/**
 * A whole ChatSession is persisted as a plain JSON file. Nested Blob/File
 * values, ArrayBuffers and Uint8Arrays cannot survive JSON.stringify, so
 * every binary payload is base64url-encoded and restored at the session
 * boundary instead. V1 records are still accepted on decode for lossless
 * migration from IndexedDB storage.
 */
export async function encodeChatSessionForStorage(
	session: ChatSession,
): Promise<PersistedChatSession> {
	return (await encodeBlobs(session)) as PersistedChatSession
}

export function decodeChatSessionFromStorage(
	stored: PersistedChatSession,
): ChatSession | LegacyChatSession {
	return decodeBlobs(stored) as ChatSession | LegacyChatSession
}
