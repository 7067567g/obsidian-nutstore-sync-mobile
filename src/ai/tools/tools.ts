import { bashTool } from './bash/tool'
import { applyPatchTool } from './apply-patch'
import { settingsPatchTool, settingsReadTool } from './settings-tools'
import { todoWriteTool } from './todowrite'
import { updateSessionTitleTool } from './update-session-title'
import { taskTool } from './task'
import { vaultBatchEditTool } from './vault-batch-edit'
import { vaultFrontmatterTool } from './vault-frontmatter'
import { vaultGrepTool } from './vault-grep'
import { vaultHashTool } from './vault-hash'
import { vaultJsonTool } from './vault-json'
import { vaultLinksTool } from './vault-links'
import { vaultListTool } from './vault-list'
import { vaultReadTool } from './vault-read'
import { vaultStatTool } from './vault-stat'
import { viewImageTool } from './view-image'
import { viewPdfTool } from './view-pdf'

export interface CreateAIToolsOptions {
	allowSpawn?: boolean
	enableTodoWrite?: boolean
	enableViewImage?: boolean
}

export function createAITools(options: CreateAIToolsOptions = {}) {
	return {
		vault_list: vaultListTool,
		vault_read: vaultReadTool,
		vault_stat: vaultStatTool,
		vault_json: vaultJsonTool,
		vault_hash: vaultHashTool,
		vault_grep: vaultGrepTool,
		vault_links: vaultLinksTool,
		vault_frontmatter: vaultFrontmatterTool,
		vault_batch_edit: vaultBatchEditTool,
		view_pdf: viewPdfTool,
		settings_read: settingsReadTool,
		settings_patch: settingsPatchTool,
		...(options.enableTodoWrite ? { todowrite: todoWriteTool } : {}),
		update_session_title: updateSessionTitleTool,
		apply_patch: applyPatchTool,
		bash: bashTool,
		...(options.enableViewImage ? { view_image: viewImageTool } : {}),
		...(options.allowSpawn !== false ? { task: taskTool } : {}),
	}
}
