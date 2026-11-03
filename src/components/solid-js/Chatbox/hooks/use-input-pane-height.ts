import { createEffect, createSignal, onCleanup } from 'solid-js'

const INPUT_HEIGHT_STORAGE_KEY = 'nutstore-sync.chatbox.input-height'
const LEGACY_INPUT_HEIGHT_STORAGE_KEY =
	'nutstore-sync.chatbox.desktop-input-height'
const DEFAULT_INPUT_HEIGHT = 184
const DEFAULT_COMPACT_INPUT_HEIGHT = 144
const INPUT_MIN_HEIGHT = 128
const COMPACT_INPUT_MIN_HEIGHT = 104
const INPUT_ABSOLUTE_MIN_HEIGHT = 72
const COMPACT_INPUT_ABSOLUTE_MIN_HEIGHT = 64
const MESSAGES_MIN_HEIGHT = 200
const COMPACT_MESSAGES_MIN_HEIGHT = 120
const RESIZER_HITBOX_HEIGHT = 10
const INPUT_MAX_VIEWPORT_RATIO = 0.6
const COMPACT_INPUT_MAX_VIEWPORT_RATIO = 0.45

export interface InputPaneHeightOptions {
	splitLayoutEl: () => HTMLDivElement | undefined
	inputPaneEl: () => HTMLDivElement | undefined
	inputTextareaEl: () => HTMLTextAreaElement | undefined
	isCompactLayout: () => boolean
	getViewWindow: () => Window
}

/**
 * Resizable input-pane height (clamping, persistence, drag and observation).
 *
 * Mechanically extracted from `Chatbox.tsx` (P7); no behavior change.
 */
