import { describe, expect, it } from 'vitest'
import {
	compileFilterRules,
	type GlobFilterRule,
	isPathIncluded,
} from './glob-match'
import { REINCLUSION_CASES } from './gitignore-oracle-cases'

describe('Git-generated filter-rule oracle: re-inclusion', () => {
	it.each(REINCLUSION_CASES)(
		'$name: $path -> included=$included',
		(testCase) => {
			const rules: GlobFilterRule[] = testCase.rules.map((candidate) => ({
				...candidate,
				options: { caseSensitive: testCase.caseSensitive },
			}))
			expect(
				isPathIncluded(
					testCase.path,
					compileFilterRules(rules),
					testCase.isDir,
				),
			).toBe(testCase.included)
		},
	)
})
