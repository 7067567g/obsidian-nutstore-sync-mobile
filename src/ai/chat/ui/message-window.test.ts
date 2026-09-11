import { describe, expect, it } from 'vitest'
import {
	WINDOWED_RENDERING_THRESHOLD,
	messageWindowStyle,
	shouldWindowTimeline,
} from './message-window'

describe('message window', () => {
	it('enables windowing only above the configured threshold', () => {
		expect(shouldWindowTimeline(WINDOWED_RENDERING_THRESHOLD - 1)).toBe(false)
		expect(shouldWindowTimeline(WINDOWED_RENDERING_THRESHOLD)).toBe(true)
	})

	it('returns content-visibility style when enabled', () => {
		expect(messageWindowStyle(false)).toBeUndefined()
		expect(messageWindowStyle(true)).toEqual({
			'content-visibility': 'auto',
			'contain-intrinsic-size': 'auto 180px',
		})
	})
})
