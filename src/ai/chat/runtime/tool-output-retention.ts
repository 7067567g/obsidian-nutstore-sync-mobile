import type { Vault } from 'obsidian'
import { CHAT_ROOT_DIR } from '~/ai/chat/session/session-files'
import {
	readLocalText,
	removeLocalPath,
	writeLocalText,
} from '~/utils/local-vault-io'
import { sha256Hex } from '~/utils/sha256'

/**
 * Tool-output retention, adapted from DeepSeek Harness
 * `@deepseek-ai/dsh-output-retention` + `@deepseek-ai/dsh-spill-policy`.
 *
 * The session log keeps a bounded head/tail preview plus a notice pointing at a
 * full spill file in the hidden vault. Non-string outputs (structured JSON,
 * image attachments) are never touched. Any spill failure keeps the original
 * text visible, matching the reference policy's best-effort contract.
 */

/** Outputs at or below this UTF-8 byte count are persisted in full. */
export const TOOL_OUTPUT_INLINE_BUDGET_BYTES = 8192
/** Head bytes retained from an oversized output. */
export const TOOL_OUTPUT_HEAD_BYTES = 4096
/** Tail bytes retained from an oversized output. */
export const TOOL_OUTPUT_TAIL_BYTES = 1024
/** Hidden directory containing full tool-output spill files. */
export const TOOL_OUTPUT_SPILL_ROOT = `${CHAT_ROOT_DIR}/spill`
/** Marker between retained head and tail. */
export const TOOL_OUTPUT_OMISSION_MARKER =
	'\n\n[... tool result middle omitted; full text spilled to file ...]\n\n'
/** Retrieval hint persisted with every spill reference. */
export const TOOL_OUTPUT_RETRIEVAL_HINT =
	'Use vault_read on this path, or grep it to search within it.'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface ToolOutputRetentionMeta {
	toolName?: string
	toolCallId?: string
	/** Bytes omitted by the inline preview, when spill is called by retention. */
	omittedBytes?: number
}

export interface RetainedToolOutput {
	preview: string
	omittedBytes: number
	truncated: boolean
}

/** Reference persisted in the sidecar next to the full spill file. */
export interface SpillRef {
	/** Vault-relative path of the full text file. */
	locator: string
	/** Model/user-facing recovery guidance. */
	retrievalHint: string
	/** SHA-256 of the full UTF-8 text. */
	hash: string
	/** UTF-8 byte length of the full text. */
	bytes: number
	/** Bytes omitted from the inline preview. */
	omittedBytes: number
	/** Creation time (epoch ms). */
	createdAt: number
	toolName?: string
	toolCallId?: string
}

export interface SpillSidecar extends SpillRef {
	formatVersion: 1
}

export interface ToolOutputRetainer {
	retain(
		sessionId: string,
		text: string,
		meta?: ToolOutputRetentionMeta,
	): Promise<string>
}

function isContinuationByte(byte: number | undefined) {
	return byte !== undefined && (byte & 0xc0) === 0x80
}

function trimHeadBoundary(bytes: Uint8Array, end: number) {
	let cut = Math.min(end, bytes.byteLength)
	while (cut > 0 && cut < bytes.byteLength && isContinuationByte(bytes[cut])) {
		cut -= 1
	}
	return cut
}

function trimTailBoundary(bytes: Uint8Array, start: number) {
	let cut = Math.max(0, start)
	while (cut < bytes.byteLength && isContinuationByte(bytes[cut])) {
		cut += 1
	}
	return cut
}

/**
 * Keep ordered head/tail bytes within the inline budget. Cuts never split a
 * UTF-8 sequence, and `omittedBytes` counts bytes actually dropped from the
 * original string, not the byte budget.
 */
export function retainToolOutputText(
	text: string,
	budgetBytes = TOOL_OUTPUT_INLINE_BUDGET_BYTES,
): RetainedToolOutput {
	const bytes = encoder.encode(text)
	if (bytes.byteLength <= budgetBytes) {
		return { preview: text, omittedBytes: 0, truncated: false }
	}
	const headEnd = trimHeadBoundary(bytes, TOOL_OUTPUT_HEAD_BYTES)
	const tailStart = trimTailBoundary(
		bytes,
		bytes.byteLength - TOOL_OUTPUT_TAIL_BYTES,
	)
	const head = decoder.decode(bytes.subarray(0, headEnd))
	const tail = decoder.decode(bytes.subarray(tailStart))
	const omittedBytes = tailStart - headEnd
	if (omittedBytes <= 0) {
		return { preview: text, omittedBytes: 0, truncated: false }
	}
	return {
		preview: `${head}${TOOL_OUTPUT_OMISSION_MARKER}${tail}`,
		omittedBytes,
		truncated: true,
	}
}

