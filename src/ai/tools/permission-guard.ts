import type { App } from 'obsidian'
import { PermissionDeniedError } from '~/ai/chat/tool-outcome'
import type { ChatModalMountTarget } from '~/ai/chat/ui/modal-mount'
import AIPermissionModal from '~/components/AIPermissionModal'
import i18n from '~/i18n'
import type {
	AIDualPathFileOperation,
	AISinglePathFileOperation,
} from './file-operation'

export interface FSSinglePathPermissionRequest {
	type: 'fs'
	fs: {
		kind: AISinglePathFileOperation
		path: string
	}
	purpose?: string
	sessionTitle?: string
}

export interface FSBatchPermissionRequest {
	type: 'fs'
	fs: {
		kind: AISinglePathFileOperation
		paths: string[]
	}
	purpose?: string
	sessionTitle?: string
}

export interface FSDualPathPermissionRequest {
	type: 'fs'
	fs: {
		kind: AIDualPathFileOperation
		src: string
		dest: string
	}
	purpose?: string
	sessionTitle?: string
}

export interface SettingsPermissionRequest {
	type: 'settings'
	settings: {
		action: 'update'
		summary: string
		changes: unknown
	}
	purpose?: string
	sessionTitle?: string
}

export interface BashPermissionRequest {
	type: 'bash'
	command: string
	purpose?: string
	sessionTitle?: string
}

export type PermissionRequest =
	| FSSinglePathPermissionRequest
	| FSBatchPermissionRequest
	| FSDualPathPermissionRequest
	| SettingsPermissionRequest
	| BashPermissionRequest
/**
 * Authorization source returned by a successful guard. `once` approves only the
 * current request, `session` is remembered for the current session, and
 * `always` persists through the caller's `onAlwaysAllow` hook.
 */
export type PermissionGrantSource = 'once' | 'session' | 'always'
export type PermissionGuard = (
	request: PermissionRequest,
) => Promise<PermissionGrantSource | void>

/**
 * Binds the user-facing purpose of a tool call to every permission request it
 * causes. Operation signatures deliberately remain based on the operation,
 * not this explanatory text.
 *
 * P-003 / D-003: tool execution is fail-closed. When a tool context has no
 * permission guard bound, the returned guard rejects every guarded operation
 * instead of silently allowing it; read-only commands that never request
 * permission keep working.
 */
export function withPermissionPurpose(
	permissionGuard: PermissionGuard | undefined,
	purpose: string,
): PermissionGuard | undefined {
	if (!permissionGuard) {
		return async (request) => {
			throw new PermissionDeniedError(
				i18n.t('aiPermission.denied', {
					summary: formatDeniedSummary(request),
				}),
			)
		}
	}
	return async (request) => permissionGuard({ ...request, purpose })
}

export interface RuntimeAutoApproveOperationStore {
	has(signature: string): boolean
	add(signature: string, source?: PermissionGrantSource): void
	get?(signature: string): PermissionGrantSource | undefined
}

function isDualPathRequest(
	request: PermissionRequest,
): request is FSDualPathPermissionRequest {
	return (
		request.type === 'fs' &&
		(request.fs.kind === 'copy' || request.fs.kind === 'move')
	)
}

function isBatchPathRequest(
	request: PermissionRequest,
): request is FSBatchPermissionRequest {
	return request.type === 'fs' && 'paths' in request.fs
}

export function getPermissionRequestOperationSignature(
	request: PermissionRequest,
) {
	if (request.type === 'settings') {
		return `settings:${request.settings.action}`
	}
	if (request.type === 'bash') return 'bash'
	return request.fs.kind
}

function formatDeniedSummary(request: PermissionRequest) {
	if (request.type === 'settings') {
		return request.settings.summary
	}
	if (request.type === 'bash') {
		// AUD-01: never echo the script body into denial reasons. The purpose
		// (a short user-facing description) is safe; when absent we only report
		// the machine-readable event type.
		const purpose = request.purpose?.trim()
		return purpose ? `bash: ${purpose}` : 'bash: denied-by-user'
	}
	const { kind } = request.fs
	if (isDualPathRequest(request)) {
		return `${kind} from ${request.fs.src} to ${request.fs.dest}`
	}
	if (isBatchPathRequest(request)) {
		return `${kind} on ${request.fs.paths.length} file(s)`
	}
	return `${kind} on ${request.fs.path}`
}

export function createPermissionGuard(
	app: App,
	runtimeAutoApproveOperationStore?: RuntimeAutoApproveOperationStore,
	context?: {
		sessionTitle?: string
		modalMountTarget?: ChatModalMountTarget
		onAlwaysAllow?: (request: PermissionRequest) => void | Promise<void>
	},
): PermissionGuard {
	return async (request: PermissionRequest) => {
		const signature = getPermissionRequestOperationSignature(request)
		if (runtimeAutoApproveOperationStore?.has(signature)) {
			return runtimeAutoApproveOperationStore.get?.(signature) ?? 'session'
		}

		const modal = new AIPermissionModal(
			app,
			{
				...request,
				sessionTitle: context?.sessionTitle,
			},
			context?.modalMountTarget,
		)
		// `openAndWait` is the plugin modal's result-aware API. Keep a small
		// compatibility path for test doubles and older integrations that expose
		// the original Promise-returning `open` method only.
		const result =
			typeof modal.openAndWait === 'function'
				? await modal.openAndWait()
				: await (modal.open() as unknown as Promise<string>)

		if (result === 'deny') {
			throw new PermissionDeniedError(
				i18n.t('aiPermission.denied', {
					summary: formatDeniedSummary(request),
				}),
			)
		}

		if (result === 'approve-always') {
			if (context?.onAlwaysAllow) await context.onAlwaysAllow(request)
			return 'always'
		}

		if (result === 'auto-approve-operation' || result === 'approve-session') {
			runtimeAutoApproveOperationStore?.add(signature, 'session')
			return 'session'
		}

		return 'once'
	}
}

export function createReadonlyPermissionGuard(): PermissionGuard {
	return async (request: PermissionRequest) => {
		throw new PermissionDeniedError(
			i18n.t('aiPermission.readonly', {
				summary: formatDeniedSummary(request),
			}),
		)
	}
}

export function createFullAccessPermissionGuard(): PermissionGuard {
	return async () => 'always'
}
