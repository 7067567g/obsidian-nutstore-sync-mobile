import { webcrypto } from 'node:crypto'

if (!globalThis.crypto) {
	globalThis.crypto = webcrypto as Crypto
}

// Obsidian plugins should use `window.setTimeout`/`window.clearTimeout` for
// popout-window compatibility. Unit tests run in Node, which has no `window`.
if (typeof window === 'undefined') {
	Object.assign(globalThis, { window: globalThis })
}
