import { VAULT_GREP_MAX_PATTERN_LENGTH } from './vault-grep-constants'

/**
 * The two narrow shapes we have proven safe by construction. Everything else
 * with a nested quantifier is refused: JavaScript regex evaluation cannot be
 * preempted, so the guard must stay conservative rather than trying to model
 * every backtracking interaction.
 *
 * 1. `^(\w+\.)+\w+$`-style groups: an inner unbounded quantifier followed
 *    by a mandatory literal separator.
 * 2. `^\d+(\.\d+)?$`-style optional groups: an optional group that is not
 *    itself repeated.
 */
const SAFE_NESTED_QUANTIFIER_PATTERNS = [
	/^\^\(\\[dDwWsS]\+\\\.\)\+\\[dDwWsS]\+\$$/,
	/^\^\\[dDwWsS]\+\(\\\.\\[dDwWsS]\+\)\?\$$/,
]

function isWhitelistedSafePattern(pattern: string) {
	return SAFE_NESTED_QUANTIFIER_PATTERNS.some((candidate) =>
		candidate.test(pattern),
	)
}

interface RegexGroupSpan {
	start: number
	end: number
	parentStart?: number
	/** Infinity for `*`/`+`/`{m,}`; 1 for `?`/`{0,1}`. */
	maxRepeats?: number
}

function readRepeatMax(pattern: string, index: number): number | undefined {
	const ch = pattern[index]
	if (ch === '*' || ch === '+') return Number.POSITIVE_INFINITY
	if (ch === '?') return 1
	if (ch !== '{') return undefined
	const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index))
	if (!match) return undefined
	if (match[2] === undefined) return Number(match[1])
	return match[3] === '' ? Number.POSITIVE_INFINITY : Number(match[3])
}

/** Collect every group span (any nesting) and the quantifier applied to it. */
function findGroupSpans(pattern: string): RegexGroupSpan[] {
	const stack: number[] = []
	const spans: RegexGroupSpan[] = []
	for (let index = 0; index < pattern.length; index += 1) {
		const ch = pattern[index]
		if (ch === '\\') {
			index += 1
			continue
		}
		if (ch === '[') {
			index += 1
			while (index < pattern.length && pattern[index] !== ']') {
				if (pattern[index] === '\\') index += 1
				index += 1
			}
			continue
		}
		if (ch === '(') {
			stack.push(index)
			continue
		}
		if (ch !== ')') continue
		const start = stack.pop()
		if (start === undefined) continue
		spans.push({
			start,
			end: index,
			parentStart: stack[stack.length - 1],
			maxRepeats: readRepeatMax(pattern, index + 1),
		})
	}
	return spans
}

/**
 * True if a group body contains a quantifier that can consume a variable
 * number of characters at any depth.
 *
 * This intentionally covers more than `*`/`+`/`{m,}`: a bounded-but-variable
 * quantifier like `{1,3}` inside a repeated group also creates combinatorial
 * backtracking (`((a{1,3}))+b` is catastrophic even though `{1,3}` has an
 * upper bound). Exact-length `{m}` / `{m,m}` stays allowed because it gives a
 * fixed partition. `?` matters when it is a real quantifier; the `?` that
 * starts a group prefix (`(?:`, `(?=`, ...) is skipped.
 */
function bodyHasVariableQuantifier(body: string): boolean {
	for (let index = 0; index < body.length; index += 1) {
		const ch = body[index]
		if (ch === '\\') {
			index += 1
			continue
		}
		if (ch === '[') {
			index += 1
			while (index < body.length && body[index] !== ']') {
				if (body[index] === '\\') index += 1
				index += 1
			}
			continue
		}
		if (ch === '*' || ch === '+') return true
		if (ch === '?') {
			// `?` at the start of a group body or directly after an unescaped
			// `(` belongs to `(?:`, `(?=`, `(?<name>` ... and is not a quantifier.
			const previous = body[index - 1]
			const beforePrevious = body[index - 2]
			if (index === 0 || (previous === '(' && beforePrevious !== '\\')) {
				continue
			}
			return true
		}
		if (ch === '{') {
			const match = /^\{(\d+),(\d*)\}/.exec(body.slice(index))
			if (!match) continue
			const lower = Number(match[1])
			const upper =
				match[2] === '' ? Number.POSITIVE_INFINITY : Number(match[2])
			// `{m,}` and `{m,n}` with n > m consume a variable number of
			// characters; `{m}` and `{m,m}` are fixed-length and stay allowed.
			if (upper > lower) return true
		}
	}
	return false
}

/**
 * True when a group with a variable quantifier inside is itself repeated,
 * directly or through any ancestor group. This catches redundant nesting such
 * as `^(((a+)))+b$` or `^((a{1,3}))+b$`, which a flat scan cannot see.
 */
function hasRepeatedVariableQuantifierGroup(pattern: string): boolean {
	const spans = findGroupSpans(pattern)
	const byStart = new Map(spans.map((span) => [span.start, span]))
	for (const span of spans) {
		if (!bodyHasVariableQuantifier(pattern.slice(span.start + 1, span.end))) {
			continue
		}
		let repeated = span.maxRepeats !== undefined && span.maxRepeats > 1
		let parentStart = span.parentStart
		while (parentStart !== undefined) {
			const parent = byStart.get(parentStart)
			if (parent?.maxRepeats !== undefined && parent.maxRepeats > 1) {
				repeated = true
				break
			}
			parentStart = parent?.parentStart
		}
		if (repeated) return true
	}
	return false
}

/**
 * Reject regex shapes that can backtrack catastrophically inside one
 * `regex.test()` call. JavaScript regex evaluation cannot be preempted, so a
 * shape guard is the only hard gate on this path; an unproven refusal is
 * preferable to a multi-second main-thread freeze. Only two narrow
 * separator-bounded shapes are exempted; laziness, nested groups, repeated
 * optional groups, and bounded outer repetition with an unbounded inner
 * quantifier all stay refused.
 */
export function assertSafeGrepPattern(pattern: string) {
	if (pattern.length > VAULT_GREP_MAX_PATTERN_LENGTH) {
		throw new Error(
			'REGEX_TOO_COMPLEX: pattern exceeds ' +
				VAULT_GREP_MAX_PATTERN_LENGTH +
				' characters; narrow the pattern or use desktop MCP.',
		)
	}
	const skeleton = pattern
		.replace(/\\./g, 'x')
		.replace(/\[(?:[^\]\\]|\\.)*\]/g, 'x')
		.replace(/\(\?(?::|=|!|<=|<!)/g, '(')
	const nestedQuantifier =
		/\([^()]*(?:[*+?]|\{\d+,\d*\})[^()]*\)\s*(?:[*+?]|\{\d)/.test(skeleton) ||
		hasRepeatedVariableQuantifierGroup(pattern)
	if (nestedQuantifier && !isWhitelistedSafePattern(pattern)) {
		throw new Error(
			'REGEX_TOO_COMPLEX: nested quantifiers can backtrack catastrophically; simplify the pattern, use a literal substring, or use desktop MCP.',
		)
	}
}
