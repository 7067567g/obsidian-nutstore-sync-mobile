import { invalidPatch, type PatchHunk } from './apply-patch-parse'

function findMatchingBlock(
	lines: string[],
	block: string[],
	start: number,
	path: string,
) {
	if (block.length === 0) {
		return start
	}
	const matches: number[] = []
	for (let index = start; index <= lines.length - block.length; index += 1) {
		if (block.every((line, offset) => lines[index + offset] === line)) {
			matches.push(index)
		}
	}
	if (matches.length === 0) {
		invalidPatch(`hunk context was not found in "${path}"`)
	}
	if (matches.length > 1) {
		invalidPatch(
			`hunk context matched ${matches.length} locations in "${path}"; include more context`,
		)
	}
	return matches[0]
}

export function applyHunks(content: string, hunks: PatchHunk[], path: string) {
	const newline = content.includes('\r\n') ? '\r\n' : '\n'
	const hasFinalNewline = content.endsWith('\n')
	const lines =
		content === ''
			? []
			: content
					.replace(/\r\n/g, '\n')
					.split('\n')
					.slice(0, hasFinalNewline ? -1 : undefined)
	let cursor = 0

	for (const hunk of hunks) {
		const oldLines = hunk.lines
			.filter((line) => line.kind !== 'add')
			.map((line) => line.text)
		const newLines = hunk.lines
			.filter((line) => line.kind !== 'delete')
			.map((line) => line.text)

		let searchStart = cursor
		if (hunk.header) {
			const headerMatches = lines
				.map((line, index) => ({ line, index }))
				.filter(
					(entry) =>
						entry.index >= cursor &&
						(entry.line === hunk.header || entry.line.includes(hunk.header)),
				)
			if (headerMatches.length === 0) {
				invalidPatch(`hunk header "${hunk.header}" was not found in "${path}"`)
			}
			if (headerMatches.length > 1) {
				invalidPatch(`hunk header "${hunk.header}" is not unique in "${path}"`)
			}
			searchStart = headerMatches[0].index
		}

		if (oldLines.length === 0 && !hunk.endOfFile && !hunk.header) {
			if (lines.length !== 0) {
				invalidPatch(
					`insertion in "${path}" needs context, a @@ header, or "*** End of File"`,
				)
			}
			searchStart = 0
		}
		const matchIndex = hunk.endOfFile
			? lines.length - oldLines.length
			: findMatchingBlock(lines, oldLines, searchStart, path)
		if (
			matchIndex < searchStart ||
			!oldLines.every((line, offset) => lines[matchIndex + offset] === line)
		) {
			invalidPatch(`end-of-file hunk context was not found in "${path}"`)
		}
		lines.splice(matchIndex, oldLines.length, ...newLines)
		cursor = matchIndex + newLines.length
	}

	const result = lines.join(newline)
	return hasFinalNewline && lines.length > 0 ? `${result}${newline}` : result
}
