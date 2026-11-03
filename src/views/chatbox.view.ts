import {
	ItemView,
	MarkdownView,
	normalizePath,
	TFile,
	TFolder,
	WorkspaceLeaf,
} from 'obsidian'
import type { EditorView } from '@codemirror/view'
import { CHATBOX_AI_ICON_ID } from '~/assets/icons/obsidian-nutstore-ai-icon'
import { resolveResourceDataUrl } from '~/ai/tools/resource-data-url'
import {
	createPendingContextItem,
	createSelectedTextContextItem,
	createVaultPathContextItem,
	getUserContextItemHash,
	type UserContextItem,
	type SelectedTextContextItem,
} from '~/ai/chat/context/user-context'
import type { ChatboxController, ChatboxProps } from '~/ai/chat/ui/types'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import type NutstorePlugin from '~/index'
import {
	hideChatboxSelectionHighlight,
	showChatboxSelectionHighlight,
} from './chatbox-selection-highlight'
import {
	createDroppedImageContextItem,
	isVaultImageFile,
	resolveDroppedAbstractFile,
} from './chatbox-view-drop'
import { renderChatMarkdown } from './chatbox-view-render'
import { resolveMarkdownSourcePath } from './markdown-link-handler'
import { mountChatbox } from '~/components/solid-js'

export const CHATBOX_VIEW_TYPE = 'nutstore-sync-chatbox'

