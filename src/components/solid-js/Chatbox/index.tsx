import type { ChatboxProps } from '~/ai/chat/ui/types'
import { createMount } from '~/components/solid-js/mount'
import Chatbox from './Chatbox'
import { prepareChatboxProps } from './mount-props'

export function mountChatbox(el: Element, props: ChatboxProps) {
	return createMount(Chatbox, el, props, { prepareProps: prepareChatboxProps })
}
