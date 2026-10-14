import { describe, expect, it } from 'vitest'
import {
compileFilterRules,
type GlobFilterRule,
isPathIncluded,
} from './filter-rules'

const opt = { caseSensitive: false } as const

const rule = (
expr: string,
type: GlobFilterRule['type'] = 'exclude',
): GlobFilterRule => ({ expr, options: opt, type })

const packagesRules: GlobFilterRule[] = [
rule('**'),
rule('packages/', 'include'),
rule('packages/**', 'include'),
rule('说明.md', 'include'),
rule('知识库关系图谱.md', 'include'),
rule('ChatBox 手册.md', 'include'),
rule('知识库关系图谱.canvas', 'include'),
]

const decide = (path: string, isDir = path.endsWith('/')) =>
isPathIncluded(path, compileFilterRules(packagesRules), isDir)

describe('package-sync filter rules', () => {
it.each([
['deepseek-知识库/', true],
['deepseek-知识库/README.md', false],
['归档/', true],
['归档/x.zip', false],
['工具/', true],
['附件/', true],
['日记/', true],
['dev/', true],
['dev/null', false],
] as const)('exclude ** covers root-level and nested items: %s', (path, isDir) => {
expect(decide(path, isDir)).toBe(false)
})

it.each([
['说明.md', false],
['知识库关系图谱.md', false],
['ChatBox 手册.md', false],
['知识库关系图谱.canvas', false],
] as const)('root navigation notes are included: %s', (path) => {
expect(decide(path)).toBe(true)
})

it.each([
['packages/', true],
['packages/README.md', false],
['packages/deepseek-知识库/foo.zip', false],
] as const)('packages tree is included: %s', (path, isDir) => {
expect(decide(path, isDir)).toBe(true)
})
})
