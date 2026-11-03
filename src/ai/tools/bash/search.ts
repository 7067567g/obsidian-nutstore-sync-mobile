import {
	defineCommand,
	type CommandContext,
	type ExecResult,
} from 'just-bash/browser'
import { posix as pathPosix } from 'path-browserify'
import { decodeStdin } from './zip-format'

/*
 * Abort-aware replacements for grep/rg/egrep/fgrep.
 *
 * just-bash only checks an AbortSignal at statement boundaries, so a native
 * grep/rg command over a large minified file (the 7.4 MB plugin main.js) can
 * block the WebView main thread for 50-70 s and defeat runWithTimeout.
 * These commands scan in bounded chunks, check the signal between chunks and
 * matches, and fail fast on resource shapes that cannot be interrupted:
 * huge files combined with variable-length context patterns such as
 * .\{0,60\}web_search.\{0,120\}.
 */

export const SEARCH_MAX_FILE_BYTES = 8 * 1024 * 1024
export const SEARCH_MAX_CONTEXT_FILE_BYTES = 512 * 1024
export const SEARCH_MAX_CONTEXT_WIDTH = 256
export const SEARCH_CHUNK_BYTES = 128 * 1024
export const SEARCH_MAX_MATCHES = 10000
export const SEARCH_MAX_OUTPUT_CHARS = 1024 * 1024
export const SEARCH_MAX_FILES = 4000
const MAX_PATTERN_CHARS = 2000

export class SearchResourceLimitError extends Error {
	constructor(message: string) {
		super('TOOL_RESOURCE_EXCEEDED: ' + message)
		this.name = 'SearchResourceLimitError'
	}
}

type SearchTool = 'grep' | 'rg' | 'egrep' | 'fgrep'

interface SearchFlags {
	recursive: boolean
	ignoreCase: boolean
	invert: boolean
	lineNumber: boolean
	onlyMatching: boolean
	count: boolean
	filesWithMatches: boolean
	word: boolean
	lineRegexp: boolean
	fixed: boolean
	extended: boolean
	maxCount?: number
	include: string[]
	exclude: string[]
}

interface ParsedSearch {
	tool: SearchTool
	pattern: string
	paths: string[]
	flags: SearchFlags
}

function defaultFlags(): SearchFlags {
	return {
		recursive: false,
		ignoreCase: false,
		invert: false,
		lineNumber: false,
		onlyMatching: false,
		count: false,
		filesWithMatches: false,
		word: false,
		lineRegexp: false,
		fixed: false,
		extended: false,
		include: [],
		exclude: [],
	}
}

function isAbortError(error: unknown) {
	if (!(error instanceof Error)) return false
	return (
		error.name === 'AbortError' ||
		error.message === 'Aborted' ||
		error.message.indexOf('Aborted') === 0
	)
}

function throwIfAborted(signal?: AbortSignal) {
	if (!signal?.aborted) return
	const error = new Error('Aborted')
	error.name = 'AbortError'
	throw error
}

/** just-bash types stdin as an opaque ByteString; it is a string at runtime. */
function decodeSearchStdin(stdin: unknown): string {
	return decodeStdin(typeof stdin === 'string' ? stdin : '')
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function translateBasicRegex(pattern: string) {
	let output = ''
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index]
		if (char === '\\') {
			const next = pattern[index + 1]
			if (next === undefined) {
				output += '\\\\'
				continue
			}
			index += 1
			if ('(){}+?|'.indexOf(next) >= 0) output += next
			else output += '\\' + next
			continue
		}
		if ('(){}+?|'.indexOf(char) >= 0) output += '\\' + char
		else output += char
	}
	return output
}

function estimateVariableContextWidth(pattern: string): number {
	let width = 0
	const quantifier = /\.\{(\d+)(?:,(\d*))?\}/g
	let match: RegExpExecArray | null
	while ((match = quantifier.exec(pattern))) {
		const lower = Number(match[1])
		const upper =
			match[2] === undefined || match[2] === '' ? lower : Number(match[2])
		if (Number.isFinite(upper)) width = Math.max(width, upper)
	}
	if (/\.\*/.test(pattern) || /\.\+/.test(pattern)) {
		width = Math.max(width, SEARCH_MAX_CONTEXT_WIDTH + 1)
	}
	return width
}

