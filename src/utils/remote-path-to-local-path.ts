import { isAbsolute, normalize } from 'path-browserify'

/**
 * Strips the remote base directory prefix from an absolute remote path and
 * returns the Vault-relative local path form (forward slashes, no leading
 * separator).
 *
 * The base directory is matched on a full path-segment boundary, so a sibling
 * like `/basex/...` is not mistaken for a child of `/base`. Callers usually
 * pass a `stdRemotePath()` base (with a trailing slash); a base without one is
 * normalized here too, so the result never keeps the leading `/` that would
 * otherwise leak into Vault API calls.
 */
export function remotePathToLocalPath(
	remoteBaseDir: string,
	remotePath: string,
) {
	const base = normalize(remoteBaseDir)
	const baseWithoutTrailing =
		base.endsWith('/') && base.length > 1 ? base.slice(0, -1) : base
	const baseWithSlash =
		baseWithoutTrailing === '/' ? '/' : `${baseWithoutTrailing}/`
	const normalizedRemotePath = normalize(remotePath)
	if (isAbsolute(normalizedRemotePath)) {
		if (normalizedRemotePath === baseWithoutTrailing) {
			return ''
		}
		if (normalizedRemotePath.startsWith(baseWithSlash)) {
			const relative = normalizedRemotePath.slice(baseWithSlash.length)
			return relative === '' ? '' : normalize(relative)
		}
	}
	return normalizedRemotePath
}
