/**
 * Stable public contract for the `ai/tools` module.
 *
 * Exposes the tool factory plus the shared file-operation and permission
 * contracts that callers use to build tool dependencies. Individual tool
 * implementations stay behind their own import paths.
 */
export { createAITools, type CreateAIToolsOptions } from './tools'
export {
	AI_FILE_OPERATIONS,
	createFragmentReadTracker,
	type AIFileOperation,
	type AIDualPathFileOperation,
	type AISinglePathFileOperation,
	type ReadTracker,
} from './file-operation'
export {
	createFullAccessPermissionGuard,
	createPermissionGuard,
	createReadonlyPermissionGuard,
	getPermissionRequestOperationSignature,
	withPermissionPurpose,
	type PermissionGuard,
	type PermissionRequest,
} from './permission-guard'
