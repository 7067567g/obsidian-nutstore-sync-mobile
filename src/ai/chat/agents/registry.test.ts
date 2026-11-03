import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import {
	createAgentDefinitions,
	EXPLORER_AGENT_ID,
	filterToolsForAgent,
	MASTER_AGENT_ID,
	validateAgentDefinitions,
	type AgentDefinition,
} from './registry'

function findDefinition(
	definitions: ReturnType<typeof createAgentDefinitions>,
	id: string,
) {
	const definition = definitions.find((candidate) => candidate.id === id)
	if (!definition) throw new Error(`Expected ${id} agent definition`)
	return definition
}

describe('createAgentDefinitions', () => {
	it('keeps explorer read-only regardless of full access', () => {
		const askDefinitions = createAgentDefinitions({
			fullAccess: false,
			subagents: { explorer: { enabled: true } },
		})
		const fullDefinitions = createAgentDefinitions({
			fullAccess: true,
			subagents: { explorer: { enabled: true } },
		})

		expect(fullDefinitions).not.toBe(askDefinitions)
		expect(findDefinition(askDefinitions, MASTER_AGENT_ID).permissionMode).toBe(
			'ask',
		)
		expect(
			findDefinition(fullDefinitions, MASTER_AGENT_ID).permissionMode,
		).toBe('full')
		expect(
			findDefinition(fullDefinitions, EXPLORER_AGENT_ID).permissionMode,
		).toBe('readonly')
	})

	it('has no memory subagent; master owns the memory tool', () => {
		const definitions = createAgentDefinitions({ fullAccess: false })
		expect(definitions.map((definition) => definition.id)).toEqual([
			MASTER_AGENT_ID,
			EXPLORER_AGENT_ID,
		])
		expect(findDefinition(definitions, MASTER_AGENT_ID).tools).toContain(
			'memory',
		)
		expect(findDefinition(definitions, EXPLORER_AGENT_ID).dispatchable).toBe(
			false,
		)
		expect(findDefinition(definitions, MASTER_AGENT_ID).tools).not.toContain(
			'task',
		)
	})

	it('bounds explorer recursion and tool calls per turn', () => {
		const definitions = createAgentDefinitions({
			fullAccess: false,
			subagents: { explorer: { enabled: true } },
		})
		const explorer = findDefinition(definitions, EXPLORER_AGENT_ID)
		expect(explorer.maxToolCallsPerTurn).toBe(32)
		expect(explorer.maxTaskDepth).toBe(2)
	})

	it('exposes explorer and task only when enabled', () => {
		const disabled = createAgentDefinitions({ fullAccess: false })
		expect(disabled.filter((definition) => definition.dispatchable)).toEqual([])
		expect(findDefinition(disabled, MASTER_AGENT_ID).tools).not.toContain(
			'task',
		)

		const enabled = createAgentDefinitions({
			fullAccess: false,
			subagents: { explorer: { enabled: true } },
		})
		expect(
			enabled
				.filter((definition) => definition.dispatchable)
				.map((definition) => definition.id),
		).toEqual([EXPLORER_AGENT_ID])
		expect(findDefinition(enabled, MASTER_AGENT_ID).tools).toContain('task')
	})

	it('rejects unknown or empty tool filters at startup', () => {
		const unknown: AgentDefinition = {
			id: 'unknown',
			description: 'test',
			systemPrompt: '',
			tools: ['vault_read'],
			permissionMode: 'readonly',
			dispatchable: false,
			toolFilter: { deny: ['not_a_real_tool'] },
		}
		expect(() => validateAgentDefinitions([unknown])).toThrow(
			'unknown tool "not_a_real_tool"',
		)

		const empty: AgentDefinition = {
			...unknown,
			toolFilter: { allow: [], deny: [] },
		}
		expect(() => validateAgentDefinitions([empty])).toThrow('empty toolFilter')
	})
})

describe('filterToolsForAgent', () => {
	it('keeps mcp-prefixed tools while filtering unknown built-in tools', () => {
		const tools = {
			bash: {},
			memory: {},
			unknown_builtin: {},
			'mcp__notes-search__find_notes': {},
			mcp__翻译工具__translate: {},
		} as unknown as ToolSet
		const definition = findDefinition(
			createAgentDefinitions({ fullAccess: false }),
			MASTER_AGENT_ID,
		)

		const filtered = filterToolsForAgent(tools, definition)
		expect(Object.keys(filtered).sort()).toEqual([
			'bash',
			'mcp__notes-search__find_notes',
			'mcp__翻译工具__translate',
			'memory',
		])
	})

	it('applies allow and deny to explorer, including bash denial', () => {
		const tools = {
			vault_list: {},
			vault_read: {},
			vault_batch_edit: {},
			bash: {},
			settings_patch: {},
			memory: {},
		} as unknown as ToolSet
		const definition = findDefinition(
			createAgentDefinitions({
				fullAccess: false,
				subagents: { explorer: { enabled: true } },
			}),
			EXPLORER_AGENT_ID,
		)

		const filtered = filterToolsForAgent(tools, definition)
		expect(Object.keys(filtered)).toEqual(['vault_list', 'vault_read'])
		expect(definition.tools).not.toContain('bash')
		expect(definition.toolFilter?.deny).toContain('bash')
	})
})
