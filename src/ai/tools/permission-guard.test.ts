import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createPermissionGuard,
	createReadonlyPermissionGuard,
	createFullAccessPermissionGuard,
	withPermissionPurpose,
} from './permission-guard'

const { modalOpenMock, modalCtorMock } = vi.hoisted(() => ({
	modalOpenMock: vi.fn(),
	modalCtorMock: vi.fn(),
}))

vi.mock('~/components/AIPermissionModal', () => ({
	default: vi.fn().mockImplementation((app, request) => {
		modalCtorMock({ app, request })
		return {
			open: modalOpenMock,
		}
	}),
}))

function getRuntimeStore(
	sessionId: string,
	autoApproveBySession: Map<string, Set<string>>,
) {
	return {
		has(signature: string) {
			return autoApproveBySession.get(sessionId)?.has(signature) ?? false
		},
		add(signature: string) {
			const requests = autoApproveBySession.get(sessionId) ?? new Set()
			requests.add(signature)
			autoApproveBySession.set(sessionId, requests)
		},
	}
}

function createGuard(
	sessionId: string,
	options?: {
		autoApproveBySession?: Map<string, Set<string>>
	},
) {
	const autoApproveBySession =
		options?.autoApproveBySession ?? new Map<string, Set<string>>()
	const runtimeStore = getRuntimeStore(sessionId, autoApproveBySession)
	const guard = createPermissionGuard({} as never, runtimeStore)
	return { guard, autoApproveBySession }
}

beforeEach(() => {
	modalOpenMock.mockReset()
	modalCtorMock.mockReset()
})

describe('createPermissionGuard', () => {
	it('passes the bound purpose to the modal without changing auto-approval', async () => {
		const { guard } = createGuard('session-1')
		const purposeGuard = withPermissionPurpose(
			guard,
			'更新中性备注 🌱 / Update neutral note',
		)!
		modalOpenMock.mockResolvedValueOnce('auto-approve-operation')

		await purposeGuard({
			type: 'fs',
			fs: { kind: 'write', path: 'notes/中性🌱.md' },
		})
		await purposeGuard({
			type: 'fs',
			fs: { kind: 'write', path: 'notes/another.md' },
		})

		expect(modalCtorMock).toHaveBeenCalledWith({
			app: {},
			request: {
				type: 'fs',
				fs: { kind: 'write', path: 'notes/中性🌱.md' },
				purpose: '更新中性备注 🌱 / Update neutral note',
			},
		})
		expect(modalOpenMock).toHaveBeenCalledTimes(1)
	})

	it('approve only affects the current request', async () => {
		const { guard } = createGuard('session-1')
		modalOpenMock
			.mockResolvedValueOnce('approve')
			.mockResolvedValueOnce('approve')

		await guard({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } })
		await guard({ type: 'fs', fs: { kind: 'write', path: 'notes/b.md' } })

		expect(modalOpenMock).toHaveBeenCalledTimes(2)
	})

	it('auto-approve skips future prompts for same kind in same session', async () => {
		const { guard } = createGuard('session-1')
		modalOpenMock.mockResolvedValueOnce('auto-approve-operation')

		await guard({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } })
		await guard({ type: 'fs', fs: { kind: 'write', path: 'notes/b.md' } })

		expect(modalOpenMock).toHaveBeenCalledTimes(1)
	})

	it('different kinds in same session still prompt after auto-approve', async () => {
		const { guard } = createGuard('session-1')
		modalOpenMock
			.mockResolvedValueOnce('auto-approve-operation')
			.mockResolvedValueOnce('approve')

		await guard({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } })
		await guard({ type: 'fs', fs: { kind: 'delete', path: 'notes/a.md' } })

		expect(modalOpenMock).toHaveBeenCalledTimes(2)
		expect(modalCtorMock).toHaveBeenNthCalledWith(1, {
			app: {},
			request: { type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } },
		})
		expect(modalCtorMock).toHaveBeenNthCalledWith(2, {
			app: {},
			request: { type: 'fs', fs: { kind: 'delete', path: 'notes/a.md' } },
		})
	})

	it('same kind in different sessions still prompts', async () => {
		const autoApproveBySession = new Map<string, Set<string>>()
		const guardA = createGuard('session-a', { autoApproveBySession }).guard
		const guardB = createGuard('session-b', { autoApproveBySession }).guard
		modalOpenMock
			.mockResolvedValueOnce('auto-approve-operation')
			.mockResolvedValueOnce('approve')

		await guardA({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } })
		await guardB({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } })

		expect(modalOpenMock).toHaveBeenCalledTimes(2)
	})

	it('passes copy requests through to the modal', async () => {
		const { guard } = createGuard('session-1')
		modalOpenMock.mockResolvedValueOnce('approve')

		await guard({
			type: 'fs',
			fs: {
				kind: 'copy',
				src: 'notes/a.md',
				dest: 'notes/b.md',
			},
		})

		expect(modalCtorMock).toHaveBeenCalledWith({
			app: {},
			request: {
				type: 'fs',
				fs: {
					kind: 'copy',
					src: 'notes/a.md',
					dest: 'notes/b.md',
				},
			},
		})
	})

	it('throws an error when user denies a single-path request', async () => {
		const { guard } = createGuard('session-1')
		modalOpenMock.mockResolvedValueOnce('deny')

		await expect(
			guard({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } }),
		).rejects.toThrow('write on notes/a.md')
	})

	it('throws an error when user denies a dual-path request', async () => {
		const { guard } = createGuard('session-1')
		modalOpenMock.mockResolvedValueOnce('deny')

		await expect(
			guard({
				type: 'fs',
				fs: {
					kind: 'move',
					src: 'notes/a.md',
					dest: 'notes/b.md',
				},
			}),
		).rejects.toThrow('move from notes/a.md to notes/b.md')
	})
})

