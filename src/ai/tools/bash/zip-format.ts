import type { ZipOptions } from 'fflate/browser'
import type { CommandContext } from 'just-bash/browser'
import { posix as pathPosix } from 'path-browserify'
import type { ZipCommandOptions } from './zip-args'

interface ZipEntry {
	compressedSize: number
	compression: number
	flags: number
	mtime: Date
	name: string
	uncompressedSize: number
}

export type ZipInput = Record<string, Uint8Array | [Uint8Array, ZipOptions]>

const ZIP_MIN_MTIME = new Date(1980, 0, 1)
const ZIP_MAX_MTIME = new Date(2099, 11, 31, 23, 59, 58)

const ZIP_UTF8_FLAG = 0x800

function tryDecodeBytes(bytes: Uint8Array, label: string, fatal: boolean) {
	try {
		return new TextDecoder(label, { fatal }).decode(bytes)
	} catch {
		return null
	}
}

function hasCjkCodePoint(text: string) {
	return /[\u3400-\u9fff\uf900-\ufaff]/.test(text)
}

/**
 * ZIP 成员名解码（SBX-13/P-T5-1）。
 *
 * 置了 UTF-8 标志（bit 11）的条目按 UTF-8 解；未置标志时：
 * 1. 严格 UTF-8 失败 → 按 GBK（Windows 中文 zip 的常见形态）解；
 * 2. 严格 UTF-8 成功但结果不含 CJK、而 GBK 结果含 CJK → 取 GBK
 *    （部分 GBK 字节序列恰好是合法 UTF-8，需要这条消歧）；
 * 3. 其余情况保留 UTF-8 结果，最后以非严格 UTF-8 兜底，绝不抛错。
 */
function decodeZipEntryName(bytes: Uint8Array, flags: number) {
	if (flags & ZIP_UTF8_FLAG) {
		return new TextDecoder().decode(bytes)
	}
	const utf8 = tryDecodeBytes(bytes, 'utf-8', true)
	if (utf8 === null) {
		return (
			tryDecodeBytes(bytes, 'gbk', false) ?? new TextDecoder().decode(bytes)
		)
	}
	if (hasCjkCodePoint(utf8)) {
		return utf8
	}
	const gbk = tryDecodeBytes(bytes, 'gbk', false)
	return gbk && hasCjkCodePoint(gbk) ? gbk : utf8
}

export function bytesToLatin1(bytes: Uint8Array) {
	const chunkSize = 0x8000
	let output = ''
	for (let index = 0; index < bytes.length; index += chunkSize) {
		output += String.fromCharCode(
			...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)),
		)
	}
	return output
}

export function latin1ToBytes(value: string) {
	const bytes = new Uint8Array(value.length)
	for (let index = 0; index < value.length; index++) {
		bytes[index] = value.charCodeAt(index) & 0xff
	}
	return bytes
}

export function decodeStdin(value: string) {
	return new TextDecoder().decode(latin1ToBytes(value))
}

function zipMtime(value: Date) {
	const timestamp = value.getTime()
	if (!Number.isFinite(timestamp)) return ZIP_MIN_MTIME
	return new Date(
		Math.min(
			Math.max(timestamp, ZIP_MIN_MTIME.getTime()),
			ZIP_MAX_MTIME.getTime(),
		),
	)
}

function globMatches(name: string, pattern: string) {
	let expression = '^'
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index]
		if (character === '*') expression += '.*'
		else if (character === '?') expression += '.'
		else if (character === '[') {
			const end = pattern.indexOf(']', index + 1)
			if (end === -1) expression += '\\['
			else {
				const range = pattern.slice(index + 1, end)
				expression += `[${range.startsWith('!') ? `^${range.slice(1)}` : range}]`
				index = end
			}
		} else {
			expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
		}
	}
	return new RegExp(`${expression}$`).test(name)
}

export function matchesMember(
	name: string,
	memberPatterns: string[],
	excludes: string[],
) {
	return (
		(memberPatterns.length === 0 ||
			memberPatterns.some((pattern) => globMatches(name, pattern))) &&
		!excludes.some((pattern) => globMatches(name, pattern))
	)
}

export function archivePath(ctx: CommandContext, name: string) {
	if (name === '-') return '-'
	const resolved = ctx.fs.resolvePath(ctx.cwd, name)
	if (pathPosix.extname(resolved)) return resolved
	return `${resolved}.zip`
}

export function entryNameForPath(cwd: string, absolutePath: string) {
	const relative = pathPosix.relative(cwd, absolutePath)
	if (relative && !relative.startsWith('../') && relative !== '..') {
		return relative
	}
	return absolutePath.replace(/^\/+/, '')
}

export function safeEntryPath(destination: string, entryName: string) {
	const pathParts = entryName.split('/')
	if (
		!entryName ||
		entryName.startsWith('/') ||
		entryName.includes('\\') ||
		entryName.includes('\0') ||
		pathParts.some(
			(part, index) =>
				part === '..' || (part === '' && index !== pathParts.length - 1),
		)
	) {
		throw new Error(`unsafe archive entry: ${entryName}`)
	}
	const base = pathPosix.resolve('/', destination || '.')
	const target = pathPosix.resolve(base, entryName)
	const relative = pathPosix.relative(base, target)
	if (
		relative === '' ||
		relative.startsWith('..') ||
		pathPosix.isAbsolute(relative)
	) {
		throw new Error(`unsafe archive entry: ${entryName}`)
	}
	return target
}

