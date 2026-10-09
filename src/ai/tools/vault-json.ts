import { z } from 'zod/mini'
import type { App } from 'obsidian'
import { tool } from 'ai'
import { appDep } from './tool-context'
import {
	getVaultFileSize,
	normalizeVaultVirtualPath,
	readVaultText,
	toVaultPath,
} from './vault-native'

const MAX_FILE_BYTES = 20 * 1024 * 1024
const DEFAULT_LINES = 200
const DEFAULT_MAX_RESULTS = 50
const HARD_MAX_RESULTS = 500

const AGGREGATES = [
	'count',
	'length',
	'sum',
	'min',
	'max',
	'first',
	'last',
	'keys',
]

type Token =
	| { kind: 'key'; value: string }
	| { kind: 'index'; value: number }
	| { kind: 'wildcard' }

export const vaultJsonInputSchema = z.object({
	path: z.string(),
	query: z.string(),
	lines: z.optional(z.number()),
	maxResults: z.optional(z.number()),
	where: z.optional(z.string()),
})

function parsePath(expression: string): Token[] {
	const raw = expression.trim()
	if (raw === '' || raw === '$' || raw === '.') return []
	let source = raw
	if (source.startsWith('$')) source = source.slice(1)
	if (source.startsWith('.')) source = source.slice(1)
	const tokens: Token[] = []
	let index = 0
	while (index < source.length) {
		const char = source[index]
		if (char === '.') {
			index += 1
			continue
		}
		if (char === '[') {
			const end = source.indexOf(']', index)
			if (end === -1) {
				throw new Error('Unclosed [ in query: ' + raw)
			}
			const inner = source.slice(index + 1, end).trim()
			if (inner === '*') {
				tokens.push({ kind: 'wildcard' })
			} else if (/^\d+$/.test(inner)) {
				tokens.push({ kind: 'index', value: Number(inner) })
			} else if (
				(inner.startsWith('"') && inner.endsWith('"')) ||
				(inner.startsWith("'") && inner.endsWith("'"))
			) {
				tokens.push({ kind: 'key', value: inner.slice(1, -1) })
			} else {
				tokens.push({ kind: 'key', value: inner })
			}
			index = end + 1
			continue
		}
		let cursor = index
		while (
			cursor < source.length &&
			source[cursor] !== '.' &&
			source[cursor] !== '['
		) {
			cursor += 1
		}
		const key = source.slice(index, cursor).trim()
		if (key !== '') tokens.push({ kind: 'key', value: key })
		index = cursor
	}
	return tokens
}

function selectValues(value: unknown, tokens: Token[]): unknown[] {
	let current: unknown[] = [value]
	for (const token of tokens) {
		const next: unknown[] = []
		for (const item of current) {
			if (token.kind === 'wildcard') {
				if (Array.isArray(item)) {
					next.push(...item)
				} else if (item !== null && typeof item === 'object') {
					next.push(...Object.values(item as Record<string, unknown>))
				}
				continue
			}
			if (token.kind === 'index') {
				if (Array.isArray(item)) {
					const picked = item[token.value]
					if (picked !== undefined) next.push(picked)
				}
				continue
			}
			if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
				const picked = (item as Record<string, unknown>)[token.value]
				if (picked !== undefined) next.push(picked)
			}
		}
		current = next
	}
	return current
}

function applyAggregate(values: unknown[], aggregate: string) {
	switch (aggregate) {
		case 'count':
			return values.length
		case 'length': {
			if (values.length === 1) {
				const value = values[0]
				if (Array.isArray(value)) return value.length
				if (typeof value === 'string') return value.length
				if (value !== null && typeof value === 'object') {
					return Object.keys(value).length
				}
			}
			return values.length
		}
		case 'first':
			return values[0] ?? null
		case 'last':
			return values[values.length - 1] ?? null
		case 'keys': {
			const keys = new Set<string>()
			for (const value of values) {
				if (
					value !== null &&
					typeof value === 'object' &&
					!Array.isArray(value)
				) {
					for (const key of Object.keys(value)) {
						keys.add(key)
					}
				}
			}
			return [...keys].sort()
		}
		case 'sum':
		case 'min':
		case 'max': {
			const numbers = values.filter(
				(value): value is number =>
					typeof value === 'number' && Number.isFinite(value),
			)
			if (numbers.length === 0) {
				throw new Error('No numeric values matched the query')
			}
			if (aggregate === 'sum') {
				return numbers.reduce((sum, value) => sum + value, 0)
			}
			return aggregate === 'min' ? Math.min(...numbers) : Math.max(...numbers)
		}
		default:
			throw new Error(
				'Unsupported aggregate "' +
					aggregate +
					'". Supported: ' +
					AGGREGATES.join(', '),
			)
	}
}

function parseDocuments(text: string, vaultPath: string) {
	const trimmed = text.trim()
	if (trimmed === '') {
		return { documents: [] as unknown[], skipped: 0 }
	}
	if (!/\.jsonl$/i.test(vaultPath)) {
		try {
			return { documents: [JSON.parse(trimmed)] as unknown[], skipped: 0 }
		} catch {
			// fall through to line-by-line parsing
		}
	}
	const documents: unknown[] = []
	let skipped = 0
	for (const line of trimmed.split('\n')) {
		if (line.trim() === '') continue
		try {
			documents.push(JSON.parse(line))
		} catch {
			skipped += 1
		}
	}
	if (documents.length === 0) {
		throw new Error('File is neither JSON nor JSON Lines: ' + vaultPath)
	}
	return { documents, skipped }
}

