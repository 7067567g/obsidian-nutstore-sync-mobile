import { AIModelConfig } from '~/ai/core/types'
import { type ChatModalMountTarget } from '~/ai/chat/ui/modal-mount'

export interface ModelEditorOptions {
	findPresetOnSave?: boolean
	presetProviderApi?: string
	modalMountTarget?: ChatModalMountTarget
}

export const INPUT_MODALITY_OPTIONS: AIModelConfig['modalities']['input'] = [
	'text',
	'image',
	'pdf',
	'video',
	'audio',
	'file',
]
