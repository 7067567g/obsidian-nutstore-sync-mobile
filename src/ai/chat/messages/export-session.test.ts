import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TFile } from 'obsidian'
import { writeLocalText } from '~/utils/local-vault-io'
import { projectTimelineMessageGroups } from '~/ai/chat/ui/display-blocks'
import { getUserContextItems } from '~/ai/chat/messages/ui-message'
import {
	exportSessionToMarkdownFile,
	sanitizeExportFileName,
} from './export-session'

vi.mock('obsidian', () => {
	class TFile {
		path: string
		constructor(path = '') {
			this.path = path
		}
	}
	class Vault {}
	return {
		TFile,
		Vault,
		normalizePath: (path: string) =>
			path
				.replace(/\\/g, '/')
				.replace(/\/+/g, '/')
				.replace(/^\/+/, '')
				.replace(/\/+$/, ''),
		requestUrl: () => {
			throw new Error('requestUrl is not available in unit tests')
		},
	}
})

vi.mock('~/ai/chat/domain', () => ({
	getMasterAgent: () => ({ timeline: [], toolTimings: {} }),
}))

vi.mock('~/ai/chat/ui/display-blocks', () => ({
	projectTimelineMessageGroups: vi.fn(() => []),
}))

vi.mock('~/ai/chat/messages/ui-message', () => ({
	getUserContextItems: vi.fn(() => []),
}))

vi.mock('~/ai/chat/context/user-context', () => ({
	formatUserContext: () => '',
}))

vi.mock('~/ai/chat/messages/message-utils', () => ({
	imageFilePartSrc: () => undefined,
	isImageFilePart: () => false,
}))

vi.mock('~/i18n', () => ({
	default: {
		t: vi.fn((key: string) =>
			key.startsWith('chatbox.exportFrontmatter.')
				? `本地化-${key.split('.').pop()}`
				: (key.split('.').pop() ?? key),
		),
	},
}))

vi.mock('~/utils/local-vault-io', () => ({
	writeLocalBinary: vi.fn(),
	writeLocalText: vi.fn(),
}))

vi.mock('~/utils/mkdirs-vault', () => ({ mkdirsVault: vi.fn() }))

vi.mock('~/utils/logger', () => ({ default: { warn: vi.fn() } }))

vi.mock('~/utils/format-duration', () => ({ formatDuration: () => '' }))

type ExportParams = Parameters<typeof exportSessionToMarkdownFile>[0]

function createFakeVault() {
	const existing = new Set<string>()
	const vault = {
		existing,
		getAbstractFileByPath: (path: string) =>
			existing.has(path) ? Object.assign(new TFile(), { path }) : undefined,
	}
	return { existing, vault }
}

function createParams(vault: unknown, title: string): ExportParams {
	return {
		vault,
		manifestId: 'manifest',
		manifestVersion: '1.0.0',
		session: { id: 'session-1', createdAt: 0, updatedAt: 0 },
		title,
		includeToolMessages: true,
	} as unknown as ExportParams
}

function mockWriteRecordingToVault() {
	vi.mocked(writeLocalText).mockImplementation(async (vault, path) => {
		const fake = vault as unknown as { existing: Set<string> }
		fake.existing.add(path)
	})
}

describe('sanitizeExportFileName', () => {
	it('replaces path separators and reserved characters', () => {
		expect(sanitizeExportFileName('a/b\\c:d*e?f"g<h>i|j')).toBe(
			'a-b-c-d-e-f-g-h-i-j',
		)
	})

	it('collapses whitespace and strips leading/trailing dots and spaces', () => {
		expect(sanitizeExportFileName('  ..my   note...  ')).toBe('my note')
	})

	it('falls back to the default name when nothing usable remains', () => {
		expect(sanitizeExportFileName('   ')).toBe('chat-session')
		expect(sanitizeExportFileName('...')).toBe('chat-session')
	})

	it('truncates on a UTF-8 byte boundary without splitting a code point', () => {
		const result = sanitizeExportFileName('中'.repeat(100))
		expect(result).toBe('中'.repeat(66))
		expect(new TextEncoder().encode(result).byteLength).toBe(198)
	})
})

