import { Bash } from 'just-bash/browser'
import { runWithTimeout } from '~/ai/chat/runtime/tool-timeout'
import type { App } from 'obsidian'
import type { PermissionGuard } from '~/ai/tools/permission-guard'
import { ReversibleOpRecorder } from './fs'
import { archiveCommands } from './zip'
import {
	createVaultFileSystem,
	VAULT_MOUNT_POINT,
	type VaultFileSystemManager,
} from '../vault-filesystem'
import { BashResourceBudget, createBashResourceBudget } from './fs'
import type { SettingsSnapshotFn, SettingsUpdater } from '../tool-context'

export interface VaultBashExecOptions {
	cwd?: string
	stdin?: string
	rawScript?: boolean
	abortSignal?: AbortSignal
	timeoutMs?: number
	resourceBudget?: BashResourceBudget
	heartbeatIntervalMs?: number
	onHeartbeat?: (elapsedActiveMs: number) => void
	permissionGuard?: PermissionGuard
	onRead?: (vaultPath: string) => void
	getSettingsSnapshot?: SettingsSnapshotFn
	updateSettings?: SettingsUpdater
	fileSystemManager?: VaultFileSystemManager
}

/**
 * Explicit mobile budgets for the browser bash subset. These are intentionally
 * tighter than just-bash defaults: runaway awk/find/recursive loops should fail
 * with a structured limit error, not freeze the WebView first.
 */
export const VAULT_BASH_EXECUTION_LIMITS = {
	maxCallDepth: 50,
	maxCommandCount: 2000,
	maxLoopIterations: 10_000,
	maxAwkIterations: 10_000,
	maxSedIterations: 10_000,
	maxJqIterations: 10_000,
	maxGlobOperations: 20_000,
	maxStringLength: 10 * 1024 * 1024,
	maxArrayElements: 100_000,
	maxHeredocSize: 10 * 1024 * 1024,
	maxSubstitutionDepth: 20,
	maxBraceExpansionResults: 1000,
	maxOutputSize: 10 * 1024 * 1024,
	maxFileDescriptors: 256,
	maxSourceDepth: 50,
} as const

export async function createVaultBash(
	app: App,
	permissionGuard?: PermissionGuard,
	recorder?: ReversibleOpRecorder,
	onRead?: (vaultPath: string) => void,
	settingsIo?: {
		getSettingsSnapshot?: SettingsSnapshotFn
		updateSettings?: SettingsUpdater
	},
	fileSystemManager?: VaultFileSystemManager,
	resourceBudget?: BashResourceBudget,
) {
	const fs = await createVaultFileSystem(app, {
		permissionGuard,
		recorder,
		onRead,
		getSettingsSnapshot: settingsIo?.getSettingsSnapshot,
		updateSettings: settingsIo?.updateSettings,
		fileSystemManager,
		resourceBudget,
	})
	return new Bash({
		fs,
		cwd: VAULT_MOUNT_POINT,
		customCommands: archiveCommands,
		executionLimits: VAULT_BASH_EXECUTION_LIMITS,
	})
}

export async function execVaultBash(
	app: App,
	script: string,
	options: VaultBashExecOptions = {},
) {
	const recorder = new ReversibleOpRecorder()
	const bash = await createVaultBash(
		app,
		options.permissionGuard,
		recorder,
		options.onRead,
		{
			getSettingsSnapshot: options.getSettingsSnapshot,
			updateSettings: options.updateSettings,
		},
		options.fileSystemManager,
		options.resourceBudget ?? createBashResourceBudget(),
	)
	const result = await runWithTimeout(
		(signal) =>
			bash.exec(script, {
				cwd: options.cwd ?? VAULT_MOUNT_POINT,
				stdin: options.stdin,
				rawScript: options.rawScript,
				signal,
			}),
		{
			toolName: 'bash',
			timeoutMs: options.timeoutMs,
			abortSignal: options.abortSignal,
			heartbeatIntervalMs: options.heartbeatIntervalMs,
			onHeartbeat: options.onHeartbeat,
		},
	)
	return {
		...result,
		reversibleOps: await recorder.getNetOperations(),
	}
}

export {
	AGENTS_MOUNT_POINT,
	BUILTIN_SKILLS_MOUNT_POINT,
	SETTINGS_MOUNT_POINT,
	VAULT_MOUNT_POINT,
} from '../vault-filesystem'
