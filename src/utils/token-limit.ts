const TOKEN_LIMIT_SUFFIXES: Record<string, number> = {
	k: 1_000,
	m: 1_000_000,
}

export const MAX_TOKEN_LIMIT = 100_000_000

export function tryParseTokenLimitInput(value: unknown): number | null {
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || value < 0) return null
		return Math.min(MAX_TOKEN_LIMIT, Math.floor(value))
	}
	if (typeof value !== 'string') return null
	const normalized = value.trim().replace(/[,_\s]/g, '')
	if (!normalized) return null
	const match = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(normalized)
	if (!match) return null
	const amount = Number.parseFloat(match[1])
	if (!Number.isFinite(amount) || amount < 0) return null
	const suffix = match[2]?.toLowerCase()
	const multiplier = suffix ? TOKEN_LIMIT_SUFFIXES[suffix] : 1
	return Math.min(MAX_TOKEN_LIMIT, Math.floor(amount * multiplier))
}

export function parseTokenLimitInput(value: unknown): number {
	return tryParseTokenLimitInput(value) ?? 0
}

export function formatTokenLimitInput(value: number): string {
	return Number.isFinite(value) && value > 0 ? String(Math.floor(value)) : '0'
}
