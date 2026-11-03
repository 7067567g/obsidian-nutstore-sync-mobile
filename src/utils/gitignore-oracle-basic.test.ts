import { describe, expect, it } from 'vitest'
import {
	compileFilterRules,
	type GlobFilterRule,
	isPathIncluded,
} from './glob-match'
import { BASIC_ENV_CASES } from './gitignore-oracle-cases'

describe('Git-generated filter-rule oracle: basic and environment semantics', () => {
	it.each(BASIC_ENV_CASES)('$name: $path -> included=$included', (testCase) => {
		const rules: GlobFilterRule[] = testCase.rules.map((candidate) => ({
			...candidate,
			options: { caseSensitive: testCase.caseSensitive },
		}))
		expect(
			isPathIncluded(testCase.path, compileFilterRules(rules), testCase.isDir),
		).toBe(testCase.included)
	})
})
