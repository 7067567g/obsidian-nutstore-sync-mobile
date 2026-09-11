export type StatModel =
	| {
			path: string
			basename: string
			isDir: true
			isDeleted: boolean
			mtime?: number
			/** Server-provided Last-Modified timestamp, when available. */
			serverMtime?: number
			/** Server-provided content version/ETag, when available. */
			etag?: string
	  }
	| {
			path: string
			basename: string
			isDir: false
			isDeleted: boolean
			mtime: number
			size: number
			/** Server-provided Last-Modified timestamp, when available. */
			serverMtime?: number
			/** Server-provided content version/ETag, when available. */
			etag?: string
			/** Content SHA-256 hash for the local snapshot, when computed. */
			hash?: string
	  }
