import { describe, expect, it } from 'vitest'
import { createSearchCommands } from './search'

class FakeFs {
	files = new Map<string, string>()
	dirs = new Set<string>(['/'])

	async stat(path: string) {
		if (this.dirs.has(path)) {
			return { isFile: false, isDirectory: true, size: 0 }
		}
		const content = this.files.get(path)
		if (content === undefined) throw new Error('ENOENT: ' + path)
		return { isFile: true, isDirectory: false, size: content.length }
	}
	async readFile(path: string) {
		const content = this.files.get(path)
		if (content === undefined) throw new Error('ENOENT: ' + path)
		return content
	}
	async readdir(path: string) {
		const prefix = path === '/' ? '/' : path + '/'
		const names = new Set<string>()
		for (const file of this.files.keys()) {
			if (file.indexOf(prefix) === 0 && file !== path) {
				const rest = file.slice(prefix.length)
				const slash = rest.indexOf('/')
				names.add(slash === -1 ? rest : rest.slice(0, slash))
			}
		}
		return [...names]
	}
	resolvePath(base: string, path: string) {
		if (path.charAt(0) === '/') return path
		return (base === '/' ? '' : base) + '/' + path
	}
}

function makeCtx(fs: FakeFs, stdin = '') {
	return { fs, cwd: '/', env: new Map(), stdin } as never
}

async function run(
	tool: 'grep' | 'rg',
	args: string[],
	fs: FakeFs,
	signal?: AbortSignal,
	stdin = '',
) {
	const command = createSearchCommands(signal).find(
		(item) => item.name === tool,
	)
	if (!command) throw new Error('command not found: ' + tool)
	return command.execute(args, makeCtx(fs, stdin))
}

describe('abort-aware search commands', () => {
	it('rg finds a simple pattern in an explicit file', async () => {
		const fs = new FakeFs()
		fs.files.set('/notes/a.md', 'hello world\nsecond line\n')
		const result = await run('rg', ['hello', '/notes/a.md'], fs)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('notes/a.md:hello world')
	})

	it('grep -o emits each match and honours line numbers', async () => {
		const fs = new FakeFs()
		fs.files.set('/notes/a.md', 'a needle b\nc needle d\n')
		const result = await run('grep', ['-n', '-o', 'needle', '/notes/a.md'], fs)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('notes/a.md:1:needle')
		expect(result.stdout).toContain('notes/a.md:2:needle')
	})

	it('finds a match crossing a chunk boundary without duplication', async () => {
		const fs = new FakeFs()
		const padding = 'x'.repeat(128 * 1024 - 10)
		fs.files.set('/notes/big.txt', padding + 'NEEDLE' + 'tail')
		const result = await run('rg', ['-o', 'NEEDLE', '/notes/big.txt'], fs)
		expect(result.exitCode).toBe(0)
		expect(result.stdout.split('\n').filter(Boolean)).toHaveLength(1)
	})

	it('fails fast on a large file with a variable-context pattern', async () => {
		const fs = new FakeFs()
		fs.files.set('/notes/large.txt', 'x'.repeat(600 * 1024))
		const result = await run(
			'rg',
			['.{0,60}needle.{0,120}', '/notes/large.txt'],
			fs,
		)
		expect(result.exitCode).toBe(2)
		expect(result.stderr).toContain('TOOL_RESOURCE_EXCEEDED')
	})

	it('still allows a simple pattern on a moderately large file', async () => {
		const fs = new FakeFs()
		fs.files.set('/notes/large.txt', 'x'.repeat(600 * 1024) + 'needle')
		const result = await run('rg', ['needle', '/notes/large.txt'], fs)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('needle')
	})

	it('returns the abort exit code once the signal is aborted', async () => {
		const fs = new FakeFs()
		fs.files.set('/notes/a.md', 'needle\n')
		const controller = new AbortController()
		controller.abort()
		const result = await run(
			'rg',
			['needle', '/notes/a.md'],
			fs,
			controller.signal,
		)
		expect(result.exitCode).toBe(130)
	})
})

import { Bash, InMemoryFs } from 'just-bash/browser'

describe('just-bash integration for the real device timeout scripts', () => {
	it('fails fast on the 51s rg script instead of scanning 7.4 MB line-by-line', async () => {
		const payload = 'x'.repeat(3_000_000) + 'webSearch' + 'y'.repeat(4_000_000)
		const fs = new InMemoryFs({ '/main.js': payload })
		const bash = new Bash({ fs, customCommands: createSearchCommands() })
		const startedAt = Date.now()
		const result = await bash.exec('rg -n -o ".{60}webSearch.{60}" /main.js')
		const elapsed = Date.now() - startedAt
		expect(elapsed).toBeLessThan(2000)
		expect(result.stderr).toContain('TOOL_RESOURCE_EXCEEDED')
	})

	it('fails fast on the 74s grep script instead of running a variable-width regex', async () => {
		const payload = 'x'.repeat(3_000_000) + 'web_search' + 'y'.repeat(4_000_000)
		const fs = new InMemoryFs({ '/main.js': payload })
		const bash = new Bash({ fs, customCommands: createSearchCommands() })
		const startedAt = Date.now()
		const result = await bash.exec(
			'grep -o ".\\{0,60\\}web_search.\\{0,120\\}" /main.js',
		)
		const elapsed = Date.now() - startedAt
		expect(elapsed).toBeLessThan(2000)
		expect(result.stderr).toContain('TOOL_RESOURCE_EXCEEDED')
	})

	it('still allows the same file with a simple alternation pattern', async () => {
		const payload = 'x'.repeat(2_000_000) + 'web_search' + 'y'.repeat(2_000_000)
		const fs = new InMemoryFs({ '/main.js': payload })
		const bash = new Bash({ fs, customCommands: createSearchCommands() })
		const startedAt = Date.now()
		const result = await bash.exec('rg -c -o "webSearch|web_search" /main.js')
		const elapsed = Date.now() - startedAt
		expect(elapsed).toBeLessThan(3000)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('main.js:')
	})
})