function buildRegExp(
	tool: SearchTool,
	rawPattern: string,
	flags: SearchFlags,
): { regex: RegExp; contextWidth: number } {
	if (rawPattern.length > MAX_PATTERN_CHARS) {
		throw new SearchResourceLimitError(
			'pattern is too long (' +
				rawPattern.length +
				' chars > ' +
				MAX_PATTERN_CHARS +
				')',
		)
	}
	let source: string
	if (flags.fixed || tool === 'fgrep') {
		source = escapeRegExp(rawPattern)
	} else if (tool === 'grep' && !flags.extended) {
		source = translateBasicRegex(rawPattern)
	} else {
		source = rawPattern
	}
	if (flags.word) source = '\\b(?:' + source + ')\\b'
	if (flags.lineRegexp) source = '^(?:' + source + ')$'
	const contextWidth = estimateVariableContextWidth(source)
	if (contextWidth > SEARCH_MAX_CONTEXT_WIDTH) {
		throw new SearchResourceLimitError(
			'pattern variable context width ' +
				contextWidth +
				' exceeds ' +
				SEARCH_MAX_CONTEXT_WIDTH +
				'; narrow the pattern or use vault_grep/xxd',
		)
	}
	try {
		return {
			regex: new RegExp(source, flags.ignoreCase ? 'gi' : 'g'),
			contextWidth,
		}
	} catch (error) {
		throw new Error(
			'invalid regular expression: ' +
				(error instanceof Error ? error.message : String(error)),
			{ cause: error },
		)
	}
}

function parseArgs(tool: SearchTool, args: string[]): ParsedSearch {
	const flags = defaultFlags()
	const patterns: string[] = []
	const paths: string[] = []
	let sawPatternFlag = false
	let operandsStarted = false

	const takeValue = (index: number, inline?: string) => {
		if (inline !== undefined && inline !== '')
			return { value: inline, next: index }
		const next = args[index + 1]
		if (next === undefined) throw new Error('option requires an argument')
		return { value: next, next: index + 1 }
	}

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]
		if (operandsStarted || arg === '-' || arg.indexOf('-') !== 0) {
			if (patterns.length === 0 && !sawPatternFlag) patterns.push(arg)
			else paths.push(arg)
			continue
		}
		if (arg === '--') {
			operandsStarted = true
			continue
		}
		if (arg.indexOf('--') === 0) {
			const equals = arg.indexOf('=')
			const name = equals >= 0 ? arg.slice(0, equals) : arg
			const inline = equals >= 0 ? arg.slice(equals + 1) : undefined
			switch (name) {
				case '--recursive':
					flags.recursive = true
					break
				case '--ignore-case':
					flags.ignoreCase = true
					break
				case '--invert-match':
					flags.invert = true
					break
				case '--line-number':
					flags.lineNumber = true
					break
				case '--only-matching':
					flags.onlyMatching = true
					break
				case '--count':
					flags.count = true
					break
				case '--files-with-matches':
					flags.filesWithMatches = true
					break
				case '--word-regexp':
					flags.word = true
					break
				case '--line-regexp':
					flags.lineRegexp = true
					break
				case '--fixed-strings':
					flags.fixed = true
					break
				case '--extended-regexp':
					flags.extended = true
					break
				case '--include': {
					const taken = takeValue(index, inline)
					flags.include.push(taken.value)
					index = taken.next
					break
				}
				case '--exclude': {
					const taken = takeValue(index, inline)
					flags.exclude.push(taken.value)
					index = taken.next
					break
				}
				case '--glob': {
					const taken = takeValue(index, inline)
					if (taken.value.indexOf('!') === 0)
						flags.exclude.push(taken.value.slice(1))
					else flags.include.push(taken.value)
					index = taken.next
					break
				}
				case '--max-count': {
					const taken = takeValue(index, inline)
					flags.maxCount = Number(taken.value)
					index = taken.next
					break
				}
				case '--regexp': {
					const taken = takeValue(index, inline)
					patterns.push(taken.value)
					sawPatternFlag = true
					index = taken.next
					break
				}
				case '--color':
				case '--colour':
				case '--heading':
				case '--no-heading':
				case '--with-filename':
				case '--no-filename':
				case '--hidden':
				case '--no-ignore':
				case '--smart-case':
				case '--binary':
				case '--no-messages':
					break
				default:
					throw new Error("unsupported option '" + name + "'")
			}
			continue
		}
		for (let offset = 1; offset < arg.length; offset += 1) {
			const flag = arg[offset]
			const inline = offset < arg.length - 1 ? arg.slice(offset + 1) : undefined
			switch (flag) {
				case 'r':
				case 'R':
					flags.recursive = true
					break
				case 'i':
					flags.ignoreCase = true
					break
				case 'v':
					flags.invert = true
					break
				case 'n':
					flags.lineNumber = true
					break
				case 'o':
					flags.onlyMatching = true
					break
				case 'c':
					flags.count = true
					break
				case 'l':
					flags.filesWithMatches = true
					break
				case 'w':
					flags.word = true
					break
				case 'x':
					flags.lineRegexp = true
					break
				case 'F':
					flags.fixed = true
					break
				case 'E':
					flags.extended = true
					break
				case 's':
				case 'h':
				case 'H':
				case 'a':
				case 'I':
				case 'u':
					break
				case 'm': {
					const taken = takeValue(index, inline)
					flags.maxCount = Number(taken.value)
					index = taken.next
					offset = arg.length
					break
				}
				case 'e': {
					const taken = takeValue(index, inline)
					patterns.push(taken.value)
					sawPatternFlag = true
					index = taken.next
					offset = arg.length
					break
				}
				default:
					throw new Error("unsupported option '-" + flag + "'")
			}
		}
	}
	if (patterns.length === 0) throw new Error('missing search pattern')
	if (flags.maxCount !== undefined && !Number.isFinite(flags.maxCount)) {
		throw new Error('invalid --max-count value')
	}
	return { tool, pattern: patterns[0], paths, flags }
}

