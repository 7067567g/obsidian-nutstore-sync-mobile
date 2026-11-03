import { Notice } from 'obsidian'
import { createEffect, createSignal, onCleanup } from 'solid-js'
import {
	createFileContextItem,
	createImageContextItem,
	createPendingContextItem,
} from '~/ai/chat/context/user-context'
import type { ChatboxProps } from '~/ai/chat/ui/types'
import { t } from '~/components/solid-js/i18n'
import {
	decideDropRoute,
	hasDragItems,
} from '~/components/solid-js/Chatbox/drop-utils'

export const PICKER_ACCEPT = 'image/*,.txt,.md,.markdown'
const TEXT_FILE_EXTENSIONS = new Set(['txt', 'md', 'markdown'])

function getFileExtension(filename: string): string {
	const extension = filename.split('.').pop()?.trim().toLowerCase()
	return extension || ''
}

function isSupportedTextFile(file: File): boolean {
	const extension = getFileExtension(file.name)
	if (TEXT_FILE_EXTENSIONS.has(extension)) {
		return true
	}
	const mimeType = file.type.toLowerCase()
	return mimeType === 'text/plain' || mimeType === 'text/markdown'
}

function isSupportedPickedFile(file: File): boolean {
	return file.type.startsWith('image/') || isSupportedTextFile(file)
}

export interface FileDropOptions {
	props: ChatboxProps
	rootEl: () => HTMLDivElement | undefined
	fileInputEl: () => HTMLInputElement | undefined
}

/**
 * File picker, clipboard paste and root-level drag/drop for the Chatbox.
 *
 * Mechanically extracted from `Chatbox.tsx` (P7); no behavior change.
 */
export function useFileDrop(options: FileDropOptions) {
	const [isFileDragActive, setIsFileDragActive] = createSignal(false)

	async function addPickedFile(file: File) {
		if (!isSupportedPickedFile(file)) {
			new Notice(
				t('chatbox.errors.unsupportedAttachmentType', { name: file.name }),
			)
			return
		}
		// K9: bind the (possibly async) attachment to the session that was active
		// when the picker/paste started; resolving the image may outlive a switch.
		const sessionId = options.props.activeSessionId
		if (file.type.startsWith('image/')) {
			const pending = createPendingContextItem('image', file.name)
			options.props.onAddUserContext(pending, sessionId)
			try {
				const item = await createImageContextItem(file, {
					mimeType: file.type || 'image/png',
					name: file.name,
					size: file.size,
				})
				options.props.onResolvePendingContextItem(pending.id, item, sessionId)
			} catch (error) {
				options.props.onResolvePendingContextItem(pending.id, null, sessionId)
				throw error
			}
			return
		}
		options.props.onAddUserContext(
			createFileContextItem(file, {
				mimeType: file.type || 'text/plain',
				filename: file.name,
				size: file.size,
			}),
			sessionId,
		)
	}

	async function addPickedFiles(files: File[]) {
		await Promise.all(files.map((file) => addPickedFile(file)))
	}

	function openFilePicker() {
		options.fileInputEl()?.click()
	}

	function resetFileDragState() {
		setIsFileDragActive(false)
	}

	function handleRootDragEnter(event: DragEvent) {
		if (!hasDragItems(event)) {
			return
		}
		event.preventDefault()
		setIsFileDragActive(true)
	}

	function handleRootDragOver(event: DragEvent) {
		if (!hasDragItems(event)) {
			return
		}
		event.preventDefault()
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'copy'
		}
		setIsFileDragActive(true)
	}

	function handleRootDragLeave(event: DragEvent) {
		if (!hasDragItems(event)) {
			return
		}
		const rootEl = options.rootEl()
		if (!rootEl) {
			return
		}
		const rect = rootEl.getBoundingClientRect()
		const x = event.clientX
		const y = event.clientY
		if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
			return
		}
		event.preventDefault()
		setIsFileDragActive(false)
	}

	async function handleRootDrop(event: DragEvent) {
		if (!hasDragItems(event)) {
			return
		}
		event.preventDefault()
		event.stopPropagation()
		const { paths, files } = decideDropRoute(event)
		resetFileDragState()
		if (paths.length > 0) {
			for (const path of paths) {
				await options.props.onDropContextItem(path)
			}
			return
		}
		if (files.length > 0) {
			await addPickedFiles(files)
		}
	}

	createEffect(() => {
		const rootEl = options.rootEl()
		if (!rootEl) {
			return
		}
		const onDragEnter = (event: DragEvent) => handleRootDragEnter(event)
		const onDragOver = (event: DragEvent) => handleRootDragOver(event)
		const onDragLeave = (event: DragEvent) => handleRootDragLeave(event)
		const onDrop = (event: DragEvent) => {
			void handleRootDrop(event)
		}
		rootEl.addEventListener('dragenter', onDragEnter, true)
		rootEl.addEventListener('dragover', onDragOver, true)
		rootEl.addEventListener('dragleave', onDragLeave, true)
		rootEl.addEventListener('drop', onDrop, true)
		onCleanup(() => {
			rootEl.removeEventListener('dragenter', onDragEnter, true)
			rootEl.removeEventListener('dragover', onDragOver, true)
			rootEl.removeEventListener('dragleave', onDragLeave, true)
			rootEl.removeEventListener('drop', onDrop, true)
		})
	})

	return { isFileDragActive, addPickedFiles, openFilePicker }
}
