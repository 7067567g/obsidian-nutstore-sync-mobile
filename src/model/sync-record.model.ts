import { StatModel } from './stat.model'

export interface SyncRecordModel {
	local: StatModel
	remote: StatModel
	base?: {
		key: string
		/** Content hash of the stored base snapshot, when known. */
		hash?: string
	}
}
