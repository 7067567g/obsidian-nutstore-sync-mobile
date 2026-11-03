type PatchLineKind = 'context' | 'add' | 'delete'

export interface PatchLine {
	kind: PatchLineKind
	text: string
}

export interface PatchHunk {
	header: string
	lines: PatchLine[]
	endOfFile: boolean
}

export type PatchOperation =
	| { kind: 'add'; path: string; content: string }
	| { kind: 'delete'; path: string }
	| {
			kind: 'update'
			path: string
			moveTo?: string
			hunks: PatchHunk[]
	  }

export function invalidPatch(reason: string): never {
	throw new Error(`Invalid patch: ${reason}`)
}

function parseFileHeader(line: string, prefix: string) {
	const path = line.slice(prefix.length).trim()
	if (!path) {
		invalidPatch(`missing path after ${prefix.trim()}`)
	}
	return path
}

function parseHunkHeader(line: string) {
	const header = line.slice(2).trim()
	const unifiedHeader = header.match(
		/^-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@(?:\s+(.*))?$/,
	)
	return unifiedHeader ? (unifiedHeader[1]?.trim() ?? '') : header
}

export function parsePatch(patch: string): PatchOperation[] {
	const lines = patch.replace(/\r\n/g, '\n').split('\n')
	if (lines[0] !== '*** Begin Patch') {
		invalidPatch('the first line must be "*** Begin Patch"')
	}

	let endIndex = lines.length - 1
	while (endIndex > 0 && lines[endIndex] === '') {
		endIndex -= 1
	}
	if (lines[endIndex] !== '*** End Patch') {
		invalidPatch('the last line must be "*** End Patch"')
	}

	const operations: PatchOperation[] = []
	let index = 1
	while (index < endIndex) {
		const line = lines[index]
		if (line.startsWith('*** Add File: ')) {
			const path = parseFileHeader(line, '*** Add File: ')
			index += 1
			const content: string[] = []
			while (index < endIndex && !lines[index].startsWith('*** ')) {
				if (!lines[index].startsWith('+')) {
					invalidPatch(
						`added file "${path}" contains a line without a + prefix`,
					)
				}
				content.push(lines[index].slice(1))
				index += 1
			}
			operations.push({
				kind: 'add',
				path,
				content: content.length > 0 ? `${content.join('\n')}\n` : '',
			})
			continue
		}

		if (line.startsWith('*** Delete File: ')) {
			operations.push({
				kind: 'delete',
				path: parseFileHeader(line, '*** Delete File: '),
			})
			index += 1
			continue
		}

		if (line.startsWith('*** Update File: ')) {
			const path = parseFileHeader(line, '*** Update File: ')
			index += 1
			let moveTo: string | undefined
			if (lines[index]?.startsWith('*** Move to: ')) {
				moveTo = parseFileHeader(lines[index], '*** Move to: ')
				index += 1
			}

			const hunks: PatchHunk[] = []
			while (index < endIndex && !lines[index].startsWith('*** ')) {
				if (!lines[index].startsWith('@@')) {
					invalidPatch(`expected a @@ hunk header while updating "${path}"`)
				}
				const header = parseHunkHeader(lines[index])
				index += 1
				const hunkLines: PatchLine[] = []
				let endOfFile = false
				while (
					index < endIndex &&
					!lines[index].startsWith('@@') &&
					!lines[index].startsWith('*** ')
				) {
					const prefix = lines[index][0]
					const kind =
						prefix === ' '
							? 'context'
							: prefix === '+'
								? 'add'
								: prefix === '-'
									? 'delete'
									: undefined
					if (!kind) {
						invalidPatch(
							`hunk for "${path}" contains a line without a space, +, or - prefix`,
						)
					}
					hunkLines.push({ kind, text: lines[index].slice(1) })
					index += 1
				}
				if (lines[index] === '*** End of File') {
					endOfFile = true
					index += 1
				}
				if (hunkLines.length === 0) {
					invalidPatch(`empty hunk while updating "${path}"`)
				}
				hunks.push({ header, lines: hunkLines, endOfFile })
			}
			if (hunks.length === 0 && !moveTo) {
				invalidPatch(`update for "${path}" has no hunks`)
			}
			operations.push({ kind: 'update', path, moveTo, hunks })
			continue
		}

		invalidPatch(`unexpected line "${line}"`)
	}

	if (operations.length === 0) {
		invalidPatch('no file operations were provided')
	}
	return operations
}
