import type { App } from 'obsidian'
import { tool } from 'ai'
import { z } from 'zod/mini'
import { appDep } from './tool-context'
import {
	clampInt,
	isVaultFileNode,
	normalizeVaultVirtualPath,
	toVaultPath,
} from './vault-native'

const DEFAULT_MAX_RESULTS = 200
const MAX_RESULTS = 1000
type LinkLike = { link: string }

function collectLinkLikes(
	cache:
		| {
				links?: unknown
				embeds?: unknown
				frontmatterLinks?: unknown
		  }
		| null
		| undefined,
): Array<{ kind: string; link: LinkLike }> {
	if (!cache) return []
	const rows: Array<{ kind: string; link: LinkLike }> = []
	for (const [kind, items] of [
		['link', cache.links],
		['embed', cache.embeds],
		['frontmatter', cache.frontmatterLinks],
	] as const) {
		if (!Array.isArray(items)) continue
		for (const item of items) {
			if (item && typeof (item as LinkLike).link === 'string') {
				rows.push({ kind, link: item as LinkLike })
			}
		}
	}
	return rows
}

function frontmatterTargets(value: unknown): string[] {
	if (typeof value === 'string') {
		const trimmed = value.trim()
		return trimmed ? [trimmed] : []
	}
	if (Array.isArray(value)) {
		return value.flatMap((item) => frontmatterTargets(item))
	}
	return []
}

export async function executeVaultLinks(
	app: App,
	virtualPath: string,
	direction: 'outgoing' | 'incoming' | 'both',
	maxResults = DEFAULT_MAX_RESULTS,
	frontmatterKeys: string[] = [],
) {
	const normalized = normalizeVaultVirtualPath(virtualPath)
	const vaultPath = toVaultPath(normalized)
	const node = app.vault.getAbstractFileByPath(vaultPath)
	if (!isVaultFileNode(node)) {
		throw new Error('vault_links requires a visible vault file: ' + normalized)
	}
	const file = node
	const limit = clampInt(maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS)
	const outgoing: Array<{
		kind: string
		target: string
		link: string
		unresolved?: boolean
	}> = []
	const seenOutgoing = new Set<string>()
	const cache = app.metadataCache.getFileCache(file)

	const pushTarget = (kind: string, raw: string, sourcePath = file.path) => {
		if (!raw.trim() || outgoing.length >= limit) return
		const resolved = app.metadataCache.getFirstLinkpathDest(raw, sourcePath)
		const target = resolved ? resolved.path : raw
		const key = kind + '|' + target
		if (seenOutgoing.has(key)) return
		seenOutgoing.add(key)
		outgoing.push({
			kind,
			target,
			link: raw,
			unresolved: resolved ? undefined : true,
		})
	}

	if (direction === 'outgoing' || direction === 'both') {
		for (const entry of collectLinkLikes(cache)) {
			pushTarget(entry.kind, entry.link.link)
			if (outgoing.length >= limit) break
		}
		const rawFrontmatter = (cache?.frontmatter ?? {}) as Record<string, unknown>
		for (const key of frontmatterKeys) {
			for (const target of frontmatterTargets(rawFrontmatter[key])) {
				pushTarget('frontmatter:' + key, target)
				if (outgoing.length >= limit) break
			}
			if (outgoing.length >= limit) break
		}
	}

	const incomingCounts = new Map<string, number>()
	if (direction === 'incoming' || direction === 'both') {
		const resolvedLinks = app.metadataCache.resolvedLinks ?? {}
		for (const [source, targets] of Object.entries(resolvedLinks)) {
			const count = targets[file.path]
			if (count) incomingCounts.set(source, count)
		}
		if (frontmatterKeys.length > 0) {
			for (const source of app.vault.getMarkdownFiles()) {
				if (source.path === file.path) continue
				const sourceFrontmatter =
					app.metadataCache.getFileCache(source)?.frontmatter
				if (!sourceFrontmatter) continue
				for (const key of frontmatterKeys) {
					for (const raw of frontmatterTargets(sourceFrontmatter[key])) {
						const resolved = app.metadataCache.getFirstLinkpathDest(
							raw,
							source.path,
						)
						if (resolved?.path === file.path) {
							incomingCounts.set(
								source.path,
								(incomingCounts.get(source.path) ?? 0) + 1,
							)
						}
					}
				}
			}
		}
	}
	const incoming = [...incomingCounts.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.slice(0, limit)
		.map(([source, count]) => ({ source, count }))

	return JSON.stringify(
		{
			path: file.path,
			outgoing,
			incoming,
			truncated: outgoing.length >= limit || incomingCounts.size > limit,
		},
		null,
		2,
	)
}

export const vaultLinksTool = tool({
	description: [
		'Inspect outgoing links and incoming backlinks for a visible vault file using Obsidian metadata cache.',
		'Use this instead of bash loops over see-also or reading every note to build a link graph.',
		'Input path is a vault virtual path. direction may be outgoing, incoming, or both.',
		'Set frontmatterKeys (for example ["see-also"]) to also resolve plain file-path values in frontmatter fields.',
		'Incoming links are computed from resolvedLinks and optional frontmatterKeys; unresolved raw targets are reported on outgoing only.',
	].join(' '),
	inputSchema: z.object({
		path: z.string(),
		direction: z.optional(
			z.union([
				z.literal('outgoing'),
				z.literal('incoming'),
				z.literal('both'),
			]),
		),
		maxResults: z.optional(z.number()),
		frontmatterKeys: z.optional(z.array(z.string())),
	}),
	contextSchema: z.object({ app: appDep }),
	outputSchema: z.string(),
	execute: async (
		{ path, direction, maxResults, frontmatterKeys },
		{ context },
	) =>
		executeVaultLinks(
			context.app,
			path,
			direction ?? 'both',
			maxResults ?? DEFAULT_MAX_RESULTS,
			frontmatterKeys ?? [],
		),
})
