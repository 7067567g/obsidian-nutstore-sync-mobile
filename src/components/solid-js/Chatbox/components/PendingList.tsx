import { For, Show } from 'solid-js'
import { Notice } from 'obsidian'
import type { ChatboxProps } from '~/ai/chat/ui/types'
import { t } from '~/components/solid-js/i18n'
import { ContextArea } from './ContextArea'

export function PendingList(props: {
	pending: ChatboxProps['pending']
	onCancelPending?: ChatboxProps['onCancelPendingSubmission']
}) {
	return (
		<Show when={props.pending.length > 0}>
			<div class=":uno: rounded-3 border border-dashed border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] p-3">
				<div class=":uno: text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
					{t('chatbox.ui.labels.queuedSubmissions')}
				</div>
				<div class=":uno: mt-2 flex flex-col gap-2">
					<For each={props.pending}>
						{(submission) => (
							<div class=":uno: flex items-start gap-2 rounded-2 bg-[var(--background-secondary)] p-3 text-sm text-[var(--text-normal)]">
								<div class=":uno: min-w-0 flex-1 whitespace-pre-wrap break-words select-text">
									<Show when={submission.userContext.length > 0}>
										<ContextArea items={submission.userContext} />
									</Show>
									<Show when={submission.text.trim().length > 0}>
										<div>{submission.text}</div>
									</Show>
								</div>
								<button
									type="button"
									class=":uno: i-lucide-trash-2 size-3.5 shrink-0 cursor-pointer rounded p-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--background-modifier-hover)] hover:text-[var(--text-error)] focus-visible:bg-[var(--background-modifier-hover)] focus-visible:text-[var(--text-error)] active:scale-90 active:text-[var(--text-error)]"
									aria-label={t('chatbox.ui.labels.removeQueuedSubmission')}
									onClick={() => {
										void Promise.resolve(
											props.onCancelPending?.(submission.id),
										).then((removed: boolean | undefined) => {
											if (removed === false) {
												new Notice(
													t('chatbox.ui.labels.removeQueuedSubmissionFailed'),
												)
											}
										})
									}}
								/>
							</div>
						)}
					</For>
				</div>
			</div>
		</Show>
	)
}
