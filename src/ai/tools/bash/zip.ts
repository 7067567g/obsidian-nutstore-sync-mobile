import { unzipSync, zipSync, type ZipOptions } from 'fflate/browser'
import {
	defineCommand,
	type CommandContext,
	type ExecResult,
} from 'just-bash/browser'
import {
	commandError,
	commandHelp,
	parseUnzipArgs,
	parseZipArgs,
} from './zip-args'
import {
	archivePath,
	assertSupportedEntries,
	bytesToLatin1,
	collectPath,
	decodeStdin,
	entryNameForPath,
	latin1ToBytes,
	matchesMember,
	readZipEntries,
	safeEntryPath,
	unzipList,
	type ZipInput,
} from './zip-format'

export const UNZIP_MAX_DECOMPRESSED_SIZE = 128 * 1024 * 1024

async function createZip(
	args: string[],
	ctx: CommandContext,
): Promise<ExecResult> {
	const options = parseZipArgs(args)
	if ('exitCode' in options) return options
	const archiveName = options.archive
	if (!archiveName) return commandHelp('zip')

	try {
		const archive = archivePath(ctx, archiveName)
		const entries: ZipInput = {}
		if (archive !== '-' && (await ctx.fs.exists(archive))) {
			Object.assign(entries, unzipSync(await ctx.fs.readFileBuffer(archive)))
		}

		const inputs = [...options.inputs]
		if (options.readInputsFromStdin) {
			inputs.push(
				...decodeStdin(ctx.stdin as unknown as string)
					.split(/\r?\n/)
					.filter(Boolean),
			)
		}
		if (inputs.length === 0) return commandError('zip', 'Nothing to do!')

		for (const input of inputs) {
			if (input === '-') {
				entries['-'] = latin1ToBytes(ctx.stdin as unknown as string)
				continue
			}
			const inputPath = ctx.fs.resolvePath(ctx.cwd, input)
			await collectPath(
				ctx,
				inputPath,
				entryNameForPath(ctx.cwd, inputPath),
				options,
				entries,
				archive,
			)
		}

		if (Object.keys(entries).length === 0) {
			return commandError('zip', 'Nothing to do!')
		}
		const archiveBytes = zipSync(entries, {
			level: options.level as ZipOptions['level'],
		})
		if (archive === '-') {
			return {
				stdout: bytesToLatin1(archiveBytes),
				stderr: '',
				exitCode: 0,
				stdoutKind: 'bytes',
			}
		}
		await ctx.fs.writeFile(archive, archiveBytes)
		return {
			stdout: options.quiet
				? ''
				: Object.keys(entries)
						.sort()
						.map((name) => `  adding: ${name} (deflated 0%)\n`)
						.join(''),
			stderr: '',
			exitCode: 0,
		}
	} catch (error) {
		return commandError(
			'zip',
			error instanceof Error ? error.message : String(error),
		)
	}
}

async function extractZip(
	args: string[],
	ctx: CommandContext,
): Promise<ExecResult> {
	const options = parseUnzipArgs(args)
	if ('exitCode' in options) return options
	const archiveName = options.archive
	if (!archiveName) return commandHelp('unzip')

	try {
		const archive = archivePath(ctx, archiveName)
		const archiveBytes =
			archive === '-'
				? latin1ToBytes(ctx.stdin as unknown as string)
				: await ctx.fs.readFileBuffer(archive)
		const allEntries = readZipEntries(archiveBytes)
		const entries = allEntries.filter((entry) =>
			matchesMember(entry.name, options.memberPatterns, options.excludes),
		)
		if (entries.length === 0) {
			return commandError('unzip', 'caution: filename not matched')
		}
		if (options.list || options.verbose) {
			return {
				stdout: unzipList(archiveName, entries, options.verbose),
				stderr: '',
				exitCode: 0,
			}
		}

		assertSupportedEntries(entries)
		const totalSize = entries.reduce(
			(total, entry) => total + entry.uncompressedSize,
			0,
		)
		if (totalSize > UNZIP_MAX_DECOMPRESSED_SIZE) {
			return commandError(
				'unzip',
				`decompressed data exceeds limit (${UNZIP_MAX_DECOMPRESSED_SIZE} bytes)`,
			)
		}
		const selected = new Set(entries.map((entry) => entry.name))
		const files = unzipSync(archiveBytes, {
			filter: (file) => selected.has(file.name),
		})

		if (options.test) {
			return {
				stdout: options.quiet
					? ''
					: `${entries.map((entry) => `    testing: ${entry.name}   OK`).join('\n')}\nNo errors detected in compressed data.\n`,
				stderr: '',
				exitCode: 0,
			}
		}
		if (options.pipe) {
			const output = entries
				.filter((entry) => !entry.name.endsWith('/'))
				.map((entry) => files[entry.name])
				.filter((file): file is Uint8Array => file !== undefined)
				.map(bytesToLatin1)
				.join('')
			return { stdout: output, stderr: '', exitCode: 0, stdoutKind: 'bytes' }
		}

		const destination = ctx.fs.resolvePath(ctx.cwd, options.destination ?? '.')
		const targets = entries.map((entry) => ({
			entry,
			target: safeEntryPath(destination, entry.name),
		}))
		if (!options.overwrite && !options.neverOverwrite) {
			for (const { entry, target } of targets) {
				if (!entry.name.endsWith('/') && (await ctx.fs.exists(target))) {
					return commandError(
						'unzip',
						`replace ${target}? Use -o to overwrite or -n to skip existing files`,
					)
				}
			}
		}

		const output: string[] = []
		for (const { entry, target } of targets) {
			if (entry.name.endsWith('/')) {
				await ctx.fs.mkdir(target, { recursive: true })
				continue
			}
			if (options.neverOverwrite && (await ctx.fs.exists(target))) {
				if (!options.quiet) output.push(`  skipping: ${entry.name}`)
				continue
			}
			const data = files[entry.name]
			if (!data)
				return commandError('unzip', `missing archive entry: ${entry.name}`)
			await ctx.fs.writeFile(target, data)
			await ctx.fs.utimes(target, entry.mtime, entry.mtime)
			if (!options.quiet) output.push(` extracting: ${entry.name}`)
		}
		return {
			stdout: output.length ? `${output.join('\n')}\n` : '',
			stderr: '',
			exitCode: 0,
		}
	} catch (error) {
		return commandError(
			'unzip',
			error instanceof Error ? error.message : String(error),
		)
	}
}

export const archiveCommands = [
	defineCommand('zip', createZip),
	defineCommand('unzip', extractZip),
]
