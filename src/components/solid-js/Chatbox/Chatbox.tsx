import {
	For,
	Show,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
} from 'solid-js'
import { shouldWindowTimeline } from '~/ai/chat/ui/message-window'
import type { ChatboxProps } from '~/ai/chat/ui/types'
import { t } from '~/components/solid-js/i18n'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ContextArea } from './components/ContextArea'
import { ContextRing } from './components/ContextRing'
import { McpServersDialog } from './components/McpServersDialog'
import { MessageCard } from './components/MessageCard'
import { ModelPickerDialog } from './components/ModelPickerDialog'
import { PaneResizer } from './components/PaneResizer'
import { PendingList } from './components/PendingList'
import { RunStateCard } from './components/RunStateCard'
import { SessionHistorySheet } from './components/SessionHistorySheet'
import { SubagentTimelineDialog } from './components/SubagentTimelineDialog'
import { useAgentSelection } from './hooks/use-agent-selection'
import { useChatboxClock } from './hooks/use-chatbox-clock'
import { useChatboxComposer } from './hooks/use-chatbox-composer'
import { useChatboxLayout } from './hooks/use-chatbox-layout'
import { useContextUsage } from './hooks/use-context-usage'
import { PICKER_ACCEPT, useFileDrop } from './hooks/use-file-drop'
import { useInputPaneHeight } from './hooks/use-input-pane-height'
import { useMessageActions } from './hooks/use-message-actions'
import { useMessageScroll } from './hooks/use-message-scroll'
import { useTimelineWindow } from './hooks/use-timeline-window'

