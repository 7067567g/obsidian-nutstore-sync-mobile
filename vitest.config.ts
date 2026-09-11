import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		alias: {
			'~': new URL('./src', import.meta.url).pathname,
			// The published obsidian package ships type definitions only.
			obsidian: new URL('./test/mocks/obsidian.ts', import.meta.url).pathname,
		},
	},
	test: {
		environment: 'node',
		setupFiles: ['./test/vitest.setup.ts'],
	},
})
