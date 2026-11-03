import { z } from 'zod/mini'
import { tool } from 'ai'
import { appDep, readTrackerDep } from './tool-context'
import { executeVaultGrep } from './vault-grep-execute'

export {
	VAULT_GREP_DEFAULT_DEADLINE_MS,
	VAULT_GREP_DEFAULT_MAX_FILES,
	VAULT_GREP_DEFAULT_MAX_TOTAL_BYTES,
	VAULT_GREP_MAX_PATTERN_LENGTH,
} from './vault-grep-constants'
export { assertSafeGrepPattern } from './vault-grep-pattern'
export { executeVaultGrep }

export const vaultGrepTool = tool({
	description: [
		'Search text content in the Obsidian vault using the vault index and cachedRead; never builds a browser-bash filesystem.',
		'Use this instead of bash rg/grep for ordinary vault notes. Input path is a vault virtual path.',
		'pattern is a JavaScript regular expression; nested quantifiers and patterns longer than 400 characters are rejected before execution because regex evaluation cannot be preempted.',
		'Folder/root searches default to markdown files. Pass extensions (for example ["json","ts"]) or includeAttachments:true to widen the search; explicit glob still filters paths.',
		'Directory/root searches default to markdown files only and run under a bounded budget (1000 files / 64 MiB / 15 s). Pass an explicit glob (for example "*.json") to search other text formats; if the result says incomplete, narrow path/glob or use desktop MCP for a complete vault-wide search.',
		'Use vault_stat for filename searches instead of grepping for file names.',
		'Hidden dot-directories are only searchable one explicit file at a time; use desktop MCP for large minified bundles or repository-wide searches.',
	].join(' '),
	inputSchema: z.object({
		path: z.optional(z.string()),
		pattern: z.string(),
		glob: z.optional(z.string()),
		extensions: z.optional(z.array(z.string())),
		includeAttachments: z.optional(z.boolean()),
		caseSensitive: z.optional(z.boolean()),
		maxResults: z.optional(z.number()),
	}),
	contextSchema: z.object({
		app: appDep,
		readTracker: readTrackerDep,
	}),
	outputSchema: z.string(),
	execute: async (
		{
			path,
			pattern,
			glob,
			extensions,
			includeAttachments,
			caseSensitive,
			maxResults,
		},
		{ context, abortSignal },
	) => {
		const result = await executeVaultGrep(context.app, path ?? '/', pattern, {
			glob,
			extensions,
			includeAttachments,
			caseSensitive,
			maxResults,
			abortSignal,
			onRead: context.readTracker?.markRead.bind(context.readTracker),
		})
		return result
	},
})
