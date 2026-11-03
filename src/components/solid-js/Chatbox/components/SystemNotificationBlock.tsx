import type { ChatDisplaySystemNotificationBlock } from '~/ai/chat/types'
import type { ChatboxProps } from '~/ai/chat/ui/types'
import { t } from '~/components/solid-js/i18n'
import { formatSystemNotificationMarkdown } from '~/components/solid-js/Chatbox/utils'
import { TitledCollapsibleBlock } from './CollapsibleBlock'
import { MarkdownContent } from './MarkdownContent'

export function SystemNotificationBlock(props: {
	block: ChatDisplaySystemNotificationBlock
	renderMarkdown?: ChatboxProps['renderMarkdown']
}) {
	return (
		<TitledCollapsibleBlock
			title={t('chatbox.ui.labels.systemNotification')}
			iconClass=":uno: i-lucide-bell"
		>
			<MarkdownContent
				markdown={formatSystemNotificationMarkdown(props.block.notification)}
				renderMarkdown={props.renderMarkdown}
				compact
				details
			/>
		</TitledCollapsibleBlock>
	)
}
