import type { ToolSet } from 'ai'
import { isMcpToolName } from '~/ai/mcp/types'

export type AgentPermissionMode = 'ask' | 'readonly' | 'full'

export interface AgentToolFilter {
	/** Optional allow-list; when omitted the definition's tools list is the base. */
	allow?: readonly string[]
	/** Tools removed even if present in the definition's tools list. */
	deny?: readonly string[]
}

export interface AgentDefinition {
	id: string
	description: string
	systemPrompt: string
	tools: readonly string[]
	permissionMode: AgentPermissionMode
	/** Whether this agent type can be dispatched via the `task` tool. */
	dispatchable: boolean
	/** Optional runtime tool policy, validated at startup. */
	toolFilter?: AgentToolFilter
	/** Hard per-turn tool-call budget for bounded subagents. */
	maxToolCallsPerTurn?: number
	/** Maximum task-tree depth this agent may observe; defaults to global. */
	maxTaskDepth?: number
}

export interface AgentDefinitionSettings {
	fullAccess: boolean
	subagents?: {
		explorer?: { enabled?: boolean }
		/** Legacy setting retained for settings migration; no memory subagent exists. */
		memory?: { enabled?: boolean }
	}
}

export const MASTER_AGENT_ID = 'master'
export const EXPLORER_AGENT_ID = 'explorer'

const KNOWN_BUILTIN_TOOL_NAMES = new Set([
	'vault_list',
	'vault_read',
	'vault_stat',
	'vault_json',
	'vault_hash',
	'vault_grep',
	'vault_links',
	'vault_frontmatter',
	'vault_batch_edit',
	'view_pdf',
	'view_image',
	'settings_read',
	'settings_patch',
	'bash',
	'apply_patch',
	'todowrite',
	'update_session_title',
	'task',
	'memory',
])

const MASTER_SYSTEM_PROMPT = [
	'You are the AI agent (ChatBox) built into the Nutstore Sync Obsidian plugin, which synchronizes an Obsidian vault with Nutstore over WebDAV.',
	'You may receive workspace context in <AdditionalContext> XML blocks prepended to user messages.',
	'Each block contains only the workspace fields that changed since the previous message (a delta).',
	'For changed fields, the value is the complete current state — for example, if openFiles shrinks, files no longer in the list have been closed. Silently update your understanding of the workspace; do not mention or quote the XML structure itself.',
	'When workspace context includes skills, each entry contains a skill name, description, and path. If the current task matches one, use bash to read the complete SKILL.md at that path before following its instructions. An explicit user request for a named available skill must also load it first.',
	'Treat every Skill path as an opaque absolute path: copy it exactly from workspace context and never construct, normalize, or substitute a different path from the Skill name.',
	'Paths under /.agents/skills are user-defined Vault Skills; paths under /.agents/nutstore-sync/builtin-skills are bundled built-in Skills. These namespaces are distinct and are not interchangeable.',
	'Hidden dot-folders are internal; do not expose their paths or contents unless the user explicitly asks about them. Never guess or fabricate credentials.',
	'Prefer native vault_list, vault_read, vault_stat, vault_json, vault_hash, vault_grep, vault_links, vault_frontmatter, vault_batch_edit, view_pdf, settings_read, and settings_patch tools over bash for ordinary vault, agent-data, and plugin-settings operations. Use bash only when a shell pipeline or unsupported path is actually required.',
	'For vault_grep, directory/root searches default to markdown and are budget-bounded; pass glob (for example "*.json") or extensions/includeAttachments (for example ["json","ts"] / includeAttachments:true) to search other formats, use vault_stat to find file names, and use desktop MCP for complete vault-wide searches. Tool output that says incomplete is a partial result, not a no-match result.',
	'Long-term memory is handled by the native memory tool. Use it to add, list, and remove durable cross-session facts; keep each item concise (under 300 characters) and the whole memory under 8000 characters. Do not read, search, or modify the memory folder yourself with bash or other file tools.',
].join('\n')

const EXPLORER_SYSTEM_PROMPT = [
	'You are a read-only explorer subagent investigating an Obsidian vault.',
	'You operate in an isolated context and cannot see the caller conversation; your only input is the task prompt.',
	'Gather evidence with available read-only vault tools. You cannot edit, create, or delete files.',
	'Base every conclusion on tool output and cite the file paths or commands that support it.',
	'When citing vault files, use their vault-relative path (for example notes/idea.md), matching the path the user sees inside the vault.',
	'Hidden dot-folders are internal; do not expose their paths or contents unless the task explicitly asks to inspect them.',
	'Prefer native vault_list, vault_read, vault_stat, vault_json, vault_hash, vault_grep, vault_links, and view_pdf tools over bash for ordinary vault and agent-data inspection.',
	'For vault_grep, directory/root searches default to markdown and are budget-bounded; pass glob (for example "*.json") or extensions/includeAttachments (for example ["json","ts"] / includeAttachments:true) to search other formats, use vault_stat to find file names, and use desktop MCP for complete vault-wide searches. Tool output that says incomplete is a partial result, not a no-match result.',
	'If evidence is insufficient or conflicting, say so explicitly rather than guessing.',
	'Return a concise, grounded final answer. Do not ask questions — make reasonable assumptions and note any limitations.',
].join('\n')

