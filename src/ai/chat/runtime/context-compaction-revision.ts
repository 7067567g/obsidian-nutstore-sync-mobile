import type { ChatSession } from '~/ai/chat/domain'
import type { AIModelConfig, AIProviderConfig } from '~/ai/core/types'

/** Immutable identity of the model and session settings used by compaction. */
export function createContextCompactionRevision(
	session: ChatSession,
	provider: AIProviderConfig,
	model: AIModelConfig,
	backend?: 'deterministic' | 'llm',
) {
	return JSON.stringify({
		providerId: provider.id,
		modelId: model.id,
		backend: backend ?? null,
		systemPrompt: session.systemPrompt ?? null,
		disabledMcpServers: session.disabledMcpServers ?? [],
	})
}
