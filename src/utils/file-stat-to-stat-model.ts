import { FileStat } from 'webdav'
import { StatModel } from '~/model/stat.model'

export function fileStatToStatModel(from: FileStat): StatModel {
	const serverMtime = new Date(from.lastmod).valueOf()
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
