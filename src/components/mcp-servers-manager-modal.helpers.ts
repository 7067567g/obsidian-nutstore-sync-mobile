import type { McpServerConfigs } from '~/ai/mcp/types'

export function cloneHttpConfig(config: McpServerConfigs[string]) {
	return {
		type: 'http' as const,
		url: config.url,
		headers: config.headers ? { ...config.headers } : undefined,
		enabled: config.enabled,
	}
}
