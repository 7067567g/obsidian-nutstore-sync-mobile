import type { AppUIMessage, AppUIMessagePart } from '~/ai/chat/types'

export const DETERMINISTIC_SUMMARY_MAX_ITEMS = 10
export const DETERMINISTIC_SUMMARY_MAX_ITEM_CHARS = 200
export const DETERMINISTIC_SUMMARY_MAX_TOKENS = 2048
export const DETERMINISTIC_PROTECTED_TOOLS = [
	'vault_batch_edit',
	'apply_patch',
	'settings_patch',
]

const MAX_SOURCE_MESSAGES = 500
const MAX_SOURCE_CHARS = 1_000_000
const MAX_TOOL_INPUT_CHARS = 16_384
const MAX_PATH_ENTRIES = 80

const PATH_KEYS = new Set([
	'path',
	'file_path',
	'filepath',
	'absolute_path',
	'absolutepath',
	'vaultpath',
	'vault_path',
	'file',
	'src',
	'dest',
	'source',
	'target',
	'from',
	'to',
	'glob',
	'pattern',
	'paths',
	'files',
])

const WRITE_TOOL_PATTERN =
	/(write|edit|patch|delete|remove|mkdir|move|rename|create|batch_edit|apply_patch|settings_patch)/i
const READ_TOOL_PATTERN =
	/(read|list|grep|stat|hash|json|links|view|search|frontmatter|tree)/i
const ERROR_HINT_PATTERN =
	/(error|traceback|exception|失败|错误|异常|not found|permission denied|denied|enoent)/i

interface FileUsage {
	path: string
	reads: number
	writes: number
}

