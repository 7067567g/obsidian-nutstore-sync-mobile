import type { Vault } from 'obsidian'
import type { FilePart } from 'ai'
import type {
	AppUIMessage,
	ChatDisplayBlock,
	ChatDisplayContentBlock,
} from '~/ai/chat/types'
import type { ChatSession } from '~/ai/chat/domain'
import type { UserContextItem } from '~/ai/chat/context/user-context'
import { formatUserContext } from '~/ai/chat/context/user-context'
import { isImageFilePart } from './message-utils'
import { projectTimelineMessageGroups } from '~/ai/chat/ui/display-blocks'
import { getUserContextItems } from './ui-message'
import { getMasterAgent } from '~/ai/chat/domain'
import i18n from '~/i18n'
import { formatDuration } from '~/utils/format-duration'

/**
 * Image asset writers are injected so the rendering layer stays free of the
 * network `fetch` path that eslint.config.mts scopes to export-session.ts.
 */
export interface ExportSessionAssetWriters {
	saveExportImage(
		vault: Vault,
		part: FilePart,
		assetsDirPath: string,
		assetsMarkdownPrefix: string,
	): Promise<string | undefined>
	saveExportUserContextImage(
		vault: Vault,
		item: Extract<UserContextItem, { type: 'image' }>,
		assetsDirPath: string,
		assetsMarkdownPrefix: string,
	): Promise<string | undefined>
}

function toMarkdownHeadingText(value: string) {
	return value.replace(/\r?\n/g, ' ').trim()
}

const MAX_EXPORT_FILE_BYTES = 64 * 1024

/**
 * Reads a Blob as UTF-8 text, cutting at `maxBytes` without splitting a code
 * point. `stream: true` keeps an incomplete trailing sequence inside the
 * decoder instead of emitting a replacement character.
 */
async function readTruncatedBlobText(
	blob: Blob,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
	if (blob.size <= maxBytes) {
		return { text: await blob.text(), truncated: false }
	}
	const decoder = new TextDecoder('utf-8')
	const text = decoder.decode(await blob.slice(0, maxBytes).arrayBuffer(), {
		stream: true,
	})
	return { text, truncated: true }
}

async function buildMessageContentMarkdown(
	vault: Vault,
	content: ChatDisplayContentBlock['parts'],
	assetsDirPath: string,
	assetsMarkdownPrefix: string,
	assets: ExportSessionAssetWriters,
) {
	const lines: string[] = []
	for (const part of content) {
		if (part.type === 'text') {
			const text = part.text.trim()
			if (text) lines.push(text)
			continue
		}
		if (!isImageFilePart(part)) continue
		const imageRef = await assets.saveExportImage(
			vault,
			part,
			assetsDirPath,
			assetsMarkdownPrefix,
		)
		if (!imageRef) continue
		lines.push(`![](${imageRef})`)
	}
	return lines
}

async function buildUserContextMarkdown(
	vault: Vault,
	record: AppUIMessage,
	assetsDirPath: string,
	assetsMarkdownPrefix: string,
	assets: ExportSessionAssetWriters,
) {
	const userContext = getUserContextItems(record)
	if (!userContext.length) {
		return []
	}
	const lines: string[] = []
	const textContext = userContext.filter(
		(item) => item.type === 'vault-path' || item.type === 'selection',
	)
	if (textContext.length) {
		lines.push(formatUserContext(textContext), '')
	}
	for (const item of userContext) {
		if (item.type === 'image') {
			const imageRef = await assets.saveExportUserContextImage(
				vault,
				item,
				assetsDirPath,
				assetsMarkdownPrefix,
			)
			if (imageRef) {
				lines.push(`![](${imageRef})`, '')
			}
			continue
		}
		if (item.type !== 'file') {
			continue
		}
		const { text: content, truncated } = await readTruncatedBlobText(
			item.blob,
			MAX_EXPORT_FILE_BYTES,
		)
		lines.push(
			[
				'<UserProvidedFile>',
				JSON.stringify(
					{
						type: 'file',
						filename: item.filename,
						mimeType: item.mimeType,
						size: item.size,
						truncated,
						content,
					},
					null,
					2,
				),
				'</UserProvidedFile>',
			].join('\n'),
			'',
		)
	}
	return lines
}

function getModelLabel(session: ChatSession, record: AppUIMessage) {
	const sessionModel =
		session.model?.providerId && session.model?.modelId
			? `${session.model.providerId}/${session.model.modelId}`
			: undefined
	const metaModel =
		record.metadata?.llm?.modelName || record.metadata?.llm?.modelId
	const metaProvider =
		record.metadata?.llm?.providerName || record.metadata?.llm?.providerId
	return metaModel && metaProvider
		? `${metaProvider}/${metaModel}`
		: metaModel || metaProvider || sessionModel || 'unknown-model'
}

function getBlockHeadingLabel(
	session: ChatSession,
	record: AppUIMessage,
	block: ChatDisplayBlock,
) {
	if (block.kind === 'system-notification') {
		return `🔔 ${i18n.t('chatbox.exportRole.systemNotification')}`
	}
	if (record.role === 'user') {
		return `👤 ${i18n.t('chatbox.exportRole.user')}`
	}
	if (record.role === 'assistant') {
		const modelLabel = getModelLabel(session, record)
		const emoji = block.kind === 'tool-call' ? '🔧' : '🤖'
		return `${emoji} ${modelLabel}`
	}
	return `🛠 ${i18n.t('chatbox.exportRole.tool')}`
}

