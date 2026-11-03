import { Buffer } from 'buffer' // Import Buffer for explicit Buffer testing
import { describe, expect, it } from 'vitest'
import {
	LatestTimestampResolution,
	resolveByDiff3Merge,
	resolveByLatestTimestamp,
	type LatestTimestampParams,
} from './merge-utils'

describe('resolveByDiff3Merge', () => {
	it('merges independent English edits without conflict markers', () => {
		const result = resolveByDiff3Merge({
			baseContentText: 'Title\nShared line\nSummary',
			localContentText: 'Updated title\nShared line\nSummary',
			remoteContentText: 'Title\nShared line\nUpdated summary',
		})

		expect(result.mergedText).toBe(
			'Updated title\nShared line\nUpdated summary',
		)
	})

	it('为中文冲突生成 Git diff3 风格标记', () => {
		const result = resolveByDiff3Merge({
			baseContentText: '标题\n原始内容\n结尾',
			localContentText: '标题\n本地内容\n结尾',
			remoteContentText: '标题\n服务器内容\n结尾',
		})

		expect(result.mergedText).toContain('<<<<<<< LOCAL\n本地内容')
		expect(result.mergedText).toContain('||||||| BASE\n原始内容')
		expect(result.mergedText).toContain('=======\n服务器内容')
		expect(result.mergedText).toContain('>>>>>>> REMOTE')
	})

	it('base 缺失时保留两侧内容而非静默丢弃本地', () => {
		const result = resolveByDiff3Merge({
			baseContentText: '',
			localContentText: '本地内容\n第二行',
			remoteContentText: '远程内容\n第二行',
		})

		expect(result.success).toBe(true)
		expect(result.mergedText).toContain('<<<<<<< LOCAL\n本地内容')
		expect(result.mergedText).toContain('||||||| BASE')
		expect(result.mergedText).toContain('=======\n远程内容')
		expect(result.mergedText).toContain('>>>>>>> REMOTE')
	})

	it('base 缺失且本地已删除全部内容时不含冲突标记', () => {
		const result = resolveByDiff3Merge({
			baseContentText: '',
			localContentText: '',
			remoteContentText: '远程内容\n第二行',
		})

		expect(result.success).toBe(true)
		expect(result.mergedText).toBe('远程内容\n第二行')
		expect(result.mergedText).not.toContain('<<<<<<<')
	})
})

describe('resolveByLatestTimestamp', () => {
	// --- 无更改 ---
	it('情况 1.1: 时间戳相同，应无更改', () => {
		const params: LatestTimestampParams = {
			localMtime: 1000,
			remoteMtime: 1000,
			localContent: Buffer.from('abc'),
			remoteContent: Buffer.from('abc'),
		}
		const result = resolveByLatestTimestamp(params)
		expect(result.status).toBe(LatestTimestampResolution.NoChange)
	})

	it('情况 1.2: 远程较新但内容相同，应无更改', () => {
		const params: LatestTimestampParams = {
			localMtime: 1000,
			remoteMtime: 1001,
			localContent: Buffer.from('abc'),
			remoteContent: Buffer.from('abc'),
		}
		const result = resolveByLatestTimestamp(params)
		expect(result.status).toBe(LatestTimestampResolution.NoChange)
	})

	it('情况 1.3: 本地较新但内容相同，应无更改', () => {
		const params: LatestTimestampParams = {
			localMtime: 1001,
			remoteMtime: 1000,
			localContent: Buffer.from('abc'),
			remoteContent: Buffer.from('abc'),
		}
		const result = resolveByLatestTimestamp(params)
		expect(result.status).toBe(LatestTimestampResolution.NoChange)
	})

	// --- 使用远程版本 ---
	it('情况 2.1: 远程较新且内容不同，应使用远程版本', () => {
		const params: LatestTimestampParams = {
			localMtime: 1000,
			remoteMtime: 1001,
			localContent: Buffer.from('abc'),
			remoteContent: Buffer.from('abcd'),
		}
		const result = resolveByLatestTimestamp(params)
		expect(result.status).toBe(LatestTimestampResolution.UseRemote)
		if (result.status === LatestTimestampResolution.UseRemote) {
			expect(result.content).toEqual(Buffer.from('abcd'))
		}
	})

	it('情况 2.2: 远程较新，Buffer 内容不同，应使用远程版本', () => {
		const params: LatestTimestampParams = {
			localMtime: 1000,
			remoteMtime: 1001,
			localContent: Buffer.from('binarydata1'),
			remoteContent: Buffer.from('binarydata2'),
		}
		const result = resolveByLatestTimestamp(params)
		expect(result.status).toBe(LatestTimestampResolution.UseRemote)
		if (result.status === LatestTimestampResolution.UseRemote) {
			expect(result.content).toEqual(Buffer.from('binarydata2'))
		}
	})

	// --- 使用本地版本 ---
	it('情况 3.1: 本地较新且内容不同，应使用本地版本', () => {
		const params: LatestTimestampParams = {
			localMtime: 1001,
			remoteMtime: 1000,
			localContent: Buffer.from('xyz'),
			remoteContent: Buffer.from('xy'),
		}
		const result = resolveByLatestTimestamp(params)
		expect(result.status).toBe(LatestTimestampResolution.UseLocal)
		if (result.status === LatestTimestampResolution.UseLocal) {
			expect(result.content).toEqual(Buffer.from('xyz'))
		}
	})

	it('情况 3.2: 本地较新，Buffer 内容不同，应使用本地版本', () => {
		const params: LatestTimestampParams = {
			localMtime: 1001,
			remoteMtime: 1000,
			localContent: Buffer.from('localbinary'),
			remoteContent: Buffer.from('remotebinary'),
		}
		const result = resolveByLatestTimestamp(params)
		expect(result.status).toBe(LatestTimestampResolution.UseLocal)
		if (result.status === LatestTimestampResolution.UseLocal) {
			expect(result.content).toEqual(Buffer.from('localbinary'))
		}
	})
})
