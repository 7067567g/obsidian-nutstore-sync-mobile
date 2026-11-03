/**
 * Stable public contract for the `ai/chat` module.
 *
 * Re-exports only the long-lived domain model, message/display types and tool
 * outcome contracts. Higher-level internals (runtime loops, session
 * persistence, prompts, UI projection) stay behind their own import paths so
 * this barrel does not become a God module.
 */
export * from './domain'
export * from './types'
export * from './tool-outcome'
export * from './error-utils'