function dateFromZipFields(date: number, time: number) {
	const year = 1980 + (date >> 9)
	const month = (date >> 5) & 0xf
	const day = date & 0x1f
	const hour = time >> 11
	const minute = (time >> 5) & 0x3f
	const second = (time & 0x1f) * 2
	return new Date(
		year,
		Math.max(0, month - 1),
		Math.max(1, day),
		hour,
		minute,
		second,
	)
}

export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const minimumEocdOffset = Math.max(0, bytes.length - 0x10016)
	let eocdOffset = -1
	for (let offset = bytes.length - 22; offset >= minimumEocdOffset; offset--) {
		if (view.getUint32(offset, true) === 0x06054b50) {
			eocdOffset = offset
			break
		}
	}
	if (eocdOffset === -1)
		throw new Error('End-of-central-directory signature not found')

	const entryCount = view.getUint16(eocdOffset + 10, true)
	const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true)
	if (entryCount === 0xffff || centralDirectoryOffset === 0xffffffff) {
		throw new Error('Zip64 archives are not supported')
	}

	const entries: ZipEntry[] = []
	let offset = centralDirectoryOffset
	for (let index = 0; index < entryCount; index++) {
		if (
			offset + 46 > bytes.length ||
			view.getUint32(offset, true) !== 0x02014b50
		) {
			throw new Error('Invalid central directory entry')
		}
		const compressedSize = view.getUint32(offset + 20, true)
		const uncompressedSize = view.getUint32(offset + 24, true)
		const nameLength = view.getUint16(offset + 28, true)
		const extraLength = view.getUint16(offset + 30, true)
		const commentLength = view.getUint16(offset + 32, true)
		const end = offset + 46 + nameLength + extraLength + commentLength
		if (end > bytes.length)
			throw new Error('Invalid central directory entry length')
		const flags = view.getUint16(offset + 8, true)
		const name = decodeZipEntryName(
			bytes.subarray(offset + 46, offset + 46 + nameLength),
			flags,
		)
		entries.push({
			compressedSize,
			compression: view.getUint16(offset + 10, true),
			flags,
			mtime: dateFromZipFields(
				view.getUint16(offset + 14, true),
				view.getUint16(offset + 12, true),
			),
			name,
			uncompressedSize,
		})
		offset = end
	}
	return entries
}

export async function collectPath(
	ctx: CommandContext,
	absolutePath: string,
	entryName: string,
	options: ZipCommandOptions,
	entries: ZipInput,
	archive: string,
) {
	if (absolutePath === archive) return
	const stat = await ctx.fs.stat(absolutePath)
	if (stat.isDirectory) {
		if (!options.junkPaths && entryName) {
			const directoryEntry = entryName.endsWith('/')
				? entryName
				: `${entryName}/`
			if (
				!options.excludes.some((pattern) =>
					globMatches(directoryEntry, pattern),
				)
			) {
				entries[directoryEntry] = [
					new Uint8Array(),
					{ mtime: zipMtime(stat.mtime) },
				]
			}
		}
		if (!options.recursive) return
		for (const child of await ctx.fs.readdir(absolutePath)) {
			const childPath = ctx.fs.resolvePath(absolutePath, child)
			const childEntry = entryName ? `${entryName}/${child}` : child
			await collectPath(ctx, childPath, childEntry, options, entries, archive)
		}
		return
	}

	const name = options.junkPaths ? pathPosix.basename(entryName) : entryName
	if (!name || options.excludes.some((pattern) => globMatches(name, pattern))) {
		return
	}
	entries[name] = [
		await ctx.fs.readFileBuffer(absolutePath),
		{ mtime: zipMtime(stat.mtime) },
	]
}

export function unzipList(
	archive: string,
	entries: ZipEntry[],
	verbose: boolean,
) {
	const lines = [
		`Archive:  ${archive}`,
		verbose ? '  Length   Method      Size  Name' : '  Length      Name',
	]
	let total = 0
	for (const entry of entries) {
		total += entry.uncompressedSize
		lines.push(
			verbose
				? `${String(entry.uncompressedSize).padStart(8)}  ${entry.compression === 0 ? 'Stored ' : 'Defl:N'}  ${String(entry.compressedSize).padStart(8)}  ${entry.name}`
				: `${String(entry.uncompressedSize).padStart(8)}  ${entry.name}`,
		)
	}
	lines.push(`---------                     -------`)
	lines.push(
		`${String(total).padStart(8)}                     ${entries.length} files`,
	)
	return `${lines.join('\n')}\n`
}

export function assertSupportedEntries(entries: ZipEntry[]) {
	for (const entry of entries) {
		if (entry.flags & 1) {
			throw new Error(`encrypted entry is not supported: ${entry.name}`)
		}
		if (entry.compression !== 0 && entry.compression !== 8) {
			throw new Error(`unsupported compression method for ${entry.name}`)
		}
	}
}