const EXPLORER_ALLOWED_TOOLS = [
	'vault_list',
	'vault_read',
	'vault_stat',
	'vault_json',
	'vault_hash',
	'vault_grep',
	'vault_links',
	'view_pdf',
	'view_image',
	'task',
] as const

function createMasterAgentDefinition(
	{ fullAccess }: AgentDefinitionSettings,
	canDispatch: boolean,
): AgentDefinition {
	return {
		id: MASTER_AGENT_ID,
		description: 'Main conversational assistant with full vault access.',
		systemPrompt: MASTER_SYSTEM_PROMPT,
		tools: [
			'vault_list',
			'vault_read',
			'vault_stat',
			'vault_json',
			'vault_hash',
			'vault_grep',
			'vault_links',
			'vault_frontmatter',
			'vault_batch_edit',
			'view_pdf',
			'view_image',
			'settings_read',
			'settings_patch',
			'bash',
			'apply_patch',
			'todowrite',
			'update_session_title',
			'memory',
			...(canDispatch ? ['task'] : []),
		],
		permissionMode: fullAccess ? 'full' : 'ask',
		dispatchable: false,
	}
}

function createExplorerAgentDefinition(
	enabled: boolean,
	canDispatch: boolean,
): AgentDefinition {
	return {
		id: EXPLORER_AGENT_ID,
		description:
			'Read-only subagent for exploring the vault and answering questions about its contents without modifying files.',
		systemPrompt: EXPLORER_SYSTEM_PROMPT,
		tools: [
			...EXPLORER_ALLOWED_TOOLS,
			...(canDispatch ? (['task'] as const) : []),
		],
		permissionMode: 'readonly',
		dispatchable: enabled,
		toolFilter: {
			allow: [...EXPLORER_ALLOWED_TOOLS, 'task'],
			deny: ['bash', 'vault_batch_edit', 'apply_patch', 'settings_patch'],
		},
		maxToolCallsPerTurn: 32,
		maxTaskDepth: 2,
	}
}

function assertToolNamesAreKnown(definition: AgentDefinition) {
	const filter = definition.toolFilter
	if (!filter) return
	const allow = filter.allow ?? []
	const deny = filter.deny ?? []
	if (allow.length === 0 && deny.length === 0) {
		throw new Error(
			`Subagent ${definition.id} has an empty toolFilter; refusing to start.`,
		)
	}
	for (const name of [...allow, ...deny]) {
		if (isMcpToolName(name)) continue
		if (!KNOWN_BUILTIN_TOOL_NAMES.has(name)) {
			throw new Error(
				`Subagent ${definition.id} references unknown tool "${name}" in toolFilter.`,
			)
		}
	}
}

export function validateAgentDefinitions(
	definitions: readonly AgentDefinition[],
): void {
	for (const definition of definitions) assertToolNamesAreKnown(definition)
}

export function createAgentDefinitions(
	settings: AgentDefinitionSettings = { fullAccess: false },
) {
	const explorerEnabled = settings.subagents?.explorer?.enabled === true
	const canDispatch = explorerEnabled
	const definitions = [
		createMasterAgentDefinition(settings, canDispatch),
		createExplorerAgentDefinition(explorerEnabled, canDispatch),
	]
	validateAgentDefinitions(definitions)
	return definitions
}

export function getAgentDefinition(
	type: string,
	settings?: AgentDefinitionSettings,
): AgentDefinition | undefined {
	return createAgentDefinitions(settings).find(
		(definition) => definition.id === type,
	)
}

export function listDispatchableDefinitions(
	settings?: AgentDefinitionSettings,
) {
	return createAgentDefinitions(settings).filter(
		(definition) => definition.dispatchable,
	)
}

export function filterToolsForAgent<T extends ToolSet>(
	tools: T,
	definition: AgentDefinition,
): T {
	const baseTools = new Set(definition.tools)
	const allow = definition.toolFilter?.allow
		? new Set(definition.toolFilter.allow)
		: undefined
	const deny = new Set(definition.toolFilter?.deny ?? [])
	return Object.fromEntries(
		Object.entries(tools).filter(([name]) => {
			if (isMcpToolName(name)) return !deny.has(name)
			if (!baseTools.has(name)) return false
			if (deny.has(name)) return false
			if (allow && !allow.has(name)) return false
			return true
		}),
	) as T
}