function Chatbox(props: ChatboxProps) {
	let chatboxRootEl: HTMLDivElement | undefined
	let messagesEl: HTMLDivElement | undefined
	let splitLayoutEl: HTMLDivElement | undefined
	let inputPaneEl: HTMLDivElement | undefined
	let inputTextareaEl: HTMLTextAreaElement | undefined
	let fileInputEl: HTMLInputElement | undefined

	const layout = useChatboxLayout({
		rootEl: () => chatboxRootEl,
		splitLayoutEl: () => splitLayoutEl,
		inputPaneEl: () => inputPaneEl,
		messagesEl: () => messagesEl,
	})
	const messageScroll = useMessageScroll({
		props,
		messagesEl: () => messagesEl,
		getViewWindow: layout.getViewWindow,
	})
	const agentSelection = useAgentSelection(props)
	const composer = useChatboxComposer({
		props,
		scrollMessagesToBottom: messageScroll.scrollMessagesToBottom,
	})
	const contextUsage = useContextUsage(props)
	const inputPane = useInputPaneHeight({
		splitLayoutEl: () => splitLayoutEl,
		inputPaneEl: () => inputPaneEl,
		inputTextareaEl: () => inputTextareaEl,
		isCompactLayout: layout.isCompactLayout,
		getViewWindow: layout.getViewWindow,
	})
	const fileDrop = useFileDrop({
		props,
		rootEl: () => chatboxRootEl,
		fileInputEl: () => fileInputEl,
	})
	const messageActions = useMessageActions({
		props,
		getViewDocument: layout.getViewDocument,
		inputTextareaEl: () => inputTextareaEl,
		getViewWindow: layout.getViewWindow,
		restoreInput: composer.restoreInput,
	})
	const now = useChatboxClock({
		props,
		getViewWindow: layout.getViewWindow,
	})

	const [historyOpen, setHistoryOpen] = createSignal(false)
	const [modelPickerOpen, setModelPickerOpen] = createSignal(false)
	const windowedTimeline = () =>
		props.windowedRendering !== false &&
		shouldWindowTimeline(props.timeline.length)
	const timelineWindow = useTimelineWindow({
		props,
		enabled: windowedTimeline,
	})
	/**
	 * Preserve the reading position when an earlier page is inserted above:
	 * keep the distance from the bottom constant, not `scrollTop`.
	 */
	function loadEarlierTimeline() {
		const el = messagesEl
		const beforeHeight = el?.scrollHeight ?? 0
		const beforeTop = el?.scrollTop ?? 0
		timelineWindow.loadEarlier()
		if (!el) return
		layout.getViewWindow().requestAnimationFrame(() => {
			const added = el.scrollHeight - beforeHeight
			el.scrollTop = beforeTop + added
		})
	}
	const isBusy = () => props.runState !== 'idle'
	const streamingMessageId = createMemo(() => {
		if (!isBusy()) return undefined
		for (let index = props.timeline.length - 1; index >= 0; index -= 1) {
			const message = props.timeline[index]?.message
			if (message?.role === 'assistant') return message.id
		}
		return undefined
	})
	const selectedProvider = () =>
		props.providers.find((provider) => provider.id === props.selectedProviderId)
	const modelPickerLabel = () => {
		const provider = selectedProvider()
		const selectedModel = provider?.models.find(
			(model) => model.id === props.selectedModelId,
		)
		return (
			[provider?.name, selectedModel?.name].filter(Boolean).join('/') ||
			t('chatbox.ui.states.noModel')
		)
	}

	onMount(() => {
		props.onModalHostChange?.(chatboxRootEl)
		onCleanup(() => props.onModalHostChange?.(undefined))
	})

	createEffect(() => {
		if (!chatboxRootEl || !props.onCaptureActiveContext) {
			return
		}
		const root = chatboxRootEl
		const onPointerDownCapture = () => props.onCaptureActiveContext?.()
		root.addEventListener('pointerdown', onPointerDownCapture, true)
		onCleanup(() => {
			root.removeEventListener('pointerdown', onPointerDownCapture, true)
		})
	})

	return (
		<div
			ref={chatboxRootEl}
			class={`:uno: relative flex h-full overflow-hidden bg-[var(--background-primary)] text-[var(--text-normal)] ${
				fileDrop.isFileDragActive() ? 'chatbox-file-drag-active' : ''
			}`}
		>
			<input
				ref={fileInputEl}
				type="file"
				accept={PICKER_ACCEPT}
				class=":uno: sr-only"
				onChange={(event) => {
					const files = Array.from(event.currentTarget.files ?? [])
					if (!files.length) return
					void fileDrop.addPickedFiles(files)
					event.currentTarget.value = ''
				}}
			/>
			<Show when={fileDrop.isFileDragActive()}>
				<div class=":uno: chatbox-file-drop-overlay pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-3xl border-2 border-dashed">
					<div class=":uno: rounded-full bg-[var(--background-primary)]/90 px-4 py-2 text-sm text-[var(--text-normal)] shadow-sm">
						{t('chatbox.ui.states.dragFilePrompt')}
					</div>
				</div>
			</Show>
			<div class=":uno: flex min-w-0 flex-1 flex-col overflow-hidden">
				{/* Header */}
				<div class=":uno: relative flex shrink-0 items-center gap-2 border-b border-[var(--background-modifier-border)] px-2 py-2">
					<button
						class=":uno: inline-flex size-8 shrink-0 items-center justify-center text-[var(--text-muted)] transition-colors !bg-transparent hover:text-[var(--interactive-accent)] focus-visible:text-[var(--interactive-accent)]"
						type="button"
						aria-label={t('chatbox.ui.history.title')}
						title={t('chatbox.ui.history.title')}
						onClick={() => {
							setHistoryOpen((value) => !value)
							setModelPickerOpen(false)
						}}
					>
						<span class=":uno: i-lucide-menu size-5 shrink-0" />
					</button>
					<div class=":uno: min-w-0 flex-1 truncate text-sm font-semibold">
						{props.title || t('chatbox.newChat')}
					</div>
					<Show
						when={layout.isSmallChatbox()}
						fallback={
							<button
								class=":uno: max-w-56 min-w-34 text-sm"
								type="button"
								onClick={() => {
									setModelPickerOpen(true)
									setHistoryOpen(false)
								}}
							>
								<div class=":uno: truncate">{modelPickerLabel()}</div>
							</button>
						}
					>
						<button
							class=":uno: inline-flex size-6 shrink-0 items-center justify-center rounded-full disabled:opacity-50"
							type="button"
							aria-label={`${t('chatbox.ui.labels.provider')} / ${t('chatbox.ui.labels.model')}`}
							title={`${t('chatbox.ui.labels.provider')} / ${t('chatbox.ui.labels.model')}`}
							onClick={() => {
								setModelPickerOpen(true)
								setHistoryOpen(false)
							}}
						>
							<span class=":uno: i-lucide-sliders-horizontal size-3 shrink-0" />
						</button>
					</Show>
				</div>

				<div
					ref={splitLayoutEl}
					class=":uno: flex min-h-0 flex-1 flex-col overflow-hidden"
				>
					{/* Messages */}
					<div
						ref={messagesEl}
						class=":uno: min-h-0 flex-1 overflow-y-auto px-3 pb-3 scrollbar-default"
					>
						<Show
							when={
								props.timeline.length > 0 ||
								props.pending.length > 0 ||
								isBusy()
							}
							fallback={
								<div class=":uno: flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
									{props.loading
										? t('chatbox.ui.states.loading')
										: t('chatbox.ui.states.empty')}
								</div>
							}
						>
							<div class=":uno: flex flex-col gap-3">
								<Show
									when={
										windowedTimeline() && timelineWindow.window().hasEarlier
									}
								>
									<button
										class=":uno: mx-auto rounded-full border border-[var(--background-modifier-border)] px-3 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--interactive-accent)]"
										type="button"
										onClick={loadEarlierTimeline}
									>
										{t('chatbox.ui.actions.loadEarlier', {
											count: timelineWindow.window().hiddenBefore,
										})}
									</button>
								</Show>
								<For each={timelineWindow.visibleItems()}>
									{(item) => (
										<MessageCard
											item={item}
											now={now()}
											renderMarkdown={props.renderMarkdown}
											streaming={item.message.id === streamingMessageId()}
											onDeleteMessage={messageActions.requestDeleteMessage}
											onRegenerateMessage={
												messageActions.requestRegenerateMessage
											}
											onRecallMessage={messageActions.requestRecallMessage}
											getSubagent={(agentId) => props.agentsById[agentId]}
											onOpenSubagent={agentSelection.setSelectedAgentId}
											onOpenFileChange={props.onOpenFileChange}
											onResolveResourceDataUrl={props.onResolveResourceDataUrl}
										/>
									)}
								</For>
								<RunStateCard
									runState={props.runState}
									onStop={props.onStopActiveRun}
								/>
								<PendingList
									pending={props.pending}
									onCancelPending={props.onCancelPendingSubmission}
								/>
							</div>
						</Show>
					</div>

					<PaneResizer
						onResizeStart={inputPane.onInputPaneResizeStart}
						onResize={inputPane.onInputPaneResize}
						onResizeEnd={inputPane.onInputPaneResizeEnd}
						onDblClick={inputPane.resetInputPaneHeight}
					/>

					{/* Input */}
					<div
						ref={inputPaneEl}
						class={`:uno: chatbox-input-pane shrink-0 px-2 pb-1 ${'chatbox-input-pane--resizable'}`}
					>
						<div class="chatbox-context-header">
							<Show when={props.activeContextItems.length > 0}>
								<ContextArea items={props.activeContextItems} />
							</Show>
							<Show when={props.draft.userContext.length > 0}>
								<ContextArea
									items={props.draft.userContext}
									onRemove={props.onRemoveUserContext}
								/>
							</Show>
						</div>
						<textarea
							ref={inputTextareaEl}
							class=":uno: chatbox-input flex-1 w-full rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] text-sm outline-none"
							style={(() => {
								const height = inputPane.getTextareaHeightStyle()
								return height ? { height } : undefined
							})()}
							placeholder={t('chatbox.ui.placeholders.input')}
							value={composer.input()}
							onInput={(event) => {
								const nextInput = event.currentTarget.value
								composer.setInput(nextInput)
								props.onUpdateInputDraft(nextInput)
							}}
							onPaste={(event) => {
								const imageFiles = Array.from(event.clipboardData?.items ?? [])
									.filter(
										(item) =>
											item.kind === 'file' && item.type.startsWith('image/'),
									)
									.map((item) => item.getAsFile())
									.filter((file): file is File => !!file)
								if (!imageFiles.length) return
								event.preventDefault()
								void fileDrop.addPickedFiles(imageFiles)
							}}
							enterkeyhint="enter"
						/>

						<div class=":uno: mt-3 flex items-center justify-between gap-3">
							<div class=":uno: flex flex-wrap items-center gap-2">
								<button
									class=":uno: inline-flex size-9 shrink-0 items-center justify-center rounded-full disabled:opacity-50"
									type="button"
									title={t('chatbox.ui.actions.selectFile')}
									aria-label={t('chatbox.ui.actions.selectFile')}
									onClick={fileDrop.openFilePicker}
								>
									<span class=":uno: i-lucide-paperclip size-4 shrink-0" />
								</button>
								<button
									class=":uno: inline-flex size-9 shrink-0 items-center justify-center rounded-full disabled:opacity-50"
									type="button"
									title={t('chatbox.ui.actions.compressContext')}
									aria-label={t('chatbox.ui.actions.compressContext')}
									disabled={!props.canCompress}
									onClick={messageActions.openCompressContextConfirm}
								>
									<span class=":uno: i-lucide-minimize-2 size-4 shrink-0" />
								</button>
								<McpServersDialog
									servers={props.mcpServers}
									mountEl={layout.dialogMountTarget().mountEl}
									contained={layout.dialogMountTarget().contained}
									onToggle={props.onToggleSessionMcpServer}
								/>
								<button
									class=":uno: inline-flex size-9 shrink-0 items-center justify-center rounded-full"
									type="button"
									title={t('chatbox.newChat')}
									aria-label={t('chatbox.newChat')}
									onClick={() => props.onNewSession()}
								>
									<span class=":uno: i-lucide-square-pen size-4 shrink-0" />
								</button>
							</div>
							<button
								class=":uno: mod-cta inline-flex items-center gap-1.5"
								type="button"
								disabled={
									(!composer.input().trim() &&
										!props.draft.userContext.length &&
										!props.activeContextItems.length) ||
									!props.canSend
								}
								onClick={() => void composer.submit()}
								title={contextUsage.contextUsageTitle()}
							>
								<Show when={props.contextWindow}>
									<ContextRing
										used={contextUsage.contextUsedTokens()}
										total={props.contextWindow!}
										size={16}
										stroke={3}
										title={contextUsage.contextUsageTitle()}
									/>
								</Show>
								{t('chatbox.ui.actions.send')}
							</button>
						</div>
					</div>
				</div>
			</div>

			{/* History bottom sheet */}
			<SessionHistorySheet
				open={historyOpen()}
				sessions={props.sessionHistory}
				activeSessionId={props.activeSessionId}
				activeSessionIsRunning={
					props.runState !== 'idle' ||
					Object.values(props.agentsById).some(
						(agent) => agent.status === 'running' || agent.status === 'queued',
					)
				}
				otherBusySessionIds={props.otherBusySessionIds}
				mountEl={layout.dialogMountTarget().mountEl}
				contained={layout.dialogMountTarget().contained}
				onClose={() => setHistoryOpen(false)}
				onNewSession={props.onNewSession}
				onSwitchSession={props.onSwitchSession}
				onExportSession={(sessionId) =>
					void props.onExportSession(sessionId, layout.dialogMountTarget())
				}
				onDelete={(sessionId) =>
					messageActions.setSessionPendingDeleteId(sessionId)
				}
			/>

			<Show when={modelPickerOpen()}>
				<ModelPickerDialog
					providers={props.providers}
					selectedProviderId={props.selectedProviderId}
					selectedModelId={props.selectedModelId}
					mountEl={layout.dialogMountTarget().mountEl}
					contained={layout.dialogMountTarget().contained}
					onSelectProvider={props.onSelectProvider}
					onSelectModel={props.onSelectModel}
					onClose={() => setModelPickerOpen(false)}
				/>
			</Show>

			<SubagentTimelineDialog
				agent={agentSelection.selectedAgent()}
				now={now()}
				mountEl={layout.dialogMountTarget().mountEl}
				contained={layout.dialogMountTarget().contained}
				renderMarkdown={props.renderMarkdown}
				getSubagent={(agentId) => props.agentsById[agentId]}
				onSelectAgent={agentSelection.setSelectedAgentId}
				onOpenFileChange={props.onOpenFileChange}
				onClose={() => agentSelection.setSelectedAgentId(undefined)}
			/>

			{/* Delete session dialog */}
			<Show when={messageActions.sessionPendingDeleteId()}>
				<ConfirmDialog
					title={t('chatbox.ui.dialogs.deleteSession.title')}
					message={t('chatbox.ui.dialogs.deleteSession.message')}
					confirmLabel={t('chatbox.ui.dialogs.deleteSession.confirm')}
					mountEl={layout.dialogMountTarget().mountEl}
					contained={layout.dialogMountTarget().contained}
					onCancel={() => messageActions.setSessionPendingDeleteId(undefined)}
					onConfirm={() => void messageActions.confirmDeleteSession()}
				/>
			</Show>

			{/* Delete message dialog */}
			<Show when={messageActions.pendingDeleteMessage()}>
				<ConfirmDialog
					title={t('chatbox.ui.dialogs.deleteMessage.title')}
					message={`${messageActions.deleteMessageConfirmText()}${
						messageActions.deleteMessageHasReversibleOps()
							? `\n\n${t('chatbox.ui.dialogs.deleteMessage.toolRestoreWarning')}`
							: ''
					}`}
					confirmLabel={t('chatbox.ui.dialogs.deleteMessage.confirm')}
					mountEl={layout.dialogMountTarget().mountEl}
					contained={layout.dialogMountTarget().contained}
					onCancel={() => messageActions.setPendingDeleteMessage(undefined)}
					onConfirm={messageActions.confirmDeleteMessage}
				/>
			</Show>

			<Show when={messageActions.pendingCompressContextConfirm()}>
				<ConfirmDialog
					title={t('chatbox.ui.dialogs.compressContext.title')}
					message={t('chatbox.ui.dialogs.compressContext.message')}
					confirmLabel={t('chatbox.ui.dialogs.compressContext.confirm')}
					mountEl={layout.dialogMountTarget().mountEl}
					contained={layout.dialogMountTarget().contained}
					onCancel={() =>
						messageActions.setPendingCompressContextConfirm(false)
					}
					onConfirm={() => void messageActions.confirmCompressContext()}
				/>
			</Show>

			{/* Regenerate message dialog */}
			<Show when={messageActions.pendingRegenerateMessage()}>
				<ConfirmDialog
					title={t('chatbox.ui.dialogs.regenerate.title')}
					message={t('chatbox.ui.dialogs.regenerate.message')}
					confirmLabel={t('chatbox.ui.dialogs.regenerate.confirm')}
					mountEl={layout.dialogMountTarget().mountEl}
					contained={layout.dialogMountTarget().contained}
					onCancel={() => messageActions.setPendingRegenerateMessage(undefined)}
					onConfirm={messageActions.confirmRegenerateMessage}
				/>
			</Show>

			{/* Recall message dialog */}
			<Show when={messageActions.pendingRecallMessage()}>
				<ConfirmDialog
					title={t('chatbox.ui.dialogs.recall.title')}
					message={t('chatbox.ui.dialogs.recall.message')}
					confirmLabel={messageActions.recallOnlyConfirmLabel()}
					confirmClass={
						messageActions.recallArmedMode() === 'only'
							? 'mod-warning'
							: undefined
					}
					secondaryConfirmLabel={
						messageActions.recallHasReversibleOps()
							? messageActions.recallRestoreConfirmLabel()
							: undefined
					}
					secondaryConfirmClass={
						messageActions.recallArmedMode() === 'restore'
							? 'mod-warning'
							: undefined
					}
					actionsLayout="vertical"
					cancelPlacement="end"
					mountEl={layout.dialogMountTarget().mountEl}
					contained={layout.dialogMountTarget().contained}
					onCancel={() => {
						messageActions.setRecallArmedMode(undefined)
						messageActions.setPendingRecallMessage(undefined)
					}}
					onConfirm={messageActions.confirmRecallOnlyButton}
					onSecondaryConfirm={messageActions.confirmRecallRestoreButton}
				/>
			</Show>
		</div>
	)
}

export default Chatbox