export function useInputPaneHeight(options: InputPaneHeightOptions) {
	const [inputPaneHeight, setInputPaneHeight] = createSignal<number>()
	let defaultInputHeight = DEFAULT_INPUT_HEIGHT
	let dragStartHeight = 0

	function getDefaultInputPaneHeight() {
		return options.isCompactLayout()
			? DEFAULT_COMPACT_INPUT_HEIGHT
			: DEFAULT_INPUT_HEIGHT
	}

	function getInputMinHeight() {
		return options.isCompactLayout()
			? COMPACT_INPUT_MIN_HEIGHT
			: INPUT_MIN_HEIGHT
	}

	function getInputAbsoluteMinHeight() {
		return options.isCompactLayout()
			? COMPACT_INPUT_ABSOLUTE_MIN_HEIGHT
			: INPUT_ABSOLUTE_MIN_HEIGHT
	}

	function getMessagesMinHeight() {
		return options.isCompactLayout()
			? COMPACT_MESSAGES_MIN_HEIGHT
			: MESSAGES_MIN_HEIGHT
	}

	function getInputMaxViewportRatio() {
		return options.isCompactLayout()
			? COMPACT_INPUT_MAX_VIEWPORT_RATIO
			: INPUT_MAX_VIEWPORT_RATIO
	}

	function readStoredInputPaneHeight() {
		try {
			const raw = options
				.getViewWindow()
				.localStorage.getItem(INPUT_HEIGHT_STORAGE_KEY)
			if (raw) {
				const value = Number(raw)
				return Number.isFinite(value) ? value : undefined
			}
			const legacyRaw = options
				.getViewWindow()
				.localStorage.getItem(LEGACY_INPUT_HEIGHT_STORAGE_KEY)
			if (!legacyRaw) {
				return undefined
			}
			const value = Number(legacyRaw)
			return Number.isFinite(value) ? value : undefined
		} catch {
			return undefined
		}
	}

	function persistInputPaneHeight(height: number) {
		try {
			options
				.getViewWindow()
				.localStorage.setItem(
					INPUT_HEIGHT_STORAGE_KEY,
					String(Math.round(height)),
				)
		} catch {
			// Ignore storage errors, resize should still work.
		}
	}

	function getInputPaneChromeHeight() {
		const inputPaneEl = options.inputPaneEl()
		const inputTextareaEl = options.inputTextareaEl()
		if (!inputPaneEl || !inputTextareaEl) {
			return 0
		}
		const paneHeight = inputPaneEl.getBoundingClientRect().height
		const textareaHeight = inputTextareaEl.getBoundingClientRect().height
		return Math.max(0, Math.round(paneHeight - textareaHeight))
	}

	function getMaxInputPaneHeight() {
		const viewportMax = Math.floor(
			options.getViewWindow().innerHeight * getInputMaxViewportRatio(),
		)
		const splitHeight =
			options.splitLayoutEl()?.getBoundingClientRect().height ?? 0
		if (splitHeight <= 0) {
			return Math.max(getInputMinHeight(), viewportMax)
		}
		const messagesBound = Math.floor(
			splitHeight - getMessagesMinHeight() - RESIZER_HITBOX_HEIGHT,
		)
		const maxHeight = Math.min(messagesBound, viewportMax)
		return Math.max(getInputAbsoluteMinHeight(), maxHeight)
	}

	function clampInputPaneHeight(height: number) {
		const maxHeight = getMaxInputPaneHeight()
		const minHeight = Math.min(getInputMinHeight(), maxHeight)
		return Math.round(Math.min(Math.max(height, minHeight), maxHeight))
	}

	function applyInputPaneHeight(height: number, persist = false) {
		const next = clampInputPaneHeight(height)
		setInputPaneHeight(next)
		if (persist) {
			persistInputPaneHeight(next)
		}
		return next
	}

	function getTextareaHeightStyle() {
		const paneHeight = inputPaneHeight()
		if (typeof paneHeight !== 'number') {
			return undefined
		}
		const chromeHeight = getInputPaneChromeHeight()
		return `${Math.max(getInputAbsoluteMinHeight(), paneHeight - chromeHeight)}px`
	}

	function resetInputPaneHeight() {
		applyInputPaneHeight(defaultInputHeight, true)
	}

	function onInputPaneResizeStart() {
		dragStartHeight =
			inputPaneHeight() ?? clampInputPaneHeight(defaultInputHeight)
	}

	function onInputPaneResize(deltaY: number) {
		applyInputPaneHeight(dragStartHeight + deltaY)
	}

	function onInputPaneResizeEnd() {
		const height = inputPaneHeight()
		if (typeof height === 'number') {
			persistInputPaneHeight(height)
		}
	}

	createEffect(() => {
		if (!options.inputTextareaEl()) {
			return
		}
		defaultInputHeight =
			Math.round(options.inputPaneEl()?.getBoundingClientRect().height ?? 0) ||
			getDefaultInputPaneHeight()
		const storedHeight = readStoredInputPaneHeight()
		applyInputPaneHeight(storedHeight ?? defaultInputHeight)
	})

	createEffect(() => {
		const viewWindow = options.getViewWindow()
		const onResize = () => {
			const height = inputPaneHeight()
			if (typeof height !== 'number') {
				return
			}
			const clampedHeight = clampInputPaneHeight(height)
			if (clampedHeight !== height) {
				applyInputPaneHeight(clampedHeight, true)
			}
		}
		viewWindow.addEventListener('resize', onResize)
		onCleanup(() => viewWindow.removeEventListener('resize', onResize))
	})

	createEffect(() => {
		const inputPaneEl = options.inputPaneEl()
		const inputTextareaEl = options.inputTextareaEl()
		if (!inputPaneEl || !inputTextareaEl) {
			return
		}
		const observer = new ResizeObserver(() => {
			const height = inputPaneHeight()
			if (typeof height !== 'number') {
				return
			}
			const clampedHeight = clampInputPaneHeight(height)
			if (clampedHeight !== height) {
				applyInputPaneHeight(clampedHeight, true)
			}
		})
		observer.observe(inputPaneEl)
		observer.observe(inputTextareaEl)
		onCleanup(() => observer.disconnect())
	})

	return {
		getTextareaHeightStyle,
		resetInputPaneHeight,
		onInputPaneResizeStart,
		onInputPaneResize,
		onInputPaneResizeEnd,
	}
}