async function buildDisplayBlockMarkdown(
	vault: Vault,
	block: ChatDisplayBlock,
	assetsDirPath: string,
	assetsMarkdownPrefix: string,
	assets: ExportSessionAssetWriters,
) {
	if (block.kind === 'content') {
		return buildMessageContentMarkdown(
			vault,
			block.parts,
			assetsDirPath,
			assetsMarkdownPrefix,
			assets,
		)
	}
	if (block.kind === 'reasoning') {
		const text = block.part.text.trim()
		return text ? [`> ${text.replace(/\n/g, '\n> ')}`] : []
	}
	if (block.kind === 'system-notification') {
		return ['```json', JSON.stringify(block.notification, null, 2), '```']
	}
	const lines = [
		`- ${i18n.t('chatbox.exportMeta.toolName')}: \`${block.toolCall.toolName}\``,
		`- ${i18n.t('chatbox.exportMeta.toolCallId')}: \`${block.toolCall.toolCallId}\``,
		...(block.timing
			? [
					`- ${i18n.t('chatbox.exportMeta.duration')}: \`${formatDuration((block.timing.finishedAt ?? Date.now()) - (block.timing.startedAt ?? block.timing.finishedAt ?? Date.now()))}\``,
				]
			: []),
	]
	const todos = block.todos
	if (block.toolCall.toolName === 'todowrite' && todos) {
		lines.push('')
		for (const todo of todos) {
			const checked =
				todo.status === 'completed'
					? 'x'
					: todo.status === 'cancelled'
						? '-'
						: ' '
			lines.push(`- [${checked}] ${todo.content}`)
		}
		if (todos.length === 0) {
			lines.push(`- ${i18n.t('chatbox.ui.states.todoEmpty')}`)
		}
		return lines
	}
	lines.push(
		'',
		'```json',
		JSON.stringify(block.toolCall.input ?? {}, null, 2),
		'```',
	)
	if (block.toolCall.state === 'output-available') {
		lines.push(
			'',
			'```text',
			typeof block.toolCall.output === 'string'
				? block.toolCall.output
				: JSON.stringify(block.toolCall.output, null, 2),
			'```',
		)
	} else if (block.toolCall.state === 'output-error') {
		lines.push('', '```text', block.toolCall.errorText, '```')
	}
	return lines
}

export async function buildSessionMarkdown(
	vault: Vault,
	session: ChatSession,
	title: string,
	includeToolMessages: boolean,
	manifestVersion: string,
	assetsDirPath: string,
	assetsMarkdownPrefix: string,
	assets: ExportSessionAssetWriters,
) {
	const sessionModel =
		session.model?.providerId && session.model?.modelId
			? `${session.model.providerId}/${session.model.modelId}`
			: undefined
	const lines: string[] = [
		'---',
		`title: ${JSON.stringify(toMarkdownHeadingText(title))}`,
		`sessionId: ${JSON.stringify(session.id)}`,
		`exportedAt: ${JSON.stringify(new Date().toLocaleString())}`,
		`createdAt: ${JSON.stringify(new Date(session.createdAt).toLocaleString())}`,
		`updatedAt: ${JSON.stringify(new Date(session.updatedAt).toLocaleString())}`,
		`model: ${JSON.stringify(sessionModel || null)}`,
		`includeToolMessages: ${includeToolMessages ? 'true' : 'false'}`,
		`pluginVersion: ${JSON.stringify(manifestVersion)}`,
		'---',
		'',
		`# ${toMarkdownHeadingText(title)}`,
		'',
	]

	const masterAgent = getMasterAgent(session)
	for (const { message: record, blocks } of projectTimelineMessageGroups(
		masterAgent.timeline,
		masterAgent.toolTimings,
	)) {
		const userContextLines =
			record.role === 'user'
				? await buildUserContextMarkdown(
						vault,
						record,
						assetsDirPath,
						assetsMarkdownPrefix,
						assets,
					)
				: []
		if (blocks.length === 0) {
			lines.push(
				`### ${record.role === 'user' ? `👤 ${i18n.t('chatbox.exportRole.user')}` : getModelLabel(session, record)}`,
				'',
				`${i18n.t('chatbox.exportMeta.messageTime')}: ${new Date(record.metadata?.createdAt ?? session.createdAt).toLocaleString()}`,
				'',
			)
			if (userContextLines.length > 0) {
				lines.push(...userContextLines)
			} else {
				lines.push(i18n.t('chatbox.exportMeta.emptyContent'), '')
			}
			continue
		}
		let appendedUserContext = false
		for (const block of blocks) {
			if (!includeToolMessages && block.kind === 'tool-call') {
				continue
			}
			lines.push(`### ${getBlockHeadingLabel(session, record, block)}`, '')
			lines.push(
				`${i18n.t('chatbox.exportMeta.messageTime')}: ${new Date(record.metadata?.createdAt ?? session.createdAt).toLocaleString()}`,
				'',
			)
			const blockLines = await buildDisplayBlockMarkdown(
				vault,
				block,
				assetsDirPath,
				assetsMarkdownPrefix,
				assets,
			)
			if (blockLines.length > 0) {
				lines.push(...blockLines, '')
			}
			if (!appendedUserContext && userContextLines.length > 0) {
				lines.push(...userContextLines)
				appendedUserContext = true
			}
			if (blockLines.length === 0 && record.role !== 'assistant') {
				if (!appendedUserContext) {
					lines.push(i18n.t('chatbox.exportMeta.emptyContent'), '')
				}
			}
		}
	}

	return `${lines.join('\n').trim()}\n`
}
