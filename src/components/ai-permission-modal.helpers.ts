import type { AIFileOperation } from '~/ai/tools/file-operation'
import i18n from '~/i18n'

export type AIPermissionResult =
	| 'approve'
	| 'approve-session'
	| 'approve-always'
	| 'auto-approve-operation'
	| 'deny'

export function getOperationLabel(operation: AIFileOperation): string {
	switch (operation) {
		case 'copy':
			return i18n.t('aiPermission.operations.copy')
		case 'delete':
			return i18n.t('aiPermission.operations.delete')
		case 'edit':
			return i18n.t('aiPermission.operations.edit')
		case 'mkdir':
			return i18n.t('aiPermission.operations.mkdir')
		case 'move':
			return i18n.t('aiPermission.operations.move')
		case 'read':
			return i18n.t('aiPermission.operations.read')
		case 'write':
			return i18n.t('aiPermission.operations.write')
	}
}