function stringify(value: unknown) {
	return typeof value === 'string' ? value : JSON.stringify(value)
}

export async function executeVaultJson(
	app: App,
	virtualPath: string,
	query: string,
	options: {
		lines?: number
		maxResults?: number
		where?: string
	} = {},
) {
	const normalized = normalizeVaultVirtualPath(virtualPath)
	const vaultPath = toVaultPath(normalized)
	const declaredSize = await getVaultFileSize(app, vaultPath)
	if (declaredSize !== undefined && declaredSize > MAX_FILE_BYTES) {
		throw new Error(
			'File is too large for vault_json (' +
				declaredSize +
				' bytes, limit ' +
				MAX_FILE_BYTES +
				'); query a smaller file or use bash/desktop MCP.',
		)
	}
	const text = await readVaultText(app, vaultPath)
	if (declaredSize === undefined && text.length > MAX_FILE_BYTES) {
		throw new Error(
			'File is too large for vault_json (' +
				text.length +
				' bytes); query a smaller file or use bash.',
		)
	}

	const segments = query.split('|').map((segment) => segment.trim())
	if (segments.length > 2) {
		throw new Error('Only one aggregate is supported: <path> | <aggregate>')
	}
	const pathExpression = segments[0] ?? ''
	const aggregate = segments[1] ? segments[1].toLowerCase() : undefined
	if (aggregate !== undefined && !AGGREGATES.includes(aggregate)) {
		throw new Error(
			'Unsupported aggregate "' +
				aggregate +
				'". Supported: ' +
				AGGREGATES.join(', '),
		)
	}
	const tokens = parsePath(pathExpression)

	const parsed = parseDocuments(text, vaultPath)
	const lineLimit = Math.max(
		1,
		Math.min(5000, Math.floor(options.lines ?? DEFAULT_LINES)),
	)
	const maxResults = Math.max(
		1,
		Math.min(
			HARD_MAX_RESULTS,
			Math.floor(options.maxResults ?? DEFAULT_MAX_RESULTS),
		),
	)

	let documents = parsed.documents
	let filteredOut = 0
	if (options.where !== undefined && options.where !== '') {
		const needle = options.where
		const kept: unknown[] = []
		for (const document of documents) {
			if (stringify(document).includes(needle)) kept.push(document)
			else filteredOut += 1
		}
		documents = kept
	}
	let lineTruncated = false
	if (documents.length > lineLimit) {
		documents = documents.slice(-lineLimit)
		lineTruncated = true
	}

	const values: unknown[] = []
	for (const document of documents) {
		values.push(...selectValues(document, tokens))
	}

	const header = [
		`${normalized} · ${documents.length} document(s)`,
		`query: ${pathExpression === '' ? '.' : pathExpression}${aggregate ? ' | ' + aggregate : ''}`,
	]
	if (parsed.skipped > 0)
		header.push(`skipped ${parsed.skipped} unparsable line(s)`)
	if (filteredOut > 0)
		header.push(`where filtered out ${filteredOut} document(s)`)
	if (lineTruncated) header.push(`only last ${lineLimit} document(s) scanned`)
	if (values.length === 0) {
		return header.join(' · ') + '\nno match'
	}

	if (aggregate !== undefined) {
		return (
			header.join(' · ') +
			` · matched ${values.length} value(s)` +
			'\n' +
			stringify(applyAggregate(values, aggregate))
		)
	}

	const shown = values.slice(0, maxResults)
	const body = shown.map((value) => stringify(value))
	if (values.length > shown.length) {
		body.push(`... (${values.length - shown.length} more, raise maxResults)`)
	}
	return (
		header.join(' · ') +
		` · matched ${values.length} value(s)` +
		'\n' +
		body.join('\n')
	)
}

export const vaultJsonTool = tool({
	description: [
		'Query a JSON or JSON Lines file inside the Obsidian vault without bash or jq.',
		'Query syntax is a documented subset: a path of keys, [index] and [*] wildcards, optionally followed by " | " and one aggregate (count, length, sum, min, max, first, last, keys). count counts matched values; length returns the array/string/object length when a single value is matched, otherwise the same as count.',
		'Example paths: .ai.yolo · .aiModelLimits[*].context | sum · .agent.toolTimings | keys. For .jsonl files the query runs on each line (last `lines` lines, default 200) and results are gathered together.',
		'Use where=<substring> to keep only documents whose JSON text contains the substring.',
		'This is not full jq: unsupported syntax raises an error instead of returning a wrong value.',
	].join(' '),
	inputSchema: vaultJsonInputSchema,
	contextSchema: z.object({ app: appDep }),
	outputSchema: z.string(),
	execute: async ({ path, query, lines, maxResults, where }, { context }) =>
		executeVaultJson(context.app, path, query, { lines, maxResults, where }),
})
