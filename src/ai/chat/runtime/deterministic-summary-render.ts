import {
	clipText,
	compactInline,
	type DeterministicFacts,
} from './deterministic-summary-facts'

function renderSection(title: string, items: string[]) {
	const body =
		items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- (none)'
	return `## ${title}\n${body}`
}

export function renderSummary(
	facts: DeterministicFacts,
	options: { maxItems: number; maxItemChars: number },
) {
	const files = [...facts.files.values()]
		.sort((left, right) => left.path.localeCompare(right.path))
		.slice(0, options.maxItems)
		.map((file) => {
			const usage = [
				file.writes > 0 ? `W×${file.writes}` : undefined,
				file.reads > 0 ? `R×${file.reads}` : undefined,
			]
				.filter(Boolean)
				.join(' ')
			return `${clipText(file.path, options.maxItemChars)}${usage ? ` — ${usage}` : ''}`
		})
	const dedupLines = [...facts.dedup.entries()]
		.filter(([, count]) => count > 1)
		.sort(([left], [right]) => left.localeCompare(right))
		.slice(0, options.maxItems)
		.map(
			([signature, count]) =>
				`重复调用：${clipText(signature, options.maxItemChars)} ×${count}`,
		)
	const currentUser = facts.currentUser.at(-1)
	const currentAssistant = facts.currentAssistant.at(-1)
	const currentWork: string[] = []
	if (currentUser)
		currentWork.push(
			`最近用户要求：${clipText(compactInline(currentUser), options.maxItemChars)}`,
		)
	if (currentAssistant) {
		const lines = currentAssistant
			.split('\n')
			.map((line) => compactInline(line))
			.filter(Boolean)
			.slice(0, 2)
		if (lines.length > 0) {
			currentWork.push(
				`最近进展：${clipText(lines.join(' / '), options.maxItemChars)}`,
			)
		}
	}
	const pending = facts.pending.slice(-options.maxItems)
	return [
		renderSection('User Goals', facts.intents.slice(-options.maxItems)),
		renderSection('Vault Context', facts.vaultContext.slice(-options.maxItems)),
		renderSection('Vault Files Touched', files),
		renderSection(
			'Issues and Resolutions',
			facts.errors.slice(-options.maxItems),
		),
		renderSection('Pending Requests', pending),
		renderSection('Current Work', currentWork),
		renderSection('Next Step', pending.length > 0 ? [`${pending.at(-1)}`] : []),
		renderSection(
			'Critical Context',
			[
				...facts.critical.slice(-options.maxItems),
				...facts.reasoningExcerpts
					.slice(-options.maxItems)
					.map((item) => `仅思考轮摘录：${item}`),
				...dedupLines,
				`确定性压缩覆盖 ${facts.scannedMessages} 条消息 / ${facts.toolCallCount} 次工具调用（未调用 LLM）`,
			].slice(-options.maxItems),
		),
	].join('\n\n')
}

export function renderTerse(facts: DeterministicFacts, label: string) {
	const files = [...facts.files.values()]
		.sort((left, right) => left.path.localeCompare(right.path))
		.slice(0, 5)
		.map((file) => file.path)
	const lines = [
		'# Prior Context Summary',
		'',
		'## User Goals',
		...(facts.intents.slice(-3).map((item) => `- ${item}`) || []),
		'',
		'## Vault Files Touched',
		...(files.length > 0 ? files.map((path) => `- ${path}`) : ['- (none)']),
		'',
		'## Issues and Fixes',
		...(facts.errors.slice(-3).map((item) => `- ${item}`) || []),
		'',
		'## Next Step',
		`- ${facts.pending.at(-1) ?? '(none)'}`,
		'',
		'## Prior Summary',
		`- ${label}`,
	]
	return lines.join('\n')
}
