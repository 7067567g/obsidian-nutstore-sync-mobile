import { describe, expect, it } from 'vitest'
import { resolveByIntelligentMerge } from './merge-utils'

describe('resolveByIntelligentMerge JSON', () => {
	it('合并中英文嵌套修改并识别本地删除', async () => {
		const result = await resolveByIntelligentMerge({
			filePath: 'settings/example.json',
			baseContentText: JSON.stringify({
				label: 'Original',
				editor: { fontSize: 14, lineHeight: 1.5 },
				obsolete: true,
				items: ['甲', '乙'],
			}),
			localContentText: JSON.stringify({
				label: '本地版本',
				editor: { fontSize: 16, lineHeight: 1.5 },
				items: ['甲'],
			}),
			remoteContentText: JSON.stringify({
				label: 'Remote version',
				editor: { fontSize: 14, lineHeight: 1.8 },
				obsolete: true,
				items: ['甲', '乙'],
				remoteOnly: '保留',
			}),
		})

		expect(result.success).toBe(true)
		expect(JSON.parse(result.mergedText!)).toEqual({
			label: '本地版本',
			editor: { fontSize: 16, lineHeight: 1.8 },
			items: ['甲'],
			remoteOnly: '保留',
		})
	})

	it('远程删除未被本地修改的键', async () => {
		const result = await resolveByIntelligentMerge({
			filePath: 'settings/example.json',
			baseContentText: '{"enabled":true,"mode":"standard"}',
			localContentText: '{"enabled":true,"mode":"standard"}',
			remoteContentText: '{"mode":"standard"}',
		})

		expect(JSON.parse(result.mergedText!)).toEqual({ mode: 'standard' })
	})

	it('缺少 base 时以远程为底并递归覆盖本地值', async () => {
		const result = await resolveByIntelligentMerge({
			filePath: 'settings/example.json',
			hasBase: false,
			baseContentText: '',
			localContentText: JSON.stringify({
				localOnly: '本地',
				options: { shared: '本地值' },
			}),
			remoteContentText: JSON.stringify({
				remoteOnly: 'Remote',
				options: { shared: 'remote value', retained: true },
			}),
		})

		expect(JSON.parse(result.mergedText!)).toEqual({
			localOnly: '本地',
			remoteOnly: 'Remote',
			options: { shared: '本地值', retained: true },
		})
	})

	it('递归合并双方新增的对象键，冲突数组采用本地值', async () => {
		const result = await resolveByIntelligentMerge({
			filePath: 'settings/example.json',
			baseContentText: '{}',
			localContentText: JSON.stringify({
				options: { local: '本地' },
				order: ['一', '二'],
			}),
			remoteContentText: JSON.stringify({
				options: { remote: 'Remote' },
				order: ['二', '一'],
			}),
		})

		expect(JSON.parse(result.mergedText!)).toEqual({
			options: { local: '本地', remote: 'Remote' },
			order: ['一', '二'],
		})
	})

	it('JSON 解析失败时降级为普通文本合并', async () => {
		const result = await resolveByIntelligentMerge({
			filePath: 'settings/example.json',
			baseContentText: 'entry = base',
			localContentText: 'local entry = base',
			remoteContentText: 'entry = base remote',
		})

		expect(result.success).toBe(true)
		expect(result.mergedText).toBe('local entry = base remote')
	})

	it('保留本地 JSON 的缩进与末尾换行', async () => {
		const result = await resolveByIntelligentMerge({
			filePath: 'settings/example.json',
			baseContentText: '{\n  "本地": 1,\n  "remote": 1\n}\n',
			localContentText: '{\n  "本地": 2,\n  "remote": 1\n}\n',
			remoteContentText: '{\n  "本地": 1,\n  "remote": 2\n}\n',
		})

		expect(result.mergedText).toBe('{\n  "本地": 2,\n  "remote": 2\n}\n')
	})
})
