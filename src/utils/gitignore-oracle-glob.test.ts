import { describe, expect, it } from 'vitest'
import {
	compileFilterRules,
	type GlobFilterRule,
	isPathIncluded,
} from './glob-match'
import { GLOB_OP_CASES } from './gitignore-oracle-cases'

describe('Git-generated filter-rule oracle: glob operators', () => {
	it.each(GLOB_OP_CASES)('$name: $path -> included=$included', (testCase) => {
		const rules: GlobFilterRule[] = testCase.rules.map((candidate) => ({
			...candidate,
			options: { caseSensitive: testCase.caseSensitive },
		}))
		expect(
			isPathIncluded(testCase.path, compileFilterRules(rules), testCase.isDir),
		).toBe(testCase.included)
	})
})
