import { createMount, MountController } from '~/components/solid-js/mount'
import WebDAVExplorer, { WebDAVExplorerProps } from './WebDAVExplorer'

export type WebDAVExplorerController = MountController<WebDAVExplorerProps>

export function mountWebDAVExplorer(
	el: Element,
	props: WebDAVExplorerProps,
): WebDAVExplorerController {
	return createMount(WebDAVExplorer, el, props)
}
