import { describe, expect, it } from 'vitest'
import {
	resolveByIntelligentMerge,
	type IntelligentMergeParams,
} from './merge-utils'
import { expectAutoMerged } from './merge-utils.fixtures'

describe('resolveByIntelligentMerge', () => {
	// --- 内容一致 ---
	it('情况 1.1: 本地与远程内容一致，应成功且标记为相同', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'line1\nline2',
			localContentText: 'line1\nline2\nline3',
			remoteContentText: 'line1\nline2\nline3',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.isIdentical).toBe(true)
	})

	// --- node-diff3 成功合并 ---
	it('情况 2.1: 本地新增，远程不变 (node-diff3)，应成功合并', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'a\nb',
			localContentText: 'a\nb\nc',
			remoteContentText: 'a\nb',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe('a\nb\nc')
	})

	it('情况 2.2: 远程删除，本地不变 (node-diff3)，应成功合并', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'a\nb\nc',
			localContentText: 'a\nb\nc',
			remoteContentText: 'a\nc',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe('a\nc')
	})

	it('情况 2.3: 本地修改，远程不变 (node-diff3)，应成功合并', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'hello world',
			localContentText: 'hello universe',
			remoteContentText: 'hello world',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe('hello universe')
	})

	it('情况 2.4: 并发无重叠修改 (node-diff3)，应成功合并', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'line1\nline2\nline3\nline4',
			localContentText: 'line1-local\nline2\nline3\nline4',
			remoteContentText: 'line1\nline2\nline3\nline4-remote',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe('line1-local\nline2\nline3\nline4-remote')
	})

	it('情况 2.5: 本地在开头修改 (node-diff3)，应成功合并', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'original line',
			localContentText: 'new first line\noriginal line',
			remoteContentText: 'original line',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe('new first line\noriginal line')
	})

	it('情况 2.6: 远程在末尾修改 (node-diff3)，应成功合并', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'original line',
			localContentText: 'original line',
			remoteContentText: 'original line\nnew last line',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.mergedText).toBe('original line\nnew last line')
	})

	// --- Yjs 自动合并 ---
	it('情况 4.1: 双方修改同一行时生成无冲突标记的结果', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'line1\nconflicting_line_base\nline3',
			localContentText: 'line1\nconflicting_line_local_change_A\nline3',
			remoteContentText: 'line1\nconflicting_line_remote_change_B\nline3',
		}
		const result = await resolveByIntelligentMerge(params)
		expectAutoMerged(result, params, ['line1', 'line3'])
	})

	// --- 内容边缘情况 ---
	it('情况 5.1: 基础内容为空时合并双方插入', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: '',
			localContentText: 'local only content',
			remoteContentText: 'remote only content',
		}
		const result = await resolveByIntelligentMerge(params)
		expectAutoMerged(result, params, [
			'local only content',
			'remote only content',
		])
		expect(result.mergedText).toContain('local only content')
		expect(result.mergedText).toContain('remote only content')
	})

	it('情况 5.1b: 基础内容为空，本地与远程内容相同', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: '',
			localContentText: 'same content',
			remoteContentText: 'same content',
		}
		// local and remote are identical, so it's not a merge conflict, it's just identical.
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.isIdentical).toBe(true)
	})

	it('情况 5.2: 本地删除全部内容且远程新增时自动合并', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: 'some base content\nshared line',
			localContentText: '', // Local deleted everything
			remoteContentText: 'some base content\nshared line\nremote additions', // Remote kept base and added
		}
		const result = await resolveByIntelligentMerge(params)
		expectAutoMerged(result, params, ['remote additions'])
		expect(result.mergedText).toContain('remote additions')
	})

	it('情况 5.3: 所有内容均为空', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: '',
			localContentText: '',
			remoteContentText: '',
		}
		const result = await resolveByIntelligentMerge(params)
		expect(result.success).toBe(true)
		expect(result.isIdentical).toBe(true)
	})

	it('情况 5.4: base 缺失时智能合并保留两侧内容', async () => {
		const params: IntelligentMergeParams = {
			baseContentText: '',
			localContentText: '本地独有的段落\n共享段落',
			remoteContentText: '远程独有的段落\n共享段落',
			hasBase: false,
		}
		const result = await resolveByIntelligentMerge(params)
		expectAutoMerged(result, params, [
			'本地独有的段落',
			'远程独有的段落',
			'共享段落',
		])
		expect(result.mergedText).toContain('本地独有的段落')
		expect(result.mergedText).toContain('远程独有的段落')
		expect(result.mergedText).toContain('共享段落')
	})
})
