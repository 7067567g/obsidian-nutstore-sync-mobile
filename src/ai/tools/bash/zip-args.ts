import type { ExecResult } from 'just-bash/browser'

interface ZipCommandOptions {
	archive?: string
	excludes: string[]
	inputs: string[]
	junkPaths: boolean
	level: number
	quiet: boolean
	readInputsFromStdin: boolean
	recursive: boolean
}

interface UnzipCommandOptions {
	archive?: string
	destination?: string
	excludes: string[]
	list: boolean
	memberPatterns: string[]
	neverOverwrite: boolean
	overwrite: boolean
	pipe: boolean
	quiet: boolean
	test: boolean
	verbose: boolean
}

export function commandError(command: string, message: string): ExecResult {
	return { stdout: '', stderr: `${command}: ${message}\n`, exitCode: 1 }
}

export function commandHelp(command: 'zip' | 'unzip'): ExecResult {
	return command === 'zip'
		? {
				stdout:
					'usage: zip [-0-9jrq@] archive[.zip] file ... [-x pattern ...]\n',
				stderr: '',
				exitCode: 0,
			}
		: {
				stdout:
					'usage: unzip [-lptvnoq] archive[.zip] [member ...] [-x pattern ...] [-d directory]\n',
				stderr: '',
				exitCode: 0,
			}
}

export function parseZipArgs(args: string[]): ZipCommandOptions | ExecResult {
	const options: ZipCommandOptions = {
		excludes: [],
		inputs: [],
		junkPaths: false,
		level: 6,
		quiet: false,
		readInputsFromStdin: false,
		recursive: false,
	}
	let parseOptions = true

	for (let index = 0; index < args.length; index++) {
		const argument = args[index]
		if (parseOptions && argument === '--') {
			parseOptions = false
			continue
		}
		if (parseOptions && (argument === '-h' || argument === '--help')) {
			return commandHelp('zip')
		}
		if (parseOptions && argument === '-x') {
			options.excludes.push(...args.slice(index + 1))
			break
		}
		if (parseOptions && argument === '-@') {
			options.readInputsFromStdin = true
			continue
		}
		if (parseOptions && argument.startsWith('-') && argument !== '-') {
			for (const flag of argument.slice(1)) {
				if (flag === 'r') options.recursive = true
				else if (flag === 'j') options.junkPaths = true
				else if (flag === 'q') options.quiet = true
				else if (/^[0-9]$/.test(flag)) options.level = Number(flag)
				else return commandError('zip', `unsupported option -${flag}`)
			}
			continue
		}
		if (!options.archive) {
			options.archive = argument
		} else {
			options.inputs.push(argument)
		}
	}

	if (!options.archive) {
		options.archive = '-'
		options.inputs.push('-')
	}
	if (options.archive === '-' && options.inputs.length === 0) {
		options.inputs.push('-')
	}
	return options
}

export function parseUnzipArgs(
	args: string[],
): UnzipCommandOptions | ExecResult {
	const options: UnzipCommandOptions = {
		excludes: [],
		list: false,
		memberPatterns: [],
		neverOverwrite: false,
		overwrite: false,
		pipe: false,
		quiet: false,
		test: false,
		verbose: false,
	}
	let parseOptions = true

	for (let index = 0; index < args.length; index++) {
		const argument = args[index]
		if (parseOptions && argument === '--') {
			parseOptions = false
			continue
		}
		if (parseOptions && (argument === '-h' || argument === '--help')) {
			return commandHelp('unzip')
		}
		if (parseOptions && argument === '-x') {
			options.excludes.push(...args.slice(index + 1))
			break
		}
		if (parseOptions && (argument === '-d' || argument.startsWith('-d'))) {
			const destination = argument === '-d' ? args[++index] : argument.slice(2)
			if (!destination)
				return commandError('unzip', 'option -d requires a directory')
			options.destination = destination
			continue
		}
		if (parseOptions && argument.startsWith('-') && argument !== '-') {
			for (const flag of argument.slice(1)) {
				if (flag === 'l') options.list = true
				else if (flag === 'v') options.verbose = true
				else if (flag === 'p' || flag === 'c') options.pipe = true
				else if (flag === 't') options.test = true
				else if (flag === 'n') options.neverOverwrite = true
				else if (flag === 'o') options.overwrite = true
				else if (flag === 'q') options.quiet = true
				else return commandError('unzip', `unsupported option -${flag}`)
			}
			continue
		}
		if (!options.archive) {
			options.archive = argument
		} else {
			options.memberPatterns.push(argument)
		}
	}

	if (!options.archive) return commandHelp('unzip')
	if (options.neverOverwrite && options.overwrite) {
		return commandError('unzip', 'options -n and -o cannot be used together')
	}
	return options
}

export type { UnzipCommandOptions, ZipCommandOptions }
