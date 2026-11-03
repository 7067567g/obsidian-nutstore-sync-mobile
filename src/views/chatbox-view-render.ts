import type { App } from 'obsidian'
import { Component, MarkdownRenderer } from 'obsidian'
import type { ChatboxProps } from '~/ai/chat/ui/types'
import logger from '~/utils/logger'
import type NutstorePlugin from '~/index'
import { enhanceHtmlCodeBlocks } from './chatbox-code-preview'
import { resolveMarkdownLinkAction } from './markdown-link-handler'

export type ChatboxRenderMarkdown = NonNullable<ChatboxProps['renderMarkdown']>

export interface ChatboxRenderDeps {
	app: App
	plugin: NutstorePlugin
	addChild: (component: Component) => void
	getMarkdownSourcePath: () => string
}

/**
 * Chat markdown renderer extracted from `ChatboxView.renderMarkdown`.
 * Pure DOM/renderer wiring; state is supplied through `deps` at call time.
 */
export async function renderChatMarkdown(
	deps: ChatboxRenderDeps,
	el: HTMLElement,
	markdown: string,
	options?: { streaming?: boolean },
): Promise<void | (() => void)> {
	const { app, plugin, addChild, getMarkdownSourcePath } = deps
	const component = new Component()
	addChild(component)
	component.load()

	const fallbackText = markdown
	const renderedEl = el.ownerDocument.createElement('div')
	const sourcePath = getMarkdownSourcePath()

	try {
		await MarkdownRenderer.render(
			app,
			markdown,
			renderedEl,
			sourcePath,
			component,
		)
	} catch (error) {
		logger.error('Error rendering chat markdown:', error)
		component.unload()
		el.replaceChildren()
		el.textContent = fallbackText
		return
	}

	el.replaceChildren(...Array.from(renderedEl.childNodes))
	if (!el.childNodes.length) {
		el.textContent = fallbackText
	}

	if (!options?.streaming) {
		enhanceHtmlCodeBlocks(el)
	}

	const onLinkClick = (event: MouseEvent) => {
		const target = event.target
		if (!(target instanceof Element)) {
			return
		}
		const anchor = target.closest('a')
		if (!(anchor instanceof HTMLAnchorElement)) {
			return
		}

		const action = resolveMarkdownLinkAction({
			href: anchor.getAttribute('href'),
			datasetHref: anchor.getAttribute('data-href'),
			classNames: Array.from(anchor.classList),
		})
		if (action.type === 'none') {
			return
		}

		event.preventDefault()
		event.stopPropagation()

		if (action.type === 'internal') {
			void app.workspace.openLinkText(action.linktext, sourcePath, false)
			return
		}

		if (action.type === 'protocol' && action.providerId) {
			void plugin.protocolService.openProviderEditor(
				action.providerId,
				plugin.chatService.getChatModalMountTarget(),
			)
			return
		}

		window.open(action.href, '_blank', 'noopener,noreferrer')
	}

	el.addEventListener('click', onLinkClick)

	return () => {
		el.removeEventListener('click', onLinkClick)
		component.unload()
		el.replaceChildren()
	}
}
