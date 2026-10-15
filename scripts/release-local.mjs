#!/usr/bin/env node
/**
 * Local release builder for the Android/self-use build.
 * Produces release/nutstore-sync-<version>/ with main.js, manifest.json,
 * styles.css, SHA256SUMS.txt and a build record. No upstream publishing.
 */
import { createHash } from 'node:crypto'
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

// `fileURLToPath` decodes percent-encoded path segments; `new URL().pathname`
// leaves them encoded and breaks `process.chdir` on non-ASCII paths such as a
// `20-工作区` parent directory.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
process.chdir(root)

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const outDir = join(root, 'release', `nutstore-sync-${version}`)

process.env.NS_NSDAV_ENDPOINT ??= 'https://dav.jianguoyun.com/nsdav'
process.env.NS_DAV_ENDPOINT ??= 'https://dav.jianguoyun.com/dav'
process.env.LLM_GATEWAY_CLIENT_ID ??= 'dc_obsidian_dp0gymrn'

function sha256(file) {
	return createHash('sha256').update(readFileSync(file)).digest('hex')
}

console.log('[release-local] building production bundle')
execFileSync(process.execPath, ['esbuild.config.mjs', 'production'], {
	cwd: root,
	stdio: 'inherit',
	env: { ...process.env, NODE_ENV: 'production' },
})
execFileSync(
	join(root, 'node_modules', '.bin', 'swc'),
	['./dist/main.js', '-o', 'main.js'],
	{
		cwd: root,
		stdio: 'inherit',
		env: { ...process.env, NODE_ENV: 'production' },
	},
)

const artifacts = ['main.js', 'manifest.json', 'styles.css']
for (const artifact of artifacts) {
	const path = join(root, artifact)
	if (!existsSync(path)) throw new Error(`missing build artifact: ${artifact}`)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
for (const artifact of artifacts) {
	cpSync(join(root, artifact), join(outDir, artifact))
}
const checksums = artifacts
	.map((artifact) => `${sha256(join(root, artifact))}  ${artifact}`)
	.join('\n')
writeFileSync(join(outDir, 'SHA256SUMS.txt'), `${checksums}\n`)

const commands = [
	`node esbuild.config.mjs production`,
	`swc ./dist/main.js -o main.js`,
].join('\n')
const buildRecord = `# 构建记录 · ${version}\n\n- 版本：${version}\n- 构建时间：${new Date().toISOString()}\n- 端点内联：\n  NS_NSDAV_ENDPOINT=${process.env.NS_NSDAV_ENDPOINT}\n  NS_DAV_ENDPOINT=${process.env.NS_DAV_ENDPOINT}\n  LLM_GATEWAY_CLIENT_ID=${process.env.LLM_GATEWAY_CLIENT_ID}\n- 命令：\n${commands}\n\n## SHA-256\n\n${checksums}\n`
writeFileSync(join(outDir, '构建记录.md'), buildRecord)

console.log(`[release-local] release ready: ${outDir}`)
