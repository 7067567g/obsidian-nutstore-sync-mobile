import { createSignal } from 'solid-js'
import type { ChatTimelineMessageItem, ChatboxProps } from '~/ai/chat/ui/types'
import { t } from '~/components/solid-js/i18n'

type RecallArmedMode = 'only' | 'restore'

export interface MessageActionsOptions {
	props: ChatboxProps
	getViewDocument: () => Document
	inputTextareaEl: () => HTMLTextAreaElement | undefined
	getViewWindow: () => Window
	restoreInput: (text: string, sessionId?: string) => void
}

/**
 * Message/session action state for the Chatbox confirm dialogs.
 *
 * Mechanically extracted from `Chatbox.tsx` (P7); no behavior change.
 */
export function useMessageActions(options: MessageActionsOptions) {
	const [sessionPendingDeleteId, setSessionPendingDeleteId] =
		createSignal<string>()
	const [pendingDeleteMessage, setPendingDeleteMessage] =
		createSignal<ChatTimelineMessageItem>()
	const [pendingRegenerateMessage, setPendingRegenerateMessage] =
		createSignal<ChatTimelineMessageItem>()
	const [pendingRecallMessage, setPendingRecallMessage] =
		createSignal<ChatTimelineMessageItem>()
	/** K9: session captured when the recall dialog opened, before any await. */
	const [pendingRecallSessionId, setPendingRecallSessionId] =
		createSignal<string>()
	const [pendingCompressContextConfirm, setPendingCompressContextConfirm] =
		createSignal(false)
	const [recallArmedMode, setRecallArmedMode] = createSignal<RecallArmedMode>()

	function dismissInputFocus() {
		const activeElement = options.getViewDocument().activeElement
		if (activeElement instanceof HTMLElement) {
			activeElement.blur()
		}
		options.inputTextareaEl()?.blur()
	}

	function openCompressContextConfirm() {
		dismissInputFocus()
		options.getViewWindow().requestAnimationFrame(() => {
			setPendingCompressContextConfirm(true)
		})
	}

	async function confirmDeleteSession() {
		const sessionId = sessionPendingDeleteId()
		if (!sessionId) {
			return
		}
		setSessionPendingDeleteId(undefined)
		await options.props.onDeleteSession(sessionId)
	}

	function requestDeleteMessage(messageId: string) {
		if (!options.props.onDeleteMessage) return
		const item = options.props.timeline.find(
			(item) => item.message.id === messageId,
		)
		if (!item) return
		setPendingDeleteMessage(item)
	}

	function requestRegenerateMessage(messageId: string) {
		if (!options.props.onRegenerateMessage) return
		const item = options.props.timeline.find(
			(item) => item.message.id === messageId,
		)
		if (!item) return
		setPendingRegenerateMessage(item)
	}

	function requestRecallMessage(messageId: string) {
		if (!options.props.onRecallMessage) return
		const item = options.props.timeline.find(
			(item) => item.message.id === messageId,
		)
		if (!item) return
		setRecallArmedMode(undefined)
		// K9: capture the owning session now; the confirm dialog can outlive a
		// session switch, and the late `await` must not re-resolve the active one.
		setPendingRecallSessionId(options.props.activeSessionId)
		setPendingRecallMessage(item)
	}

	async function doRecallMessage(
		item: ChatTimelineMessageItem,
		recallOptions?: { restoreFiles?: boolean },
	) {
		const sessionId = pendingRecallSessionId()
		const recalled = await options.props.onRecallMessage?.(item.message.id, {
			...recallOptions,
			sessionId,
		})
		if (recalled?.text !== undefined) {
			options.restoreInput(recalled.text, sessionId)
			return
		}
		const fallbackText = item.message.parts
			.filter((p) => p.type === 'text')
			.map((p) => p.text)
			.join('\n')
		options.restoreInput(fallbackText, sessionId)
	}

	async function confirmRecallMessage() {
		const item = pendingRecallMessage()
		if (!item) return
		setRecallArmedMode(undefined)
		setPendingRecallMessage(undefined)
		await doRecallMessage(item)
	}

	function confirmRegenerateMessage() {
		const item = pendingRegenerateMessage()
		if (!item) return
		setPendingRegenerateMessage(undefined)
		options.props.onRegenerateMessage?.(item.message.id)
	}

	function confirmDeleteMessage() {
		const item = pendingDeleteMessage()
		if (!item) return
		setPendingDeleteMessage(undefined)
		options.props.onDeleteMessage?.(item.message.id)
	}

	async function confirmCompressContext() {
		setPendingCompressContextConfirm(false)
		await options.props.onCompressContext()
	}

	const deleteMessageConfirmText = () => {
		const item = pendingDeleteMessage()
		if (!item) return ''
		switch (item.message.role) {
			case 'user':
				return t('chatbox.ui.dialogs.deleteMessage.userConfirm')
			default:
				return t('chatbox.ui.dialogs.deleteMessage.assistantConfirm')
		}
	}

	const deleteMessageHasReversibleOps = () =>
		Boolean(
			pendingDeleteMessage() &&
			options.props.onRecallHasReversibleOps?.(
				pendingDeleteMessage()!.message.id,
			),
		)

	const recallHasReversibleOps = () => {
		const item = pendingRecallMessage()
		if (!item) return false
		if (options.props.onRecallHasReversibleOps) {
			return options.props.onRecallHasReversibleOps(item.message.id)
		}
		return false
	}

	async function confirmRecallAndRestoreMessage() {
		const item = pendingRecallMessage()
		if (!item) return
		setRecallArmedMode(undefined)
		setPendingRecallMessage(undefined)
		await doRecallMessage(item, { restoreFiles: true })
	}

	const confirmRecallOnlyButton = () => {
		if (recallArmedMode() === 'only') {
			void confirmRecallMessage()
			return
		}
		setRecallArmedMode('only')
	}

	const confirmRecallRestoreButton = () => {
		if (recallArmedMode() === 'restore') {
			void confirmRecallAndRestoreMessage()
			return
		}
		setRecallArmedMode('restore')
	}

	const recallOnlyConfirmLabel = () =>
		recallArmedMode() === 'only'
			? t('chatbox.ui.dialogs.recall.onlySecondTitle')
			: t('chatbox.ui.dialogs.recall.onlyConfirm')

	const recallRestoreConfirmLabel = () =>
		recallArmedMode() === 'restore'
			? t('chatbox.ui.dialogs.recall.restoreSecondTitle')
			: t('chatbox.ui.dialogs.recall.restoreConfirm')

	return {
		sessionPendingDeleteId,
		setSessionPendingDeleteId,
		pendingDeleteMessage,
		setPendingDeleteMessage,
		pendingRegenerateMessage,
		setPendingRegenerateMessage,
		pendingRecallMessage,
		setPendingRecallMessage,
		pendingCompressContextConfirm,
		setPendingCompressContextConfirm,
		recallArmedMode,
		setRecallArmedMode,
		openCompressContextConfirm,
		confirmDeleteSession,
		requestDeleteMessage,
		requestRegenerateMessage,
		requestRecallMessage,
		confirmRecallMessage,
		confirmRegenerateMessage,
		confirmDeleteMessage,
		confirmCompressContext,
		deleteMessageConfirmText,
		deleteMessageHasReversibleOps,
		recallHasReversibleOps,
		confirmRecallOnlyButton,
		confirmRecallRestoreButton,
		recallOnlyConfirmLabel,
		recallRestoreConfirmLabel,
	}
}
