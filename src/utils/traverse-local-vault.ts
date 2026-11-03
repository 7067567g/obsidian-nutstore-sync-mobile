import { normalizePath, Vault } from 'obsidian'
import { StatModel } from '~/model/stat.model'
import logger from './logger'
import { getConfigDirSystemTraversalRules } from './config-dir-rules'
import GlobMatch from './glob-match'
import { statVaultItem } from './stat-vault-item'

export async function traverseLocalVault(vault: Vault, from: string) {
	const res: StatModel[] = []
	const q = [from]
	const ignores = getConfigDirSystemTraversalRules(vault.configDir).map(
		(rule) => new GlobMatch(rule.expr, rule.options),
	)
	function folderFilter(path: string) {
		path = normalizePath(path)
		if (ignores.some((rule) => rule.test(path))) {
			return false
		}
		return true
	}

	while (q.length > 0) {
		const currentLevelPaths = q.splice(0)
		const levelResults = await Promise.all(
			currentLevelPaths.map(async (current) => {
				const folderPath = normalizePath(current)
				let listed: Awaited<ReturnType<typeof vault.adapter.list>>
				try {
					listed = await vault.adapter.list(folderPath)
				} catch (error) {
					// Fail closed: a folder we cannot list means the scan is incomplete.
					// Returning an empty listing here would make the decider treat the
					// whole subtree as locally deleted and wipe the remote copy.
					logger.error(
						'Failed to list folder, aborting traversal:',
						folderPath,
						error,
					)
					throw new Error(
						`Local scan failed: cannot list folder '${folderPath}'. ` +
							`Sync aborted to avoid propagating an incomplete scan as deletions. ` +
							`Fix the folder (permissions/locks, e.g. another sync client holding it) or exclude it via filter rules.`,
						{ cause: error },
					)
				}
				const { files, folders } = listed
				const normalizedFiles = files.map((path) => normalizePath(path))
				const normalizedFolders = folders
					.map((path) => normalizePath(path))
					.filter(folderFilter)
				const contents = (
					await Promise.all(
						[...normalizedFiles, ...normalizedFolders].map((path) =>
							statVaultItem(vault, path),
						),
					)
				).filter((item): item is StatModel => item !== undefined)
				return { contents, folders: normalizedFolders }
			}),
		)
		for (const { contents, folders } of levelResults) {
			q.push(...folders)
			res.push(...contents)
		}
	}
	return res
}