describe('bash permission requests', () => {
	it('prompts once per bash request unless session-approved', async () => {
		const { guard } = createGuard('session-1')
		modalOpenMock
			.mockResolvedValueOnce('approve')
			.mockResolvedValueOnce('approve-session')
			.mockResolvedValueOnce('approve')

		await guard({ type: 'bash', command: 'ls /' })
		await guard({ type: 'bash', command: 'cat notes/a.md' })
		await guard({ type: 'bash', command: 'echo again' })

		expect(modalOpenMock).toHaveBeenCalledTimes(2)
	})

	it('always-allow callback persists the decision', async () => {
		const autoApproveBySession = new Map<string, Set<string>>()
		const onAlwaysAllow = vi.fn()
		const guard = createPermissionGuard(
			{} as never,
			getRuntimeStore('session-1', autoApproveBySession),
			{ onAlwaysAllow },
		)
		modalOpenMock.mockResolvedValueOnce('approve-always')

		await guard({ type: 'bash', command: 'echo always' })

		expect(onAlwaysAllow).toHaveBeenCalledWith({
			type: 'bash',
			command: 'echo always',
		})
	})

	it('denies bash without echoing the command body', async () => {
		const { guard } = createGuard('session-1')
		modalOpenMock.mockResolvedValueOnce('deny')

		await expect(
			guard({ type: 'bash', command: 'rm -rf notes' }),
		).rejects.toThrow('bash: denied-by-user')
	})

	it('keeps the purpose in the denial summary when present', async () => {
		const { guard } = createGuard('session-1')
		modalOpenMock.mockResolvedValueOnce('deny')

		let denial: unknown
		try {
			await guard({
				type: 'bash',
				command: 'printf secret-token',
				purpose: '演示拒绝',
			})
		} catch (error) {
			denial = error
		}
		expect(denial).toBeInstanceOf(Error)
		const message = (denial as Error).message
		expect(message).toContain('bash: 演示拒绝')
		expect(message).not.toContain('secret-token')
		expect(denial).toMatchObject({ code: 'PERMISSION_DENIED' })
	})

	it('reports the effective authorization source', async () => {
		const once = createGuard('session-once').guard
		modalOpenMock.mockResolvedValueOnce('approve')
		await expect(once({ type: 'bash', command: 'echo once' })).resolves.toBe(
			'once',
		)

		const session = createGuard('session-session').guard
		modalOpenMock.mockResolvedValueOnce('approve-session')
		await expect(
			session({ type: 'bash', command: 'echo session' }),
		).resolves.toBe('session')
		// Once remembered, later requests in the same session no longer prompt
		// and keep reporting `session` instead of the configured `ask`.
		await expect(
			session({ type: 'bash', command: 'echo again' }),
		).resolves.toBe('session')

		const always = createGuard('session-always').guard
		modalOpenMock.mockResolvedValueOnce('approve-always')
		await expect(
			always({ type: 'bash', command: 'echo always' }),
		).resolves.toBe('always')
	})
})

