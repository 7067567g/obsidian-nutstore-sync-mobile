import { normalizePath, type App } from 'obsidian'
import {
	existsLocalPath,
	readLocalText,
	writeLocalText,
} from '~/utils/local-vault-io'
import { DIAGNOSTICS_EXPORT_DIR } from './log-file'

/**
 * Lightweight crash-loop breadcrumb.
 *
 * Android WebView deaths, LMK kills and user swipes from the recents list do
 * not run `onunload`, so a durable "last exit was clean" flag alone cannot
 * distinguish an ordinary mobile force-close from a real crash. BOOT-01 splits
 * the semantics conservatively (R5):
 *
 * - `unload`     — `onunload` ran; clean, never abnormal.
 * - `background` — visibility/pagehide was observed before the process died
 *                  (the normal path for user swipes and most LMK kills);
 *                  ordinary, never abnormal.
 * - `running`    — the process disappeared while the plugin still considered
 *                  itself foreground; suspected crash, increments the counter.
 *
 * Only consecutive suspected crashes inside `ABNORMAL_START_WINDOW_MS` count,
 * so an isolated crash days later starts a new streak at 1.
 */
export const STARTUP_STATE_FILE = `${DIAGNOSTICS_EXPORT_DIR}/startup-state.json`
export const ABNORMAL_START_NOTICE_THRESHOLD = 2
export const ABNORMAL_START_WINDOW_MS = 6 * 60 * 60 * 1000

export type StartupExitReason = 'unload' | 'background' | 'running'

export interface StartupState {
	schemaVersion: 1
	lastStartAt: string
	lastStartVersion: string
	lastExitAt?: string
	lastExitClean: boolean
	lastExitReason?: StartupExitReason
	lastBackgroundAt?: string
	consecutiveAbnormalStarts: number
	lastAbnormalAt?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readExitReason(value: unknown): StartupExitReason | undefined {
	return value === 'unload' || value === 'background' || value === 'running'
		? value
		: undefined
}

function isSuspectedCrash(previous: StartupState | undefined) {
	return (
		previous !== undefined &&
		previous.lastExitClean === false &&
		previous.lastExitReason === 'running'
	)
}

function abnormalStartCount(previous: StartupState, nowMs: number) {
	const lastAbnormalMs = previous.lastAbnormalAt
		? Date.parse(previous.lastAbnormalAt)
		: Number.NaN
	const insideWindow =
		Number.isFinite(lastAbnormalMs) &&
		nowMs - lastAbnormalMs <= ABNORMAL_START_WINDOW_MS
	return insideWindow ? previous.consecutiveAbnormalStarts + 1 : 1
}

function normalizeStartupState(value: unknown): StartupState | undefined {
	if (!isRecord(value)) return undefined
	const parsedCount = value.consecutiveAbnormalStarts
	const consecutiveAbnormalStarts =
		typeof parsedCount === 'number' && Number.isFinite(parsedCount)
			? Math.max(0, Math.floor(parsedCount))
			: 0
	return {
		schemaVersion: 1,
		lastStartAt: readString(value.lastStartAt) ?? '',
		lastStartVersion: readString(value.lastStartVersion) ?? '',
		lastExitAt: readString(value.lastExitAt),
		lastExitClean: value.lastExitClean === true,
		lastExitReason: readExitReason(value.lastExitReason),
		lastBackgroundAt: readString(value.lastBackgroundAt),
		consecutiveAbnormalStarts,
		lastAbnormalAt: readString(value.lastAbnormalAt),
	}
}

export async function readStartupState(
	app: App,
): Promise<StartupState | undefined> {
	try {
		const path = normalizePath(STARTUP_STATE_FILE)
		if (!(await existsLocalPath(app.vault, path))) return undefined
		return normalizeStartupState(
			JSON.parse(await readLocalText(app.vault, path)),
		)
	} catch {
		return undefined
	}
}

async function writeStartupState(app: App, state: StartupState) {
	try {
		await writeLocalText(
			app.vault,
			normalizePath(STARTUP_STATE_FILE),
			`${JSON.stringify(state, null, 2)}\n`,
		)
	} catch {
		/* Breadcrumb is best-effort; never block plugin startup/shutdown. */
	}
}

/**
 * Mark a start and return the state the caller should show in diagnostics/UI.
 *
 * Only `running` (no clean unload, no background marker) counts as a suspected
 * crash. Ordinary mobile force-closes leave a `background` marker and reset the
 * counter; a clean `unload` resets it too.
 */
export async function markStartup(
	app: App,
	version: string,
): Promise<StartupState> {
	const previous = await readStartupState(app)
	const now = new Date()
	const nowIso = now.toISOString()
	const abnormal = isSuspectedCrash(previous)
	const consecutiveAbnormalStarts =
		abnormal && previous ? abnormalStartCount(previous, now.getTime()) : 0
	const state: StartupState = {
		schemaVersion: 1,
		lastStartAt: nowIso,
		lastStartVersion: version,
		lastExitAt: previous?.lastExitAt,
		lastExitClean: false,
		lastExitReason: 'running',
		lastBackgroundAt: previous?.lastBackgroundAt,
		consecutiveAbnormalStarts,
		lastAbnormalAt: abnormal ? nowIso : undefined,
	}
	await writeStartupState(app, state)
	return state
}

/**
 * Record that the app was backgrounded (visibility hidden or pagehide). This
 * is the normal precursor of a user swipe / LMK kill, so the next start treats
 * it as an ordinary exit rather than a crash. A clean unload already recorded
 * in this session must not be downgraded by a late pagehide event.
 */
export async function markBackgrounded(app: App): Promise<void> {
	const previous = await readStartupState(app)
	if (!previous) return
	if (previous.lastExitClean && previous.lastExitReason === 'unload') return
	const state: StartupState = {
		...previous,
		lastExitClean: false,
		lastExitReason: 'background',
		lastBackgroundAt: new Date().toISOString(),
	}
	await writeStartupState(app, state)
}

/** Mark a clean plugin unload so the next start resets the crash-loop counter. */
export async function markCleanExit(app: App): Promise<void> {
	const previous = await readStartupState(app)
	const now = new Date().toISOString()
	const state: StartupState = {
		schemaVersion: 1,
		lastStartAt: previous?.lastStartAt ?? now,
		lastStartVersion: previous?.lastStartVersion ?? '',
		lastExitAt: now,
		lastExitClean: true,
		lastExitReason: 'unload',
		lastBackgroundAt: previous?.lastBackgroundAt,
		consecutiveAbnormalStarts: previous?.consecutiveAbnormalStarts ?? 0,
		lastAbnormalAt: previous?.lastAbnormalAt,
	}
	await writeStartupState(app, state)
}