function globToRegExp(glob: string) {
	const dollar = String.fromCharCode(36)
	const special = '.+^' + dollar + '(){}|[]\\'
	let output = ''
	for (const char of glob) {
		if (char === '*') {
			output += '[^/]*'
			continue
		}
		if (char === '?') {
			output += '[^/]'
			continue
		}
		output += special.indexOf(char) >= 0 ? '\\' + char : char
	}
	return new RegExp('^' + output + '$')
}
function matchesAny(globs: RegExp[], value: string) {
	return globs.some((glob) => glob.test(value))
}

async function collectFiles(
	ctx: CommandContext,
	flags: SearchFlags,
	paths: string[],
	signal?: AbortSignal,
) {
	const include = flags.include.map(globToRegExp)
	const exclude = flags.exclude.map(globToRegExp)
	const files: string[] = []
	const rootInput =
		paths.length > 0 ? ctx.fs.resolvePath(ctx.cwd, paths[0]) : ''

	const visit = async (path: string, isRoot = false) => {
		throwIfAborted(signal)
		if (files.length >= SEARCH_MAX_FILES) {
			throw new SearchResourceLimitError(
				'too many files to search (> ' +
					SEARCH_MAX_FILES +
					'); narrow the path',
			)
		}
		const stat = await ctx.fs.stat(path)
		if (stat.isFile) {
			const relative = path.indexOf('/') === 0 ? path.slice(1) : path
			if (
				include.length > 0 &&
				!matchesAny(include, relative) &&
				!matchesAny(include, path)
			)
				return
			if (
				exclude.length > 0 &&
				(matchesAny(exclude, relative) || matchesAny(exclude, path))
			)
				return
			files.push(path)
			return
		}
		if (!stat.isDirectory) return
		if (!flags.recursive && !isRoot) return
		for (const name of await ctx.fs.readdir(path)) {
			throwIfAborted(signal)
			await visit(pathPosix.join(path, name))
		}
	}

	if (paths.length === 0) {
		await visit(ctx.fs.resolvePath(ctx.cwd, '.'), true)
		return files
	}
	for (const input of paths) {
		if (input === '-') continue
		const resolved = ctx.fs.resolvePath(ctx.cwd, input)
		const stat = await ctx.fs.stat(resolved)
		if (stat.isDirectory) {
			if (!flags.recursive) throw new Error('Is a directory: ' + input)
			await visit(resolved, true)
		} else {
			await visit(resolved)
		}
	}
	void rootInput
	return files
}

interface MatchRecord {
	index: number
	text: string
	line: number
}

