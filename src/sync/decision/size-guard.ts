import { parse as bytesParse } from 'bytes-iec'
import { SkipReason, SkippedTaskOptions } from '~/sync/tasks/skipped.task'
import { BaseTask } from '~/sync/tasks/task.interface'
import {
	SyncDecisionSettings,
	TaskFactory,
	TaskOptions,
} from './sync-decision.interface'

/**
 * Shared `size-guard` policy for P4 deciders.
 *
 * All three deciders (two-way / receive-only / send-only) read the byte budget
 * from `settings.skipLargeFiles.maxSize` with identical parsing semantics:
 * empty string means "no limit", otherwise JEDEC units, falling back to
 * `Infinity` when parsing fails.
 */
export function resolveMaxFileSize(settings: SyncDecisionSettings): number {
	const maxFileSizeStr = settings.skipLargeFiles.maxSize.trim()
	if (maxFileSizeStr === '') {
		return Infinity
	}
	return bytesParse(maxFileSizeStr, { mode: 'jedec' }) ?? Infinity
}

/**
 * Push a `SkippedTask` (`reason: FileTooLarge`) for the supplied sizes.
 *
 * Only defined sizes are attached, matching the previous inline construction
 * in every decider call site.
 */
export function pushFileTooLargeTask(
	tasks: BaseTask[],
	taskFactory: TaskFactory,
	taskOptions: TaskOptions,
	maxFileSize: number,
	sizes: { remoteSize?: number; localSize?: number },
): void {
	const options: SkippedTaskOptions = {
		...taskOptions,
		reason: SkipReason.FileTooLarge,
		maxSize: maxFileSize,
		...(sizes.remoteSize === undefined ? {} : { remoteSize: sizes.remoteSize }),
		...(sizes.localSize === undefined ? {} : { localSize: sizes.localSize }),
	} as SkippedTaskOptions
	tasks.push(taskFactory.createSkippedTask(options))
}
