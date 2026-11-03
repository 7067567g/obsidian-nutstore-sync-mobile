import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
	type Mock,
} from 'vitest'
import NutstorePlugin from '~/index'

const mocks = vi.hoisted(() => ({
	emitCancelSync: vi.fn(),
	markBackgrounded: vi.fn(),
	markCleanExit: vi.fn(),
	markStartup: vi.fn(),
	readStartupState: vi.fn(),
	runSelfCheck: vi.fn(),
	exportDiagnosticsPackage: vi.fn(),
	exportPerfSnapshot: vi.fn(),
	ensureChatRootNomedia: vi.fn(),
	registerChatboxAiIcon: vi.fn(),
	loggerInfo: vi.fn(),
	loggerWarn: vi.fn(),
	loggerError: vi.fn(),
}))

vi.mock('./events', async (importOriginal) => ({
	...(await importOriginal<typeof import('./events')>()),
	emitCancelSync: mocks.emitCancelSync,
}))
vi.mock('./diagnostics/startup-state', async (importOriginal) => ({
	...(await importOriginal<typeof import('./diagnostics/startup-state')>()),
	markBackgrounded: mocks.markBackgrounded,
	markCleanExit: mocks.markCleanExit,
	markStartup: mocks.markStartup,
	readStartupState: mocks.readStartupState,
}))
vi.mock('./diagnostics/self-check', async (importOriginal) => ({
	...(await importOriginal<typeof import('./diagnostics/self-check')>()),
	runSelfCheck: mocks.runSelfCheck,
}))
vi.mock('./diagnostics/report', async (importOriginal) => ({
	...(await importOriginal<typeof import('./diagnostics/report')>()),
	exportDiagnosticsPackage: mocks.exportDiagnosticsPackage,
	exportPerfSnapshot: mocks.exportPerfSnapshot,
}))
vi.mock('./ai/chat/session/session-files', async (importOriginal) => ({
	...(await importOriginal<typeof import('./ai/chat/session/session-files')>()),
	ensureChatRootNomedia: mocks.ensureChatRootNomedia,
}))
vi.mock('./assets/icons/obsidian-nutstore-ai-icon', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('./assets/icons/obsidian-nutstore-ai-icon')
	>()),
	registerChatboxAiIcon: mocks.registerChatboxAiIcon,
}))
vi.mock('./utils/logger', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./utils/logger')>()
	return {
		...actual,
		default: {
			...actual.default,
			info: mocks.loggerInfo,
			warn: mocks.loggerWarn,
			error: mocks.loggerError,
		},
	}
})
vi.mock('./settings', async (importOriginal) => ({
	...(await importOriginal<typeof import('./settings')>()),
	NutstoreSettingTab: class {
		unload(): void {}
	},
}))

interface ServiceStub {
	onload: Mock
	onunload: Mock
}

interface PluginHarness {
	app: { workspace: { on: Mock }; vault: Record<string, never> }
	manifest: { version: string }
	services: ServiceStub[]
	chatService: {
		handleSettingsChanged: Mock
		initialize: Mock
		consumeStartupRecoveredToolCalls: Mock
		recoverPendingWrites: Mock
		onunload: Mock
		flushPendingSessions: Mock
		runOpsGcReport: Mock
		addUserContext: Mock
	}
	commandService: { openChatbox: Mock }
	diagnosticsLogFile: { flush: Mock }
	selfCheckReport: unknown
	startupState: unknown
	settingTab: { unload: Mock }
	addSettingTab: Mock
	registerView: Mock
	registerEvent: Mock
	registerDomEvent: Mock
	domHandlers: Record<string, Array<() => void>>
	register: Mock
	lastPerfSnapshotAt: number
}

function createService(overrides: Partial<ServiceStub> = {}): ServiceStub {
	return {
		onload: vi.fn(async () => {}),
		onunload: vi.fn(async () => {}),
		...overrides,
	}
}

function createPlugin(services: ServiceStub[]): PluginHarness {
	const domHandlers: Record<string, Array<() => void>> = {}
	const harness: PluginHarness = {
		app: { workspace: { on: vi.fn(() => ({})) }, vault: {} },
		manifest: { version: '1.5.7' },
		services,
		chatService: {
			handleSettingsChanged: vi.fn(async () => {}),
			initialize: vi.fn(async () => {}),
			consumeStartupRecoveredToolCalls: vi.fn(() => 0),
			recoverPendingWrites: vi.fn(async () => {}),
			onunload: vi.fn(async () => {}),
			flushPendingSessions: vi.fn(async () => {}),
			runOpsGcReport: vi.fn(async () => {}),
			addUserContext: vi.fn(),
		},
		commandService: { openChatbox: vi.fn(async () => {}) },
		diagnosticsLogFile: { flush: vi.fn(async () => {}) },
		selfCheckReport: null,
		startupState: null,
		settingTab: { unload: vi.fn() },
		addSettingTab: vi.fn(),
		registerView: vi.fn(),
		registerEvent: vi.fn(),
		registerDomEvent: vi.fn(
			(_target: unknown, event: string, handler: () => void) => {
				;(domHandlers[event] ??= []).push(handler)
			},
		),
		domHandlers,
		register: vi.fn(),
		lastPerfSnapshotAt: 0,
	}
	const plugin = Object.create(NutstorePlugin.prototype) as PluginHarness
	const { services: serviceList, ...rest } = harness
	Object.assign(plugin, rest)
	// `services` is a prototype getter, so it needs an own data property to be
	// overridden for the harness.
	Object.defineProperty(plugin, 'services', {
		value: serviceList,
		writable: true,
		enumerable: true,
		configurable: true,
	})
	return plugin
}

