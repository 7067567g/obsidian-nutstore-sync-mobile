export const BASH_DEFAULT_MAX_WRITE_BYTES = 64 * 1024 * 1024
export const BASH_DEFAULT_MAX_WRITE_OPERATIONS = 2000
export const BASH_DEFAULT_MAX_RECURSION_DEPTH = 32

export interface BashResourceLimits {
	maxWriteBytes?: number
	maxWriteOperations?: number
	maxRecursionDepth?: number
}

/** Per-command write-volume/recursion budget for the virtual filesystem. */
export class BashResourceBudget {
	private writeBytes = 0
	private writeOperations = 0

	constructor(private readonly limits: BashResourceLimits = {}) {}

	recordWrite(bytes: number) {
		const maxBytes = this.limits.maxWriteBytes ?? BASH_DEFAULT_MAX_WRITE_BYTES
		const maxOperations =
			this.limits.maxWriteOperations ?? BASH_DEFAULT_MAX_WRITE_OPERATIONS
		if (this.writeOperations + 1 > maxOperations) {
			throw new Error(
				'TOOL_RESOURCE_EXCEEDED: bash write operation limit reached (' +
					maxOperations +
					' operation(s)); narrow the command or split it into smaller steps.',
			)
		}
		if (this.writeBytes + bytes > maxBytes) {
			throw new Error(
				'TOOL_RESOURCE_EXCEEDED: bash write volume exceeds ' +
					maxBytes +
					' bytes; narrow the command or use a smaller batch.',
			)
		}
		this.writeOperations += 1
		this.writeBytes += bytes
	}

	checkRecursionDepth(depth: number) {
		const maxDepth =
			this.limits.maxRecursionDepth ?? BASH_DEFAULT_MAX_RECURSION_DEPTH
		if (depth > maxDepth) {
			throw new Error(
				'TOOL_RESOURCE_EXCEEDED: bash recursion depth exceeds ' +
					maxDepth +
					'; narrow the recursive command.',
			)
		}
	}
}

export function createBashResourceBudget(limits?: BashResourceLimits) {
	return new BashResourceBudget(limits)
}
