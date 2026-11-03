import { resolveUsedContextTokens } from '~/ai/chat/domain'
import type { ChatboxProps } from '~/ai/chat/ui/types'
import { t } from '~/components/solid-js/i18n'

/**
 * Context-window usage derived values for the Chatbox send row.
 *
 * Mechanically extracted from `Chatbox.tsx` (P7); no behavior change.
 */
export function useContextUsage(props: ChatboxProps) {
	const contextUsedTokens = () => resolveUsedContextTokens(props.usage)
	const contextUsageRatio = () => {
		const total = props.contextWindow
		if (!total || total <= 0) return 0
		const used = contextUsedTokens()
		if (used <= 0) return 0
		return Math.min(1, Math.max(0, used / total))
	}
	const contextUsageTitle = () => {
		const total = props.contextWindow
		if (!total) return undefined
		const usedPct = Math.round(contextUsageRatio() * 100)
		const used = contextUsedTokens()
		return t('chatbox.ui.tooltips.contextUsage', {
			used: usedPct,
			total,
			usedTokens: used,
		})
	}

	return { contextUsedTokens, contextUsageTitle }
}
