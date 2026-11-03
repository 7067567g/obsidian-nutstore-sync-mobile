import { describe, expect, it } from 'vitest'
import {
	compileFilterRules,
	type GlobFilterRule,
	isPathIncluded,
} from './glob-match'
import { GLOBSTAR_CASES } from './gitignore-oracle-cases'

describe('Git-generated filter-rule oracle: globstar', () => {
	it.each(GLOBSTAR_CASES)('$name: $path -> included=$included', (testCase) => {
		const rules: GlobFilterRule[] = testCase.rules.map((candidate) => ({
			...candidate,
			options: { caseSensitive: testCase.caseSensitive },
		}))
		expect(
			isPathIncluded(testCase.path, compileFilterRules(rules), testCase.isDir),
		).toBe(testCase.included)
	})
})
