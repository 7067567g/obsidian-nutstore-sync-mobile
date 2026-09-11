import { Platform } from 'obsidian'
import { requestUrl } from 'obsidian'

export interface PlatformCapabilities {
	isMobileApp: boolean
	cryptoSubtle: boolean
	cryptoRandomUUID: boolean
	cryptoGetRandomValues: boolean
	requestUrl: boolean
	adapterAppend: boolean
	adapterAppendBinary: boolean
	abortSignalTimeout: boolean
	structuredClone: boolean
	requestIdleCallback: boolean
}

export function detectPlatformCapabilities(options?: {
	adapter?: { append?: unknown; appendBinary?: unknown }
}): PlatformCapabilities {
	const cryptoLike = typeof crypto === 'undefined' ? undefined : crypto
	return {
		isMobileApp: !!Platform?.isMobileApp,
		cryptoSubtle: typeof cryptoLike?.subtle?.digest === 'function',
		cryptoRandomUUID: typeof cryptoLike?.randomUUID === 'function',
		cryptoGetRandomValues: typeof cryptoLike?.getRandomValues === 'function',
		requestUrl: typeof requestUrl === 'function',
		adapterAppend: typeof options?.adapter?.append === 'function',
		adapterAppendBinary: typeof options?.adapter?.appendBinary === 'function',
		abortSignalTimeout:
			typeof AbortSignal !== 'undefined' &&
			typeof (AbortSignal as { timeout?: unknown }).timeout === 'function',
		structuredClone: typeof structuredClone === 'function',
		requestIdleCallback:
			typeof window !== 'undefined' &&
			typeof (window as { requestIdleCallback?: unknown })
				.requestIdleCallback === 'function',
	}
}
