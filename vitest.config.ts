import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		alias: {
			'~': fileURLToPath(new URL('./src', import.meta.url)),
			// The published obsidian package ships type definitions only.
			obsidian: fileURLToPath(
				new URL('./test/mocks/obsidian.ts', import.meta.url),
			),
		},
	},
	test: {
		environment: 'node',
		setupFiles: ['./test/vitest.setup.ts'],
	},
})