function scanMatchesChunked(
	text: string,
	regex: RegExp,
	contextWidth: number,
	signal?: AbortSignal,
) {
	const matches: MatchRecord[] = []
	const overlap = Math.min(Math.max(contextWidth, 0), SEARCH_MAX_CONTEXT_WIDTH)
	const seen = new Set<number>()
	for (let start = 0; start < text.length; start += SEARCH_CHUNK_BYTES) {
		throwIfAborted(signal)
		const end = Math.min(text.length, start + SEARCH_CHUNK_BYTES + overlap)
		const chunk = text.slice(start, end)
		const local = new RegExp(regex.source, regex.flags)
		let match: RegExpExecArray | null
		let guard = 0
		while ((match = local.exec(chunk))) {
			if (match[0].length === 0) {
				local.lastIndex += 1
				continue
			}
			const absolute = start + match.index
			if (absolute >= start + SEARCH_CHUNK_BYTES) break
			if (!seen.has(absolute)) {
				seen.add(absolute)
				matches.push({ index: absolute, text: match[0], line: 1 })
			}
			if (matches.length >= SEARCH_MAX_MATCHES) {
				throw new SearchResourceLimitError(
					'too many matches (> ' + SEARCH_MAX_MATCHES + '); narrow the pattern',
				)
			}
			guard += 1
			if (guard % 64 === 0) throwIfAborted(signal)
		}
	}
	// Turn absolute indices into line numbers in one forward pass, so the cost
	// stays linear even when a file yields many matches.
	let cursor = 0
	let newlines = 0
	for (const match of matches) {
		for (let index = cursor; index < match.index; index += 1) {
			if (text.charCodeAt(index) === 10) newlines += 1
		}
		match.line = newlines + 1
		cursor = match.index
	}
	return matches
}

function countMatchedLines(
	text: string,
	regex: RegExp,
	flags: SearchFlags,
	signal?: AbortSignal,
) {
	let count = 0
	const lines = text.split('\n')
	for (let index = 0; index < lines.length; index += 1) {
		if (index % 512 === 0) throwIfAborted(signal)
		regex.lastIndex = 0
		if (regex.test(lines[index]) !== flags.invert) count += 1
		if (flags.maxCount !== undefined && count >= flags.maxCount) break
	}
	return count
}

function scanText(
	text: string,
	regex: RegExp,
	contextWidth: number,
	flags: SearchFlags,
	signal?: AbortSignal,
	displayPath?: string,
): ExecResult {
	if (flags.count) {
		const count =
			flags.onlyMatching && contextWidth > 0
				? scanMatchesChunked(text, regex, contextWidth, signal).length
				: countMatchedLines(text, regex, flags, signal)
		const prefix = displayPath ? displayPath + ':' : ''
		return {
			stdout: prefix + count + '\n',
			stderr: '',
			exitCode: count > 0 ? 0 : 1,
		}
	}
	if (flags.onlyMatching) {
		const matches = scanMatchesChunked(text, regex, contextWidth, signal)
		if (matches.length === 0) return { stdout: '', stderr: '', exitCode: 1 }
		const lines = matches.map((match) => {
			if (!displayPath) return match.text
			const prefix = flags.lineNumber
				? displayPath + ':' + match.line + ':'
				: displayPath + ':'
			return prefix + match.text
		})
		return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
	}
	const lines = text.split('\n')
	const out: string[] = []
	let matched = 0
	for (let index = 0; index < lines.length; index += 1) {
		if (index % 512 === 0) throwIfAborted(signal)
		regex.lastIndex = 0
		const hit = regex.test(lines[index])
		if (hit === flags.invert) continue
		matched += 1
		const line = lines[index]
		if (!displayPath) out.push(line)
		else if (flags.lineNumber)
			out.push(displayPath + ':' + (index + 1) + ':' + line)
		else out.push(displayPath + ':' + line)
		if (flags.maxCount !== undefined && matched >= flags.maxCount) break
	}
	if (out.length === 0) return { stdout: '', stderr: '', exitCode: 1 }
	return { stdout: out.join('\n') + '\n', stderr: '', exitCode: 0 }
}

async function filterFilesWithMatches(
	ctx: CommandContext,
	files: string[],
	regex: RegExp,
	contextWidth: number,
	signal?: AbortSignal,
) {
	const out: string[] = []
	for (const file of files) {
		throwIfAborted(signal)
		const stat = await ctx.fs.stat(file)
		if (stat.size > SEARCH_MAX_FILE_BYTES) {
			throw new SearchResourceLimitError(
				file +
					' is ' +
					stat.size +
					' bytes; text search is capped at ' +
					SEARCH_MAX_FILE_BYTES +
					' bytes',
			)
		}
		if (contextWidth > 0 && stat.size > SEARCH_MAX_CONTEXT_FILE_BYTES) {
			throw new SearchResourceLimitError(
				file + ' is too large for a variable-context pattern',
			)
		}
		const text = await ctx.fs.readFile(file)
		const probe = scanText(
			text,
			regex,
			contextWidth,
			{
				...defaultFlags(),
				onlyMatching: false,
				count: false,
			},
			signal,
		)
		if (probe.exitCode === 0) out.push(file)
	}
	return out
}