export default class ChatboxView extends ItemView {
	private rootEl!: HTMLDivElement
	private controller?: ChatboxController
	private unsub?: () => void
	private unsubWindowMigrated?: () => void
	private lastActiveMarkdownLeaf: WorkspaceLeaf | null = null
	private activeFilePathSnapshot?: string
	private activeSelectionSnapshot?: SelectedTextContextItem
	private highlightedEditorView?: EditorView
	private preservingSelectionForChatFocus = false
	private readonly renderMarkdown: NonNullable<ChatboxProps['renderMarkdown']> =
		(el, markdown, options) =>
			renderChatMarkdown(
				{
					app: this.app,
					plugin: this.plugin,
					addChild: (component) => this.addChild(component),
					getMarkdownSourcePath: () => this.getMarkdownSourcePath(true),
				},
				el,
				markdown,
				options,
			)

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: NutstorePlugin,
	) {
		super(leaf)
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				this.handleActiveLeafChange(leaf)
				this.controller?.update(this.getChatboxProps())
			}),
		)
		this.registerEvent(
			this.app.workspace.on('file-open', () => {
				this.captureActiveContextSnapshot()
				this.controller?.update(this.getChatboxProps())
			}),
		)
		this.registerDomEvent(document, 'selectionchange', () => {
			if (this.preservingSelectionForChatFocus) {
				return
			}
			if (!this.app.workspace.getActiveViewOfType(MarkdownView)) {
				return
			}
			this.captureActiveContextSnapshot()
			this.controller?.update(this.getChatboxProps())
		})
	}

	getViewType() {
		return CHATBOX_VIEW_TYPE
	}

	getDisplayText() {
		return i18n.t('chatbox.title')
	}

	getIcon() {
		return CHATBOX_AI_ICON_ID
	}

	private clearActiveContextSnapshot() {
		this.activeFilePathSnapshot = undefined
		this.activeSelectionSnapshot = undefined
	}

	private clearSelectionHighlight() {
		if (!this.highlightedEditorView) {
			return
		}
		try {
			hideChatboxSelectionHighlight(this.highlightedEditorView)
		} catch {
			// Ignore cleanup failures from destroyed views.
		}
		this.highlightedEditorView = undefined
	}

	private getLastActiveMarkdownView(): MarkdownView | null {
		const leaf = this.lastActiveMarkdownLeaf
		if (
			!(leaf?.view instanceof MarkdownView) ||
			!leaf.view.containerEl.isConnected
		) {
			this.lastActiveMarkdownLeaf = null
			return null
		}
		return leaf.view
	}

	private resolveMarkdownView(allowFallback = false): MarkdownView | null {
		const activeMarkdownView =
			this.app.workspace.getActiveViewOfType(MarkdownView)
		if (activeMarkdownView) {
			return activeMarkdownView
		}
		if (allowFallback) {
			return this.getLastActiveMarkdownView()
		}
		return null
	}

	private getEditorView(markdownView?: MarkdownView | null): EditorView | null {
		return markdownView?.editor?.cm ?? null
	}

	private getMarkdownSourcePath(allowFallback = false) {
		const markdownView = this.resolveMarkdownView(allowFallback)
		return resolveMarkdownSourcePath(
			markdownView?.file?.path ?? this.activeFilePathSnapshot,
		)
	}

	private persistSelectionHighlight(allowFallback = false) {
		const markdownView = this.resolveMarkdownView(allowFallback)
		const view = this.getEditorView(markdownView)
		if (!view) {
			this.clearSelectionHighlight()
			return
		}
		const selection = view.state.selection.main
		if (selection.from === selection.to) {
			this.clearSelectionHighlight()
			return
		}
		if (this.highlightedEditorView && this.highlightedEditorView !== view) {
			this.clearSelectionHighlight()
		}
		showChatboxSelectionHighlight(view, selection.from, selection.to)
		this.highlightedEditorView = view
	}

	private handleActiveLeafChange(leaf: WorkspaceLeaf | null) {
		if (
			this.highlightedEditorView &&
			leaf?.getViewState().type !== CHATBOX_VIEW_TYPE
		) {
			this.clearSelectionHighlight()
		}
		if (leaf?.view instanceof MarkdownView) {
			this.lastActiveMarkdownLeaf = leaf
			this.preservingSelectionForChatFocus = false
			this.captureActiveContextSnapshot()
			return
		}
		if (leaf?.getViewState().type === CHATBOX_VIEW_TYPE) {
			this.persistSelectionHighlight(true)
			return
		}
		const root = leaf?.getRoot()
		if (
			leaf &&
			(root === this.app.workspace.leftSplit ||
				root === this.app.workspace.rightSplit)
		) {
			return
		}
		this.preservingSelectionForChatFocus = false
		this.clearActiveContextSnapshot()
	}

	private captureActiveContextSnapshot(allowFallback = false) {
		const markdownView = this.resolveMarkdownView(allowFallback)
		if (!markdownView) {
			const activeFile = this.app.workspace.getActiveFile()
			if (activeFile) {
				this.activeFilePathSnapshot = activeFile.path
				this.activeSelectionSnapshot = undefined
			} else {
				this.clearActiveContextSnapshot()
			}
			this.clearSelectionHighlight()
			return
		}
		this.activeFilePathSnapshot = markdownView.file?.path
		const editor = markdownView.editor
		const selection = editor?.listSelections?.()[0]
		const selectedText = editor?.getSelection() ?? ''
		if (!markdownView.file?.path) {
			this.clearActiveContextSnapshot()
			this.clearSelectionHighlight()
			return
		}
		if (!selection || !selectedText.trim()) {
			this.activeSelectionSnapshot = undefined
			this.clearSelectionHighlight()
			return
		}
		this.activeSelectionSnapshot = createSelectedTextContextItem({
			type: 'selection',
			filePath: markdownView.file.path,
			range: {
				from: { line: selection.anchor.line, ch: selection.anchor.ch },
				to: { line: selection.head.line, ch: selection.head.ch },
			},
			selectedText,
		})
	}

	private getActiveContextItems(): UserContextItem[] {
		if (this.activeSelectionSnapshot) {
			return [this.activeSelectionSnapshot]
		}
		if (this.activeFilePathSnapshot) {
			return [createVaultPathContextItem(this.activeFilePathSnapshot, 'file')]
		}
		return []
	}

	private async openFileChange(vaultPath: string, line?: number) {
		const target = this.app.vault.getAbstractFileByPath(
			normalizePath(vaultPath),
		)
		if (!(target instanceof TFile)) return
		const leaf =
			this.app.workspace
				.getLeavesOfType('markdown')
				.find(
					(candidate) =>
						candidate.view instanceof MarkdownView &&
						candidate.view.file?.path === target.path,
				) ??
			this.getLastActiveMarkdownView()?.leaf ??
			this.app.workspace.getLeaf('tab')
		await leaf.openFile(target, { active: true })
		if (line === undefined || !(leaf.view instanceof MarkdownView)) return
		const editor = leaf.view.editor
		const position = {
			line: Math.max(0, Math.min(line - 1, editor.lastLine())),
			ch: 0,
		}
		editor.setCursor(position)
		editor.scrollIntoView({ from: position, to: position }, true)
		editor.focus()
	}

	private getChatboxProps(): ChatboxProps {
		const viewProps = this.plugin.chatService.getViewProps()
		const activeContextItems = this.getActiveContextItems().filter((item) => {
			const hash = getUserContextItemHash(item)
			return !viewProps.draft.userContext.some(
				(contextItem) => getUserContextItemHash(contextItem) === hash,
			)
		})
		return {
			...viewProps,
			activeContextItems,
			renderMarkdown: this.renderMarkdown,
			onModalHostChange: (rootEl) =>
				this.plugin.chatService.setChatModalHost(rootEl),
			onOpenFileChange: (vaultPath, line) =>
				this.openFileChange(vaultPath, line),
			onResolveResourceDataUrl: (path, mediaType) =>
				resolveResourceDataUrl(this.app, path, mediaType),
			onSendMessage: (
				text: string,
				contextItems?: UserContextItem[],
				sessionId?: string,
			) =>
				this.plugin.chatService.sendMessage(
					text,
					contextItems ?? [],
					sessionId,
				),
			onCaptureActiveContext: () => {
				this.captureActiveContextSnapshot(true)
				this.preservingSelectionForChatFocus = !!this.activeSelectionSnapshot
				this.persistSelectionHighlight(true)
				this.controller?.update(this.getChatboxProps())
			},
			onAddUserContext: (item, sessionId) => {
				this.plugin.chatService.addUserContext(item, sessionId)
			},
			onDropContextItem: async (path: string) => {
				// K9: the image read below may outlive a session switch; bind the
				// drop to the session that was active synchronously at entry.
				const sessionId = viewProps.activeSessionId
				const abstract = resolveDroppedAbstractFile(this.plugin.app, path)
				if (!abstract) return
				if (abstract instanceof TFolder) {
					this.plugin.chatService.addUserContext(
						createVaultPathContextItem(abstract.path, 'folder'),
						sessionId,
					)
					return
				}
				if (abstract instanceof TFile) {
					if (isVaultImageFile(abstract)) {
						const pending = createPendingContextItem('image', abstract.name)
						this.plugin.chatService.addUserContext(pending, sessionId)
						try {
							const item = await createDroppedImageContextItem(
								this.plugin.app,
								abstract,
							)
							this.plugin.chatService.resolvePendingContextItem(
								pending.id,
								item,
								sessionId,
							)
						} catch (error) {
							this.plugin.chatService.resolvePendingContextItem(
								pending.id,
								null,
								sessionId,
							)
							throw error
						}
						return
					}
					this.plugin.chatService.addUserContext(
						createVaultPathContextItem(abstract.path, 'file'),
						sessionId,
					)
					return
				}
			},
			onRemoveUserContext: (index: number, sessionId?: string) => {
				this.plugin.chatService.removeUserContext(index, sessionId)
			},
			onResolvePendingContextItem: (id: string, replacement, sessionId) => {
				this.plugin.chatService.resolvePendingContextItem(
					id,
					replacement,
					sessionId,
				)
			},
		}
	}

	private remountChatbox() {
		this.unsub?.()
		this.unsub = undefined
		this.controller?.destroy()
		this.controller = mountChatbox(this.rootEl, this.getChatboxProps())
		this.unsub = this.plugin.chatService.subscribe(() => {
			this.controller?.update(this.getChatboxProps())
		})
	}

	async onOpen() {
		this.contentEl.empty()
		this.rootEl = this.contentEl.createDiv({
			cls: ':uno: nutstore-chatbox-view h-full',
		})
		this.captureActiveContextSnapshot(true)
		this.plugin.chatService.setChatModalHost(this.rootEl)
		this.unsubWindowMigrated?.()
		this.unsubWindowMigrated = this.rootEl.onWindowMigrated(() => {
			this.plugin.chatService.setChatModalHost(this.rootEl)
			this.remountChatbox()
		})
		this.remountChatbox()
		void this.plugin.chatService.ensureSession().catch((error) => {
			logger.error('Failed to restore ChatBox session', error)
		})
	}

	async onClose() {
		this.clearSelectionHighlight()
		this.unsubWindowMigrated?.()
		this.unsubWindowMigrated = undefined
		this.unsub?.()
		this.unsub = undefined
		this.controller?.destroy()
		this.controller = undefined
		this.plugin.chatService.setChatModalHost(undefined)
		this.contentEl.empty()
	}
}
