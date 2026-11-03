import { parse as bytesParse } from 'bytes-iec'
import { clamp, isNumber } from 'lodash-es'
import type { GlobFilterRule } from '~/utils/glob-match'
import GlobMatch, { isVoidGlobMatchOptions } from '~/utils/glob-match'
import { normalizeByteSizeInput } from '~/utils/download-chunk-size'
import {
	FILTER_RULE_TYPES,
	MAX_BYTES,
	MAX_FILE_SIZE,
	MAX_FILTER_RULES,
	isObject,
	jsonError,
} from './settings-whitelist-schema'

export function normalizeFilterRule(
	path: string,
	value: unknown,
	index: number,
	rules: GlobFilterRule[],
): string | null {
	const name = `${path}.rules[${index}]`
	if (!isObject(value)) {
		return jsonError(name, 'an object')
	}
	const expr = value.expr
	if (typeof expr !== 'string' || expr.trim() === '') {
		return jsonError(`${name}.expr`, 'a non-empty string')
	}
	const type = value.type
	if (typeof type !== 'string' || !FILTER_RULE_TYPES.has(type)) {
		return jsonError(`${name}.type`, "'include' or 'exclude'")
	}
	const caseSensitive = value.caseSensitive
	if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') {
		return jsonError(`${name}.caseSensitive`, 'a boolean')
	}
	const disabled = value.disabled
	if (disabled !== undefined && typeof disabled !== 'boolean') {
		return jsonError(`${name}.disabled`, 'a boolean')
	}
	const options = { caseSensitive: caseSensitive === true }
	const rule: GlobFilterRule = {
		expr,
		options,
		type: type as 'include' | 'exclude',
		...(disabled === true ? { disabled: true } : {}),
	}
	if (isVoidGlobMatchOptions(rule)) {
		return jsonError(`${name}.expr`, 'a non-empty pattern')
	}
	try {
		new GlobMatch(expr, options)
	} catch {
		return jsonError(`${name}.expr`, 'a valid glob pattern')
	}
	rules.push(rule)
	return null
}

export function parseFilterRules(
	path: string,
	value: unknown,
): {
	rules: GlobFilterRule[]
	error: string | null
} {
	if (!isObject(value)) {
		return { rules: [], error: jsonError(path, 'an object with a rules array') }
	}
	if (!Array.isArray(value.rules)) {
		return { rules: [], error: jsonError(`${path}.rules`, 'an array') }
	}
	if (value.rules.length > MAX_FILTER_RULES) {
		return {
			rules: [],
			error: `invalid setting '${path}.rules': too many rules (max ${MAX_FILTER_RULES})`,
		}
	}
	const rules: GlobFilterRule[] = []
	for (let index = 0; index < value.rules.length; index += 1) {
		const error = normalizeFilterRule(path, value.rules[index], index, rules)
		if (error) {
			return { rules: [], error }
		}
	}
	return { rules, error: null }
}

export function parseByteSize(
	path: string,
	value: unknown,
): {
	size: string | null
	error: string | null
} {
	if (typeof value !== 'string') {
		return { size: null, error: jsonError(path, 'a byte size string') }
	}
	const normalized = normalizeByteSizeInput(value, '')
	if (!normalized) {
		return {
			size: null,
			error: jsonError(path, 'a non-empty byte size string'),
		}
	}
	const parsed = bytesParse(normalized, { mode: 'jedec' })
	if (parsed === null) {
		return { size: null, error: jsonError(path, 'a valid byte size string') }
	}
	if (parsed > MAX_BYTES) {
		return {
			size: null,
			error: `invalid setting '${path}': exceeds the maximum of ${MAX_FILE_SIZE}`,
		}
	}
	return { size: normalized, error: null }
}

export function parseClampedInteger(
	path: string,
	value: unknown,
	min: number,
	max: number,
): { number: number | null; error: string | null } {
	if (
		typeof value !== 'number' ||
		!isNumber(value) ||
		!Number.isFinite(value)
	) {
		return { number: null, error: jsonError(path, 'a number') }
	}
	return { number: clamp(value, min, max), error: null }
}

export function parseBoolean(
	path: string,
	value: unknown,
): {
	boolean: boolean | null
	error: string | null
} {
	if (value !== true && value !== false) {
		return { boolean: null, error: jsonError(path, 'a boolean') }
	}
	return { boolean: value, error: null }
}

export function parseEnum(
	path: string,
	value: unknown,
	allowed: Set<string>,
	label: string,
): { value: string | null; error: string | null } {
	if (typeof value !== 'string' || !allowed.has(value)) {
		return { value: null, error: jsonError(path, label) }
	}
	return { value, error: null }
}
