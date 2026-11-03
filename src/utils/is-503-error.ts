const ERROR_MESSAGE = 'Invalid response: 503 Service Unavailable'
// Wrapped `requestUrl` failures carry a `${status}: ${text}` message, so a
// leading status code is the string fallback when no response object survives.
const STATUS_503_PREFIX = /^503\b/

type ErrorWithStatus = {
	status?: unknown
	res?: { status?: unknown }
}

/**
 * Status-aware 503 detection.
 *
 * The `webdav` library throws `Error('Invalid response: 503 Service
 * Unavailable')`, while the shared `requestUrl` wrapper throws a
 * `RequestUrlError` whose message is `${status}: ${text}`. Matching only the
 * legacy message missed every wrapped response, so 503 retries never fired.
 * Prefer the numeric HTTP status when present and keep the legacy string as a
 * fallback.
 */
export function is503Error(err: Error | string | undefined | null) {
	if (err instanceof Error) {
		const withStatus = err as Error & ErrorWithStatus
		const status = withStatus.res?.status ?? withStatus.status
		if (status === 503) {
			return true
		}
		return err.message === ERROR_MESSAGE || STATUS_503_PREFIX.test(err.message)
	}
	if (typeof err === 'string') {
		return err === ERROR_MESSAGE || STATUS_503_PREFIX.test(err)
	}
	return false
}
