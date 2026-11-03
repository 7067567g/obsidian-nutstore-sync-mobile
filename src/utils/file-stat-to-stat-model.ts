import { FileStat } from 'webdav'
import { StatModel } from '~/model/stat.model'

/**
 * `webdav` leaves `lastmod` empty when the server omits `Last-Modified`
 * (`api/webdav.ts` maps it to `''`), and `new Date('').valueOf()` is `NaN`.
 * A `NaN` mtime poisons every `isSameTime` comparison (always unequal), which
 * makes sync keep re-detecting the same change. Fall back to a deterministic
 * epoch so the value is stable across calls.
 */
function toMtime(lastmod: string | undefined): number {
	if (!lastmod) {
		return 0
	}
	const parsed = new Date(lastmod).valueOf()
	return Number.isNaN(parsed) ? 0 : parsed
}

export function fileStatToStatModel(from: FileStat): StatModel {
	const serverMtime = toMtime(from.lastmod)
	if (from.type === 'directory') {
		return {
			path: from.filename,
			basename: from.basename,
			isDir: true,
			isDeleted: false,
			mtime: serverMtime,
			serverMtime,
			etag: from.etag ?? undefined,
		}
	}
	return {
		path: from.filename,
		basename: from.basename,
		isDir: false,
		isDeleted: false,
		mtime: serverMtime,
		size: from.size,
		serverMtime,
		etag: from.etag ?? undefined,
	}
}