describe('createReadonlyPermissionGuard', () => {
	it('rejects write operations without opening any modal', async () => {
		const guard = createReadonlyPermissionGuard()

		await expect(
			guard({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } }),
		).rejects.toThrow('write on notes/a.md')

		expect(modalOpenMock).not.toHaveBeenCalled()
	})

	it('rejects delete operations', async () => {
		const guard = createReadonlyPermissionGuard()

		await expect(
			guard({ type: 'fs', fs: { kind: 'delete', path: 'notes/a.md' } }),
		).rejects.toThrow('delete on notes/a.md')
	})

	it('rejects mkdir operations', async () => {
		const guard = createReadonlyPermissionGuard()

		await expect(
			guard({ type: 'fs', fs: { kind: 'mkdir', path: 'notes/sub' } }),
		).rejects.toThrow('mkdir on notes/sub')
	})

	it('rejects move operations', async () => {
		const guard = createReadonlyPermissionGuard()

		await expect(
			guard({
				type: 'fs',
				fs: {
					kind: 'move',
					src: 'notes/a.md',
					dest: 'notes/b.md',
				},
			}),
		).rejects.toThrow('move from notes/a.md to notes/b.md')
	})

	it('mentions the read-only constraint in the error message', async () => {
		const guard = createReadonlyPermissionGuard()

		await expect(
			guard({ type: 'fs', fs: { kind: 'edit', path: 'notes/a.md' } }),
		).rejects.toThrow(/read-only/i)
	})
})

describe('createFullAccessPermissionGuard', () => {
	it('allows write operations without opening any modal', async () => {
		const guard = createFullAccessPermissionGuard()

		await guard({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } })

		expect(modalOpenMock).not.toHaveBeenCalled()
	})

	it('allows delete operations without opening any modal', async () => {
		const guard = createFullAccessPermissionGuard()

		await guard({ type: 'fs', fs: { kind: 'delete', path: 'notes/a.md' } })

		expect(modalOpenMock).not.toHaveBeenCalled()
	})

	it('allows move operations without opening any modal', async () => {
		const guard = createFullAccessPermissionGuard()

		await guard({
			type: 'fs',
			fs: {
				kind: 'move',
				src: 'notes/a.md',
				dest: 'notes/b.md',
			},
		})

		expect(modalOpenMock).not.toHaveBeenCalled()
	})

	it('batch write request prompts once and auto-approves by operation kind', async () => {
		const { guard } = createGuard('session-1')
		modalOpenMock.mockResolvedValueOnce('auto-approve-operation')

		await guard({
			type: 'fs',
			fs: { kind: 'write', paths: ['notes/a.md', 'notes/b.md'] },
		})
		await guard({ type: 'fs', fs: { kind: 'write', path: 'notes/c.md' } })

		expect(modalOpenMock).toHaveBeenCalledTimes(1)
		expect(modalCtorMock).toHaveBeenCalledWith({
			app: {},
			request: {
				type: 'fs',
				fs: { kind: 'write', paths: ['notes/a.md', 'notes/b.md'] },
			},
		})
	})
})

describe('withPermissionPurpose without a bound guard (A04)', () => {
	it('returns a denying guard instead of undefined', async () => {
		const guard = withPermissionPurpose(undefined, 'neutral purpose')

		expect(guard).toBeDefined()
		await expect(
			guard!({ type: 'fs', fs: { kind: 'write', path: 'notes/a.md' } }),
		).rejects.toThrow('write on notes/a.md')
		expect(modalOpenMock).not.toHaveBeenCalled()
	})

	it('denies batch, settings and bash requests with a readable summary', async () => {
		const guard = withPermissionPurpose(undefined, 'neutral purpose')!

		await expect(
			guard({
				type: 'fs',
				fs: { kind: 'write', paths: ['notes/a.md', 'notes/b.md'] },
			}),
		).rejects.toThrow('write on 2 file(s)')
		await expect(
			guard({ type: 'bash', command: 'rm -rf notes' }),
		).rejects.toThrow('bash: denied-by-user')
		await expect(
			guard({
				type: 'settings',
				settings: {
					action: 'update',
					summary: 'settings on 1 key',
					changes: {},
				},
			}),
		).rejects.toThrow('settings on 1 key')
		expect(modalOpenMock).not.toHaveBeenCalled()
	})
})