export interface DeterministicFacts {
	intents: string[]
	vaultContext: string[]
	files: Map<string, FileUsage>
	errors: string[]
	pending: string[]
	currentUser: string[]
	currentAssistant: string[]
	critical: string[]
	reasoningExcerpts: string[]
	dedup: Map<string, number>
	toolCallCount: number
	scannedMessages: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function clipText(text: string, maxChars: number) {
	if (text.length <= maxChars) return text
	if (maxChars <= 1) return text.slice(0, maxChars)
	return `${text.slice(0, maxChars - 1).trimEnd()}…`
}

export function compactInline(text: string) {
	return text.replace(/\s+/g, ' ').trim()
}

function normalizeKey(text: string) {
	return compactInline(text)
		.toLowerCase()
		.replace(/[\s\p{P}]+/gu, '')
}

function firstLine(text: string) {
	const lineBreak = text.indexOf('\n')
	return compactInline(
		lineBreak === -1 ? text : text.slice(0, lineBreak),
	).trim()
}

function pushUnique(
	target: string[],
	value: string,
	maxItems: number,
	maxItemChars: number,
) {
	const clipped = clipText(compactInline(value), maxItemChars)
	if (!clipped || clipped === '(none)') return
	const key = normalizeKey(clipped)
	if (!key || target.some((item) => normalizeKey(item) === key)) return
	target.push(clipped)
	if (target.length > maxItems) target.splice(0, target.length - maxItems)
}

function stringValues(value: unknown): string[] {
	if (typeof value === 'string') return [value]
	if (Array.isArray(value)) {
		return value.flatMap((item) => stringValues(item)).slice(0, 20)
	}
	return []
}

function collectPathValues(value: unknown, depth = 0): string[] {
	if (depth > 4) return []
	if (Array.isArray(value)) {
		return value
			.flatMap((item) => collectPathValues(item, depth + 1))
			.slice(0, MAX_PATH_ENTRIES)
	}
	if (!isRecord(value)) return []
	const paths: string[] = []
	for (const [key, nested] of Object.entries(value)) {
		const normalizedKey = key.toLowerCase()
		if (PATH_KEYS.has(normalizedKey)) {
			paths.push(...stringValues(nested))
			continue
		}
		if (
			normalizedKey === 'edits' ||
			normalizedKey === 'changes' ||
			normalizedKey === 'operations'
		) {
			paths.push(...collectPathValues(nested, depth + 1))
		}
	}
	return paths.slice(0, MAX_PATH_ENTRIES)
}

function collectCommandValues(value: unknown, depth = 0): string[] {
	if (depth > 3) return []
	if (!isRecord(value)) return []
	const commands: string[] = []
	for (const [key, nested] of Object.entries(value)) {
		const normalizedKey = key.toLowerCase()
		if (
			normalizedKey === 'command' ||
			normalizedKey === 'cmd' ||
			normalizedKey === 'script'
		) {
			commands.push(...stringValues(nested))
		} else if (isRecord(nested) || Array.isArray(nested)) {
			commands.push(...collectCommandValues(nested, depth + 1))
		}
	}
	return commands
}

function stableObjectKey(value: unknown, depth = 0): string {
	if (depth > 4) return '"[depth]"'
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableObjectKey(item, depth + 1)).join(',')}]`
	}
	if (isRecord(value)) {
		const keys = Object.keys(value).sort()
		return `{${keys
			.map(
				(key) =>
					`${JSON.stringify(key)}:${stableObjectKey(value[key], depth + 1)}`,
			)
			.join(',')}}`
	}
	if (typeof value === 'string') return JSON.stringify(value)
	return String(value)
}

function inputSizeWithinBudget(
	value: unknown,
	budget: { chars: number },
	depth = 0,
): boolean {
	if (budget.chars < 0 || depth > 4) return false
	budget.chars -= 4
	if (typeof value === 'string') {
		budget.chars -= value.length
		return budget.chars >= 0
	}
	if (value === null || typeof value !== 'object') return true
	if (Array.isArray(value)) {
		if (value.length > 100) return false
		for (const item of value) {
			if (!inputSizeWithinBudget(item, budget, depth + 1)) return false
		}
		return true
	}
	const record = value as Record<string, unknown>
	const keys = Object.keys(record)
	if (keys.length > 100) return false
	for (const key of keys) {
		budget.chars -= key.length
		if (!inputSizeWithinBudget(record[key], budget, depth + 1)) return false
	}
	return true
}

function toolInputSignature(
	part: Extract<AppUIMessagePart, { type: 'dynamic-tool' }>,
) {
	if (DETERMINISTIC_PROTECTED_TOOLS.includes(part.toolName)) return undefined
	const input = part.input
	if (input === undefined || input === null) return part.toolName
	if (!inputSizeWithinBudget(input, { chars: MAX_TOOL_INPUT_CHARS })) {
		return undefined
	}
	let serialized: string
	try {
		serialized = stableObjectKey(input)
	} catch {
		serialized = '"[unserializable]"'
	}
	if (serialized.length > MAX_TOOL_INPUT_CHARS) {
		serialized = serialized.slice(0, MAX_TOOL_INPUT_CHARS)
	}
	if (
		part.toolName === 'bash' &&
		(serialized.includes('>') ||
			/\b(tee|rm|mv|cp|mkdir|touch|truncate|dd)\b/i.test(serialized) ||
			/\bsed\s+-i\b/i.test(serialized))
	) {
		return undefined
	}
	return `${part.toolName}:${serialized}`
}

function extractErrorText(
	part: Extract<AppUIMessagePart, { type: 'dynamic-tool' }>,
) {
	if (part.state === 'output-error') return firstLine(part.errorText)
	if (part.state === 'output-available' && typeof part.output === 'string') {
		const line = firstLine(part.output)
		return ERROR_HINT_PATTERN.test(line) ? line : undefined
	}
	return undefined
}

function parseCheckpointSections(summary: string) {
	const sections = new Map<string, string[]>()
	if (!summary) return sections
	let current: string[] | undefined
	for (const rawLine of summary.split('\n')) {
		const header = /^##\s+(.+?)\s*$/.exec(rawLine)
		if (header) {
			current = sections.get(header[1].trim()) ?? []
			sections.set(header[1].trim(), current)
			continue
		}
		if (!current) continue
		const line = rawLine.trim()
		if (!line || line === '- (none)' || !line.startsWith('-')) continue
		current.push(line.replace(/^[-*]\s*/, '').trim())
	}
	return sections
}

function parseTodoText(text: string): string[] {
	const todos: string[] = []
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim()
		const checkbox = /^[-*]\s*\[([ xX])\]\s*(.+)$/.exec(line)
		if (checkbox && checkbox[1].toLowerCase() !== 'x') {
			todos.push(checkbox[2])
			continue
		}
		const todo = /^(?:TODO|待办)[:：]\s*(.+)$/i.exec(line)
		if (todo) todos.push(todo[1])
	}
	return todos
}

function reasoningExcerpt(text: string, maxChars: number) {
	const compacted = compactInline(text)
	if (compacted.length <= maxChars) return compacted
	const head = compacted.slice(0, Math.floor(maxChars * 0.4)).trimEnd()
	const tail = compacted.slice(-Math.floor(maxChars * 0.5)).trimStart()
	return `${head} … ${tail}`
}

function hasVisibleAssistantContent(message: AppUIMessage) {
	return message.parts.some((part) => {
		if (part.type === 'text') return part.text.trim().length > 0
		return part.type === 'dynamic-tool'
	})
}

export function collectFacts(
	messages: readonly AppUIMessage[],
	options: {
		maxItems: number
		maxItemChars: number
	},
): DeterministicFacts {
	const facts: DeterministicFacts = {
		intents: [],
		vaultContext: [],
		files: new Map(),
		errors: [],
		pending: [],
		currentUser: [],
		currentAssistant: [],
		critical: [],
		reasoningExcerpts: [],
		dedup: new Map(),
		toolCallCount: 0,
		scannedMessages: 0,
	}
	let scannedChars = 0
	const start = Math.max(0, messages.length - MAX_SOURCE_MESSAGES)
	const checkpoint = [...messages]
		.reverse()
		.find((message) =>
			message.parts.some((part) => part.type === 'data-context-checkpoint'),
		)
	if (checkpoint) {
		for (const part of checkpoint.parts) {
			if (part.type !== 'data-context-checkpoint') continue
			const sections = parseCheckpointSections(part.data.summary ?? '')
			for (const item of sections.get('User Goals') ?? []) {
				pushUnique(facts.intents, item, options.maxItems, options.maxItemChars)
			}
			for (const item of sections.get('Vault Context') ?? []) {
				pushUnique(
					facts.vaultContext,
					item,
					options.maxItems,
					options.maxItemChars,
				)
			}
			for (const item of sections.get('Issues and Resolutions') ?? []) {
				pushUnique(facts.errors, item, options.maxItems, options.maxItemChars)
			}
			for (const item of sections.get('Pending Requests') ?? []) {
				pushUnique(facts.pending, item, options.maxItems, options.maxItemChars)
			}
			for (const item of sections.get('Critical Context') ?? []) {
				pushUnique(facts.critical, item, options.maxItems, options.maxItemChars)
			}
		}
	}

	for (let index = start; index < messages.length; index += 1) {
		const message = messages[index]
		facts.scannedMessages += 1
		for (const part of message.parts) {
			if (scannedChars > MAX_SOURCE_CHARS) break
			if (part.type === 'text') {
				scannedChars += part.text.length
				if (message.role === 'user') {
					facts.currentUser = [part.text]
					pushUnique(
						facts.intents,
						part.text,
						options.maxItems,
						options.maxItemChars,
					)
					for (const todo of parseTodoText(part.text)) {
						pushUnique(
							facts.pending,
							todo,
							options.maxItems,
							options.maxItemChars,
						)
					}
				} else if (message.role === 'assistant') {
					facts.currentAssistant = [part.text]
				}
				continue
			}
			if (part.type === 'reasoning') {
				scannedChars += part.text.length
				if (message.role === 'assistant') {
					if (facts.currentAssistant.length === 0) {
						facts.currentAssistant = [part.text]
					}
					if (!hasVisibleAssistantContent(message)) {
						pushUnique(
							facts.reasoningExcerpts,
							reasoningExcerpt(part.text, options.maxItemChars),
							options.maxItems,
							options.maxItemChars,
						)
					}
				}
				continue
			}
			if (part.type === 'data-todos') {
				for (const todo of part.data.items) {
					if (todo.status === 'completed') continue
					const text = compactInline(todo.content ?? '')
					pushUnique(
						facts.pending,
						text,
						options.maxItems,
						options.maxItemChars,
					)
				}
				continue
			}
			if (part.type !== 'dynamic-tool') continue
			scannedChars += part.toolName.length
			scannedChars += 256
			facts.toolCallCount += 1
			const signature = toolInputSignature(part)
			if (signature) {
				facts.dedup.set(signature, (facts.dedup.get(signature) ?? 0) + 1)
			}
			const isWrite = WRITE_TOOL_PATTERN.test(part.toolName)
			const isRead = READ_TOOL_PATTERN.test(part.toolName)
			for (const path of collectPathValues(part.input)) {
				const normalizedPath = clipText(
					compactInline(path),
					options.maxItemChars,
				)
				if (!normalizedPath) continue
				const file = facts.files.get(normalizedPath) ?? {
					path: normalizedPath,
					reads: 0,
					writes: 0,
				}
				if (isWrite) file.writes += 1
				else if (isRead) file.reads += 1
				facts.files.set(normalizedPath, file)
			}
			for (const command of collectCommandValues(part.input)) {
				pushUnique(
					facts.vaultContext,
					`命令：${clipText(compactInline(command), options.maxItemChars)}`,
					options.maxItems,
					options.maxItemChars,
				)
			}
			const errorText = extractErrorText(part)
			if (errorText) {
				pushUnique(
					facts.errors,
					errorText,
					options.maxItems,
					options.maxItemChars,
				)
			}
		}
		if (scannedChars > MAX_SOURCE_CHARS) break
	}
	return facts
}
