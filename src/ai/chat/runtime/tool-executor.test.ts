import { describe, expect, it, vi } from 'vitest'
import type { AgentDefinition } from '~/ai/chat/agents/registry'

const modalOpenAndWait = vi.hoisted(() => vi.fn())

vi.mock('~/components/AIPermissionModal', () => ({
	default: vi.fn().mockImplementation(() => ({
		openAndWait: modalOpenAndWait,
	})),
}))

vi.mock('~/ai/chat/ui/modal-mount', () => ({
	resolveChatModalMountTarget: () => undefined,
	applyObsidianModalMountTarget: () => () => undefined,
}))

import { ToolExecutor } from './tool-executor'

function fullAccessDefinition(): AgentDefinition {
	return {
		id: 'master',
		description: 'test',
		systemPrompt: '',
		tools: ['bash'],
		permissionMode: 'full',
		dispatchable: false,
	}
}

describe('ToolExecutor bash permission gate', () => {
	it('keeps bashAccess=ask interactive even when yolo/full access is on', async () => {
		modalOpenAndWait.mockReset().mockResolvedValue('approve')
		const executor = new ToolExecutor(
			{} as never,
			() => ({ yolo: true, bashAccess: 'ask' }) as never,
			{
				sessionIndex: [{ id: 'session', title: 'Test session' }],
				chatModalHostEl: undefined,
			} as never,
			{
				getAutoApproveRequests: () => ({
					has: () => false,
					add: () => undefined,
				}),
			} as never,
			{} as never,
			{
				getSettingsSnapshot: () => ({}) as never,
				updateSettings: async () => undefined,
			} as never,
		)

		const context = executor.createStableToolsContext(
			{ id: 'session' } as never,
			fullAccessDefinition(),
		)

		await context.permissionGuard?.({
			type: 'fs',
			fs: { kind: 'write', path: 'notes/a.md' },
		})
		expect(modalOpenAndWait).not.toHaveBeenCalled()

		await context.bashPermissionGuard?.({
			type: 'bash',
			command: 'printf hello',
		})
		expect(modalOpenAndWait).toHaveBeenCalledTimes(1)
	})
})