async function flushMicrotasks() {
	for (let index = 0; index < 12; index += 1) {
		await Promise.resolve()
	}
}

describe('NutstorePlugin lifecycle', () => {
	beforeEach(() => {
		vi.resetAllMocks()
		vi.useFakeTimers()
		vi.stubGlobal('document', { hidden: false })
		mocks.markStartup.mockResolvedValue({
			schemaVersion: 1,
			lastStartAt: '',
			lastStartVersion: '',
			lastExitClean: true,
			consecutiveAbnormalStarts: 0,
		})
		mocks.markBackgrounded.mockResolvedValue(undefined)
		mocks.markCleanExit.mockResolvedValue(undefined)
		mocks.readStartupState.mockResolvedValue(undefined)
		mocks.runSelfCheck.mockResolvedValue({})
		mocks.exportDiagnosticsPackage.mockResolvedValue(undefined)
		mocks.exportPerfSnapshot.mockResolvedValue(undefined)
		mocks.ensureChatRootNomedia.mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it('rolls back already-loaded services when a later service fails to load', async () => {
		const loaded = createService()
		const failing = createService({
			onload: vi.fn(async () => {
				throw new Error('boom')
			}),
		})
		const skipped = createService()
		const plugin = createPlugin([loaded, failing, skipped])

		await expect(NutstorePlugin.prototype.onload.call(plugin)).rejects.toThrow(
			'boom',
		)

		expect(loaded.onload).toHaveBeenCalledTimes(1)
		expect(failing.onload).toHaveBeenCalledTimes(1)
		expect(skipped.onload).not.toHaveBeenCalled()
		expect(loaded.onunload).toHaveBeenCalledTimes(1)
		expect(failing.onunload).not.toHaveBeenCalled()
	})

	it('does not let a rejected startup side effect escape onload', async () => {
		mocks.ensureChatRootNomedia.mockRejectedValueOnce(
			new Error('nomedia failed'),
		)
		const plugin = createPlugin([])

		await expect(
			NutstorePlugin.prototype.onload.call(plugin),
		).resolves.toBeUndefined()
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			'Failed to ensure chat root .nomedia',
			expect.anything(),
		)
	})

	it('records a background breadcrumb on pagehide and hidden visibility', async () => {
		const plugin = createPlugin([])
		await NutstorePlugin.prototype.onload.call(plugin)

		expect(mocks.markBackgrounded).not.toHaveBeenCalled()
		plugin.domHandlers.pagehide?.forEach((handler) => handler())
		await flushMicrotasks()
		expect(mocks.markBackgrounded).toHaveBeenCalledTimes(1)

		vi.stubGlobal('document', { hidden: true })
		plugin.domHandlers.visibilitychange?.forEach((handler) => handler())
		await flushMicrotasks()
		expect(mocks.markBackgrounded).toHaveBeenCalledTimes(2)
	})

	it('returns synchronously from onunload because Obsidian does not await it', () => {
		const plugin = createPlugin([])

		const result = NutstorePlugin.prototype.onunload.call(plugin)

		expect(result).toBeUndefined()
	})

	it('still flushes chat state and records a clean exit when a service never unloads', async () => {
		const hanging = createService({
			onunload: vi.fn(() => new Promise<void>(() => {})),
		})
		const plugin = createPlugin([hanging])

		NutstorePlugin.prototype.onunload.call(plugin)
		await flushMicrotasks()

		expect(plugin.chatService.onunload).toHaveBeenCalledTimes(1)
		expect(plugin.diagnosticsLogFile.flush).toHaveBeenCalledTimes(1)
		expect(mocks.markCleanExit).toHaveBeenCalledTimes(1)
		expect(plugin.settingTab.unload).toHaveBeenCalledTimes(1)
		expect(mocks.emitCancelSync).toHaveBeenCalledTimes(1)
	})

	it('swallows service unload rejections instead of rejecting onunload', async () => {
		const failing = createService({
			onunload: vi.fn(async () => {
				throw new Error('unload failed')
			}),
		})
		const plugin = createPlugin([failing])

		NutstorePlugin.prototype.onunload.call(plugin)
		await flushMicrotasks()

		expect(failing.onunload).toHaveBeenCalledTimes(1)
		expect(mocks.loggerError).toHaveBeenCalledWith(
			'Failed to unload service',
			expect.anything(),
		)
		expect(mocks.markCleanExit).toHaveBeenCalledTimes(1)
	})
})
