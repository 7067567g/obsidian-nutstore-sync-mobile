import { createEffect, createSignal, onCleanup } from 'solid-js'
import { CHATBOX_DIALOG_CONTAINED_MIN_WIDTH } from '~/ai/chat/ui/modal-mount'

const COMPACT_LAYOUT_MAX_WIDTH = 768
const SM_MAX_WIDTH = 640

export interface ChatboxLayoutRefs {
	rootEl: () => HTMLDivElement | undefined
	splitLayoutEl: () => HTMLDivElement | undefined
	inputPaneEl: () => HTMLDivElement | undefined
	messagesEl: () => HTMLDivElement | undefined
}

/**
 * Responsive layout + owner-document lookup for the Chatbox container.
 *
 * Mechanically extracted from `Chatbox.tsx` (P7); no behavior change.
 */
export function useChatboxLayout(refs: ChatboxLayoutRefs) {
	const [chatboxContainerWidth, setChatboxContainerWidth] = createSignal(0)

	function getViewDocument() {
		return (
			refs.splitLayoutEl()?.ownerDocument ??
			refs.inputPaneEl()?.ownerDocument ??
			refs.messagesEl()?.ownerDocument ??
			document
		)
	}

	function getViewWindow() {
		return getViewDocument().defaultView ?? window
	}

	function isCompactLayout() {
		const width = chatboxContainerWidth() || refs.rootEl()?.clientWidth || 0
		if (width > 0) {
			return width <= COMPACT_LAYOUT_MAX_WIDTH
		}
		return getViewWindow().innerWidth <= COMPACT_LAYOUT_MAX_WIDTH
	}

	function isSmallChatbox() {
		const width = chatboxContainerWidth() || refs.rootEl()?.clientWidth || 0
		if (width > 0) {
			return width < SM_MAX_WIDTH
		}
		return getViewWindow().innerWidth < SM_MAX_WIDTH
	}

	function dialogMountTarget() {
		const rootEl = refs.rootEl()
		const contained =
			chatboxContainerWidth() >= CHATBOX_DIALOG_CONTAINED_MIN_WIDTH && !!rootEl
		const mountEl: HTMLElement =
			contained && rootEl
				? rootEl
				: (rootEl?.ownerDocument?.body ?? getViewDocument().body)
		return { mountEl, contained, hostEl: rootEl }
	}

	createEffect(() => {
		const rootEl = refs.rootEl()
		if (!rootEl) {
			return
		}
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0]
			if (entry) {
				setChatboxContainerWidth(entry.contentRect.width)
			}
		})
		observer.observe(rootEl)
		onCleanup(() => observer.disconnect())
	})

	return {
		getViewDocument,
		getViewWindow,
		isCompactLayout,
		isSmallChatbox,
		dialogMountTarget,
	}
}
