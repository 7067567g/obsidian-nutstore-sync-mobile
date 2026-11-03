import type { ChatDisplayReasoningBlock } from '~/ai/chat/types'
import { t } from '~/components/solid-js/i18n'
import { TitledCollapsibleBlock } from './CollapsibleBlock'

export function ReasoningBlock(props: {
	part: ChatDisplayReasoningBlock['part']
	open?: boolean
}) {
	return (
		<TitledCollapsibleBlock
			title={t('chatbox.ui.labels.reasoning')}
			iconClass=":uno: i-lucide-brain"
			open={props.open}
		>
			<pre class=":uno: m-0 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--text-muted)]">
				{props.part.text ?? ''}
			</pre>
		</TitledCollapsibleBlock>
	)
}
