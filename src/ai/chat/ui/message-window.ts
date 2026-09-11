export const WINDOWED_RENDERING_THRESHOLD = 80

export function shouldWindowTimeline(total: number): boolean {
	return total >= WINDOWED_RENDERING_THRESHOLD
}

import type { JSX } from 'solid-js'

export function messageWindowStyle(
	enabled: boolean,
	intrinsicSize = 'auto 180px',
): JSX.CSSProperties | undefined {
	if (!enabled) return undefined
	return {
		'content-visibility': 'auto',
		'contain-intrinsic-size': intrinsicSize,
	}
}