async function runSearch(
	tool: SearchTool,
	args: string[],
	ctx: CommandContext,
	signal?: AbortSignal,
): Promise<ExecResult> {
	let parsed: ParsedSearch
	try {
		parsed = parseArgs(tool, args)
	} catch (error) {
		return {
			stdout: '',
			stderr:
				tool +
				': ' +
				(error instanceof Error ? error.message : String(error)) +
				'\n',
			exitCode: 2,
		}
	}
	const flags = parsed.flags
	let built: { regex: RegExp; contextWidth: number }
	try {
		built = buildRegExp(tool, parsed.pattern, flags)
	} catch (error) {
		return {
			stdout: '',
			stderr:
				tool +
				': ' +
				(error instanceof Error ? error.message : String(error)) +
				'\n',
			exitCode: 2,
		}
	}
	const regex = built.regex
	const contextWidth = built.contextWidth
	try {
		throwIfAborted(signal)
		if (parsed.paths.length === 0) {
			const text = decodeSearchStdin(ctx.stdin)
			if (text.length > 0 || tool !== 'rg') {
				if (text.length === 0) return { stdout: '', stderr: '', exitCode: 1 }
				if (contextWidth > 0 && text.length > SEARCH_MAX_CONTEXT_FILE_BYTES) {
					throw new SearchResourceLimitError(
						'stdin is ' +
							text.length +
							' chars and the pattern needs variable context; use a smaller slice or vault_grep',
					)
				}
				return scanText(text, regex, contextWidth, flags, signal)
			}
			flags.recursive = true
		}

		const files = await collectFiles(ctx, flags, parsed.paths, signal)
		if (files.length === 0) return { stdout: '', stderr: '', exitCode: 1 }

		if (flags.filesWithMatches) {
			const withMatches = await filterFilesWithMatches(
				ctx,
				files,
				regex,
				contextWidth,
				signal,
			)
			if (withMatches.length === 0)
				return { stdout: '', stderr: '', exitCode: 1 }
			return { stdout: withMatches.join('\n') + '\n', stderr: '', exitCode: 0 }
		}

		const output: string[] = []
		let anyMatch = false
		let outputChars = 0
		for (const file of files) {
			throwIfAborted(signal)
			const stat = await ctx.fs.stat(file)
			if (!stat.isFile) continue
			if (stat.size > SEARCH_MAX_FILE_BYTES) {
				throw new SearchResourceLimitError(
					file +
						' is ' +
						stat.size +
						' bytes; text search is capped at ' +
						SEARCH_MAX_FILE_BYTES +
						' bytes. Use vault_grep/xxd/head/dd for large or minified files.',
				)
			}
			if (contextWidth > 0 && stat.size > SEARCH_MAX_CONTEXT_FILE_BYTES) {
				throw new SearchResourceLimitError(
					file +
						' is ' +
						stat.size +
						' bytes and the pattern needs variable context (' +
						contextWidth +
						'); this can block the UI. Use vault_grep or a bounded xxd/head command.',
				)
			}
			const text = await ctx.fs.readFile(file)
			const display = file.indexOf('/') === 0 ? file.slice(1) : file
			const result = scanText(text, regex, contextWidth, flags, signal, display)
			if (result.exitCode === 0) anyMatch = true
			if (result.stdout) {
				output.push(result.stdout.replace(/\n$/, ''))
				outputChars += result.stdout.length
			}
			if (outputChars > SEARCH_MAX_OUTPUT_CHARS) {
				throw new SearchResourceLimitError(
					'search output exceeded ' +
						SEARCH_MAX_OUTPUT_CHARS +
						' chars; narrow the pattern',
				)
			}
			if (
				anyMatch &&
				flags.maxCount !== undefined &&
				output.length >= flags.maxCount
			)
				break
		}
		const stdout = output.filter(Boolean).join('\n')
		return {
			stdout: stdout ? stdout + '\n' : '',
			stderr: '',
			exitCode: anyMatch ? 0 : 1,
		}
	} catch (error) {
		if (isAbortError(error)) {
			return { stdout: '', stderr: 'Aborted\n', exitCode: 130 }
		}
		return {
			stdout: '',
			stderr:
				tool +
				': ' +
				(error instanceof Error ? error.message : String(error)) +
				'\n',
			exitCode: 2,
		}
	}
}

function makeSearchCommand(
	tool: SearchTool,
	getSignal: () => AbortSignal | undefined,
) {
	return defineCommand(tool, (args, ctx) =>
		runSearch(tool, args, ctx, getSignal()),
	)
}

export function createSearchCommands(signal?: AbortSignal) {
	return [
		makeSearchCommand('grep', () => signal),
		makeSearchCommand('rg', () => signal),
		makeSearchCommand('egrep', () => signal),
		makeSearchCommand('fgrep', () => signal),
	]
}