describe('exportSessionToMarkdownFile', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2024-02-29T10:11:12'))
		vi.mocked(writeLocalText).mockReset()
		vi.mocked(projectTimelineMessageGroups).mockReset()
		vi.mocked(projectTimelineMessageGroups).mockReturnValue([])
		vi.mocked(getUserContextItems).mockReset()
		vi.mocked(getUserContextItems).mockReturnValue([])
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('writes the session markdown into the manifest conversations directory', async () => {
		const { vault } = createFakeVault()
		mockWriteRecordingToVault()

		const file = await exportSessionToMarkdownFile(
			createParams(vault, 'My Note'),
		)

		expect(file).toBeInstanceOf(TFile)
		expect(file.path).toBe(
			'manifest/conversations/My Note-2024-02-29-10-11-12.md',
		)
		const [, path, markdown] = vi.mocked(writeLocalText).mock.calls[0]
		expect(path).toBe(file.path)
		expect(markdown).toContain('# My Note')
		expect(markdown).toContain('includeToolMessages: true')
	})

	it('sanitizes the title before using it as the file name', async () => {
		const { vault } = createFakeVault()
		mockWriteRecordingToVault()

		const file = await exportSessionToMarkdownFile(createParams(vault, 'a/b:c'))

		expect(file.path).toBe(
			'manifest/conversations/a-b-c-2024-02-29-10-11-12.md',
		)
	})

	it('resolves a unique path when the base file name already exists', async () => {
		const { existing, vault } = createFakeVault()
		existing.add('manifest/conversations/My Note-2024-02-29-10-11-12.md')
		mockWriteRecordingToVault()

		const file = await exportSessionToMarkdownFile(
			createParams(vault, 'My Note'),
		)

		expect(file.path).toBe(
			'manifest/conversations/My Note-2024-02-29-10-11-12-2.md',
		)
	})

	it('throws when the written file cannot be located', async () => {
		const { vault } = createFakeVault()
		vi.mocked(writeLocalText).mockResolvedValue(undefined)

		await expect(
			exportSessionToMarkdownFile(createParams(vault, 'My Note')),
		).rejects.toThrow('Unable to locate exported file')
	})

	it('keeps frontmatter keys stable when UI strings are localized', async () => {
		const { vault } = createFakeVault()
		mockWriteRecordingToVault()
		await exportSessionToMarkdownFile(createParams(vault, 'My Note'))

		const markdown = vi.mocked(writeLocalText).mock.calls[0][2]
		expect(markdown).toContain('title: ')
		expect(markdown).toContain('sessionId: ')
		expect(markdown).toContain('includeToolMessages: true')
		expect(markdown).not.toContain('本地化-title')
	})

	it('truncates oversized file context without splitting a UTF-8 code point', async () => {
		const { vault } = createFakeVault()
		mockWriteRecordingToVault()
		vi.mocked(projectTimelineMessageGroups).mockReturnValue([
			{
				message: { role: 'user', parts: [], metadata: { createdAt: 0 } },
				blocks: [],
			},
		] as never)
		const prefix = 'a'.repeat(64 * 1024 - 1)
		const bytes = new TextEncoder().encode(`${prefix}中`)
		vi.mocked(getUserContextItems).mockReturnValue([
			{
				type: 'file',
				filename: 'big.txt',
				mimeType: 'text/plain',
				size: bytes.byteLength,
				blob: new Blob([bytes], { type: 'text/plain' }),
			},
		] as never)

		await exportSessionToMarkdownFile(createParams(vault, 'My Note'))

		const markdown = vi.mocked(writeLocalText).mock.calls[0][2]
		expect(markdown).not.toContain('\uFFFD')
		expect(markdown).toContain('"truncated": true')
		expect(markdown).toContain(prefix)
	})

	it('fails fast when every candidate export path already exists', async () => {
		const vault = {
			getAbstractFileByPath: () =>
				Object.assign(new TFile(), { path: 'taken.md' }),
		}
		mockWriteRecordingToVault()

		await expect(
			exportSessionToMarkdownFile(createParams(vault, 'My Note')),
		).rejects.toThrow('Unable to resolve a unique export path')
		expect(writeLocalText).not.toHaveBeenCalled()
	})
})
