import { describe, expect, it, vi } from 'vitest'
import {
	MAX_REVERSIBLE_SNAPSHOT_BYTES,
	MAX_REVERSIBLE_SNAPSHOT_ENTRIES,
	ReversibleFs,
} from './reversible-fs'
import { isSkippedFileSnapshot } from '~/ai/chat/messages/reversible-content'

interface FakeStat {
	isDirectory: boolean
	size: number
}

class FakeFs {
	readonly files = new Map<string, Uint8Array>()
	readonly dirs = new Set<string>()

	async exists(path: string) {
		return this.files.has(path) || this.dirs.has(path)
	}

	async stat(path: string): Promise<FakeStat> {
		if (this.dirs.has(path)) return { isDirectory: true, size: 0 }
		const content = this.files.get(path)
		if (content) return { isDirectory: false, size: content.byteLength }
		throw new Error(`ENOENT: ${path}`)
	}

	async readdir(path: string) {
		const prefix = path === '/' ? '/' : `${path}/`
		const names = new Set<string>()
		for (const candidate of [...this.files.keys(), ...this.dirs]) {
			if (!candidate.startsWith(prefix) || candidate === path) continue
			const rest = candidate.slice(prefix.length)
			const [name] = rest.split('/')
			if (name) names.add(name)
		}
		return [...names]
	}

	async readFileBuffer(path: string) {
		const content = this.files.get(path)
		if (!content) throw new Error(`ENOENT: ${path}`)
		return content
	}

	async writeFile(path: string, content: string | Uint8Array) {
		this.files.set(
			path,
			typeof content === 'string' ? new TextEncoder().encode(content) : content,
		)
	}

	async rm(path: string, options?: { recursive?: boolean }) {
		if (this.files.delete(path)) return
		if (!options?.recursive) {
			this.dirs.delete(path)
			return
		}
		const prefix = `${path}/`
		for (const candidate of [...this.files.keys()]) {
			if (candidate.startsWith(prefix)) this.files.delete(candidate)
		}
		for (const candidate of [...this.dirs]) {
			if (candidate === path || candidate.startsWith(prefix)) {
				this.dirs.delete(candidate)
			}
		}
	}
}

function createHarness() {
	const inner = new FakeFs()
	const transitions: Array<{
		path: string
		before: unknown
		after: unknown
	}> = []
	const recorder = {
		beginCapture: vi.fn(),
		endCapture: vi.fn(),
		recordVirtualTransition: vi.fn(
			(path: string, before: unknown, after: unknown) => {
				transitions.push({ path, before, after })
			},
		),
	}
	const fs = new ReversibleFs(inner as never, recorder as never, {
		absoluteMountPoints: [],
	})
	return { inner, transitions, fs }
}

describe('ReversibleFs snapshot budget', () => {
	it('does not expose readdirWithFileTypes when the inner fs lacks it', () => {
		const { fs } = createHarness()
		expect(
			(fs as unknown as { readdirWithFileTypes?: unknown })
				.readdirWithFileTypes,
		).toBeUndefined()
	})

	it('compresses a small file snapshot normally', async () => {
		const { inner, transitions, fs } = createHarness()
		inner.files.set('/note.md', new TextEncoder().encode('old'))
		await fs.writeFile('/note.md', 'new')

		const transition = transitions.find((item) => item.path === 'note.md')
		expect(transition).toBeDefined()
		expect(
			isSkippedFileSnapshot(
				transition?.before as Parameters<typeof isSkippedFileSnapshot>[0],
			),
		).toBe(false)
	})

	it('skips content above the per-file snapshot budget', async () => {
		const { inner, transitions, fs } = createHarness()
		inner.files.set(
			'/big.bin',
			new Uint8Array(MAX_REVERSIBLE_SNAPSHOT_BYTES + 1),
		)
		await fs.writeFile('/big.bin', 'small replacement')

		const transition = transitions.find((item) => item.path === 'big.bin')
		const before = transition?.before as Parameters<
			typeof isSkippedFileSnapshot
		>[0]
		expect(isSkippedFileSnapshot(before)).toBe(true)
		expect(before.skipped?.reason).toBe('too-large')
	})

	it('marks a directory skipped after the entry budget is exhausted', async () => {
		const { inner, transitions, fs } = createHarness()
		inner.dirs.add('/large-dir')
		for (
			let index = 0;
			index < MAX_REVERSIBLE_SNAPSHOT_ENTRIES + 5;
			index += 1
		) {
			inner.files.set(
				`/large-dir/file-${index}.txt`,
				new TextEncoder().encode('x'),
			)
		}
		await fs.rm('/large-dir', { recursive: true })

		const transition = transitions.find((item) => item.path === 'large-dir')
		expect(transition).toBeDefined()
		const before = transition?.before as { kind?: string; skipped?: unknown }
		expect(before.kind).toBe('dir')
		expect(before.skipped).toMatchObject({ reason: 'entry-budget' })
	})
})