/** Format the persisted notice appended to a retained preview. */
export function formatSpillNotice(omittedBytes: number, ref: SpillRef): string {
	return `(Omitted ${omittedBytes} bytes. Full result stored at: ${ref.locator}. ${ref.retrievalHint})`
}

/** Recognize a persisted spill notice without parsing its locator. */
export function hasSpillNotice(text: string): boolean {
	return (
		text.includes('(Omitted ') &&
		text.includes(' Full result stored at: ') &&
		text.trimEnd().endsWith(')')
	)
}

function safeSegment(raw: string) {
	const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '')
	return safe.slice(0, 48) || 'tool'
}

function randomToken() {
	try {
		return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
	} catch {
		return Math.random().toString(36).slice(2, 14)
	}
}

async function getSessionSpillDir(sessionId: string) {
	const hash = (await sha256Hex(encoder.encode(sessionId))).slice(0, 12)
	return `${TOOL_OUTPUT_SPILL_ROOT}/session-${hash}`
}

async function writeSpillSidecar(vault: Vault, ref: SpillRef) {
	const sidecar: SpillSidecar = { formatVersion: 1, ...ref }
	await writeLocalText(
		vault,
		`${ref.locator}.meta.json`,
		JSON.stringify(sidecar),
	)
}

/**
 * Persist the full text to a random hidden path and return its locator/hash.
 * The caller decides how to degrade when this throws.
 */
export async function spillToolOutput(
	vault: Vault,
	sessionId: string,
	text: string,
	meta: ToolOutputRetentionMeta = {},
): Promise<SpillRef> {
	const hash = await sha256Hex(encoder.encode(text))
	const dir = await getSessionSpillDir(sessionId)
	const locator = `${dir}/${randomToken()}-${safeSegment(meta.toolName ?? 'tool')}.txt`
	const ref: SpillRef = {
		locator,
		retrievalHint: TOOL_OUTPUT_RETRIEVAL_HINT,
		hash,
		bytes: encoder.encode(text).byteLength,
		omittedBytes: meta.omittedBytes ?? 0,
		createdAt: Date.now(),
		toolName: meta.toolName,
		toolCallId: meta.toolCallId,
	}
	await writeLocalText(vault, locator, text)
	try {
		await writeSpillSidecar(vault, ref)
	} catch {
		// The raw file is the recovery path; metadata is best-effort.
	}
	return ref
}

/** Read a spill file back and verify its content hash when metadata exists. */
export async function hydrateToolOutput(
	vault: Vault,
	locator: string,
): Promise<{ text: string; meta?: SpillSidecar }> {
	if (!locator.startsWith(`${TOOL_OUTPUT_SPILL_ROOT}/`)) {
		throw new Error(`Invalid tool-output spill locator: ${locator}`)
	}
	const text = await readLocalText(vault, locator)
	let meta: SpillSidecar | undefined
	try {
		meta = JSON.parse(
			await readLocalText(vault, `${locator}.meta.json`),
		) as SpillSidecar
	} catch {
		meta = undefined
	}
	if (meta?.hash) {
		const actual = await sha256Hex(encoder.encode(text))
		if (actual !== meta.hash) {
			throw new Error(`Spill content hash mismatch: ${locator}`)
		}
	}
	return { text, meta }
}

/** Remove all spill files belonging to one session. */
export async function removeSessionSpill(vault: Vault, sessionId: string) {
	await removeLocalPath(vault, await getSessionSpillDir(sessionId), true)
}

/** Runtime service used by the projector; swallows spill failures. */
export class ToolOutputRetention implements ToolOutputRetainer {
	constructor(
		private readonly vault: Vault,
		private readonly budgetBytes = TOOL_OUTPUT_INLINE_BUDGET_BYTES,
	) {}

	async retain(
		sessionId: string,
		text: string,
		meta: ToolOutputRetentionMeta = {},
	): Promise<string> {
		if (text.length === 0 || hasSpillNotice(text)) return text
		const retained = retainToolOutputText(text, this.budgetBytes)
		if (!retained.truncated) return text
		try {
			const ref = await spillToolOutput(this.vault, sessionId, text, {
				...meta,
				omittedBytes: retained.omittedBytes,
			})
			return `${retained.preview}\n\n${formatSpillNotice(retained.omittedBytes, ref)}`
		} catch {
			return text
		}
	}

	async hydrate(locator: string) {
		return hydrateToolOutput(this.vault, locator)
	}

	async removeSessionSpill(sessionId: string) {
		await removeSessionSpill(this.vault, sessionId)
	}
}
