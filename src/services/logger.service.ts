import type { ConsolaReporter, LogObject } from 'consola'
import { moment } from 'obsidian'
import { IN_DEV } from '~/consts'
import logger from '~/utils/logger'
import { BaseService } from './service.interface'
import NutstorePlugin from '..'

export interface LogEntry {
	timestamp: string
	level: string
	args: unknown[]
}

const MAX_IN_MEMORY_LOGS = 5000

export default class LoggerService extends BaseService {
	logs: LogEntry[] = []

	constructor(private readonly plugin: NutstorePlugin) {
		super()
	}

	override onload() {
		const reporter: ConsolaReporter = {
			log: (logObj: LogObject) => {
				const entry: LogEntry = {
					timestamp: moment(logObj.date).format('YYYY-MM-DD HH:mm:ss'),
					level: logObj.type,
					args: logObj.args,
				}
				this.logs.push(entry)
				if (this.logs.length > MAX_IN_MEMORY_LOGS) {
					this.logs.splice(0, this.logs.length - MAX_IN_MEMORY_LOGS)
				}
				void this.plugin.diagnosticsLogFile
					?.append(entry.level, entry.args, entry.timestamp)
					.catch(() => undefined)
			},
		}
		if (IN_DEV) {
			// Keep default Consola console reporter; add ours alongside it.
			logger.addReporter(reporter)
		} else {
			logger.setReporters([reporter])
		}
	}

	clear() {
		this.logs = []
		void this.plugin.diagnosticsLogFile?.clear()
	}
}
