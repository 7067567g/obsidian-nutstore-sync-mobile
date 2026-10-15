import { describe, expect, it } from 'vitest'
import { MAX_VIEW_IMAGE_BYTES, assertViewImageSize } from './view-image'

describe('view_image byte guard', () => {
	it('accepts images at or below the ceiling', () => {
		expect(() => assertViewImageSize(MAX_VIEW_IMAGE_BYTES)).not.toThrow()
	})

	it('rejects oversized images before decode', () => {
		expect(() => assertViewImageSize(MAX_VIEW_IMAGE_BYTES + 1)).toThrow(
			'Image is too large for mobile view_image',
		)
	})
})
