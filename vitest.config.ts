import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// `fileURLToPath` decodes percent-encoded characters (e.g. spaces and non-ASCII
// path segments such as a `20-工作区` parent directory); `new URL().pathname`
// leaves them encoded and breaks module resolution.
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
