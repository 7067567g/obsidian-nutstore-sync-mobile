import { Bash, InMemoryFs } from 'just-bash/browser'
import { describe, expect, it } from 'vitest'
import { runWithTimeout } from '~/ai/chat/runtime/tool-timeout'

function makeBash() {
	return new Bash({ fs: new InMemoryFs(), cwd: '/' })
}

describe('runWithTimeout + just-bash signal', () => {
	it('returns a short command result unchanged', async () => {
		const bash = makeBash()
		const result = await runWithTimeout(
			(signal) => bash.exec('echo hi', { signal }),
			{ toolName: 'bash', timeoutMs: 5000 },
		)
		expect(result.stdout).toContain('hi')
	})

	it('aborts a sleeping command with ToolTimeoutError', async () => {
		const bash = makeBash()
		await expect(
			runWithTimeout((signal) => bash.exec('sleep 5', { signal }), {
				toolName: 'bash',
				timeoutMs: 50,
			}),
		).rejects.toMatchObject({ code: 'timeout', toolName: 'bash' })
	})
})
