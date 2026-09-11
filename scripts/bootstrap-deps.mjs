#!/usr/bin/env node
/**
 * S1 依赖 bootstrap（仅 Android / 本地自用场景）。
 *
 * 背景：package.json 与 pnpm-lock.yaml 锁定的是私有 @nutstore/sso-js@0.0.9；
 * 公开 npm 上没有 0.0.9，只有 0.0.8。本脚本在临时目录中用公开 0.0.8 完成
 * 一次完整 pnpm install，再把构建好的 node_modules 换回仓库，并在安装结果里
 * 注入明确报错、用户可见提示的 LlmGatewayClient stub。
 *
 * 约束：
 * - 不修改仓库 package.json / pnpm-lock.yaml；
 * - 不改动业务源码；
 * - node_modules 只是可再生成的构建产物，S0 仓库改动备份不受影响。
 *
 * 用法：
 *   node scripts/bootstrap-deps.mjs             # 已 bootstrap 且校验通过时直接退出
 *   node scripts/bootstrap-deps.mjs --force     # 强制重建 node_modules
 *   node scripts/bootstrap-deps.mjs --no-backup # 不保留旧 node_modules（不建议首次使用）
 *
 * 可选环境变量：
 *   NUTSTORE_MODELS_API_JSON=/path/to/real/models-api.json
 *     覆盖 Git LFS 缺失时的本地真实 JSON（sha256 必须与 LFS pointer 一致）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = new Set(process.argv.slice(2))
const force = argv.has('--force')
const noBackup = argv.has('--no-backup')

const packageJsonPath = join(repoRoot, 'package.json')
const lockfilePath = join(repoRoot, 'pnpm-lock.yaml')
const nodeModulesPath = join(repoRoot, 'node_modules')
const markerPath = join(nodeModulesPath, '.bootstrap-deps.json')
const modelsApiPath = join(repoRoot, 'src', 'ai', 'models-api.json')

const SSO_NAME = '@nutstore/sso-js'
const LOCKED_SSO_VERSION = '0.0.9'
const PUBLIC_SSO_VERSION = '0.0.8'
const PUBLIC_SSO_TARBALL =
	'https://registry.npmjs.org/@nutstore/sso-js/-/sso-js-0.0.8.tgz'
const PUBLIC_SSO_INTEGRITY =
	'sha512-mby3hzfVuE0Ch/nbe/PsvoR5h4bHHHSHTOycDDOLGrbFqO1mTn7L5LcvaPHskjBHxCeN2Y3PotOZOJiy5eRZmQ=='

const GATEWAY_STUB_MARKER = '/* NS_LOCAL_GATEWAY_STUB_V1 */'
const GATEWAY_UNAVAILABLE_MESSAGE =
	'Nutstore AI gateway is unavailable in this local test build: the private @nutstore/sso-js@0.0.9 package could not be installed. Use a custom OpenAI-compatible provider (e.g. DeepSeek) instead.'
const GATEWAY_STUB_MJS =
	`\n${GATEWAY_STUB_MARKER}\n` +
	`const __NS_GATEWAY_UNAVAILABLE__ = ${JSON.stringify(GATEWAY_UNAVAILABLE_MESSAGE)}\n\n` +
	`export class LlmGatewayClient {\n` +
	`\tconstructor(options) {\n\t\tthis.options = options\n\t}\n` +
	`\tasync createDeviceAuthorization() {\n\t\tthrow new Error(__NS_GATEWAY_UNAVAILABLE__)\n\t}\n` +
	`\tcreateVerificationUrl() {\n\t\tthrow new Error(__NS_GATEWAY_UNAVAILABLE__)\n\t}\n` +
	`\tgetLlmGatewayEndpoints() {\n\t\tthrow new Error(__NS_GATEWAY_UNAVAILABLE__)\n\t}\n` +
	`\tasync refreshToken() {\n\t\tthrow new Error(__NS_GATEWAY_UNAVAILABLE__)\n\t}\n` +
	`\tasync pollDeviceToken() {\n\t\tthrow new Error(__NS_GATEWAY_UNAVAILABLE__)\n\t}\n` +
	`\tasync cancelDeviceAuthorization() {\n\t\tthrow new Error(__NS_GATEWAY_UNAVAILABLE__)\n\t}\n` +
	`}\n`
const GATEWAY_STUB_DTS =
	`\n${GATEWAY_STUB_MARKER}\n` +
	`export interface LlmGatewayDeviceAuthorization {\n` +
	`\tdevice_code: string\n` +
	`\tuser_code: string\n` +
	`\tverification_uri: string\n` +
	`\tinterval: number\n` +
	`\texpires_in: number\n` +
	`}\n\n` +
	`export interface LlmGatewayEndpoints {\n` +
	`\tmodels: string\n` +
	`\topenaiCompatibleBaseUrl: string\n` +
	`}\n\n` +
	`export interface LlmGatewayTokenResponse {\n` +
	`\taccess_token: string\n` +
	`\trefresh_token: string\n` +
	`\texpires_in?: number\n` +
	`\trefresh_expires_in?: number\n` +
	`}\n\n` +
	`export type LlmGatewayPollResult =\n` +
	`\t| { ok: true; data: LlmGatewayTokenResponse; error?: never }\n` +
	`\t| { ok: false; data?: never; error: { code: string; message: string } }\n\n` +
	`export declare class LlmGatewayClient {\n` +
	`\tconstructor(options?: { fetcher?: unknown; [key: string]: unknown })\n` +
	`\tcreateDeviceAuthorization(options: { clientId: string }): Promise<LlmGatewayDeviceAuthorization>\n` +
	`\tcreateVerificationUrl(options: { verificationUri: string; userCode: string }): string\n` +
	`\tgetLlmGatewayEndpoints(): LlmGatewayEndpoints\n` +
	`\trefreshToken(options: { refreshToken: string }): Promise<LlmGatewayTokenResponse>\n` +
	`\tpollDeviceToken(options: { deviceCode: string; userCode: string }): Promise<LlmGatewayPollResult>\n` +
	`\tcancelDeviceAuthorization(options: { deviceCode: string }): Promise<void>\n` +
	`}\n`
function log(...args) {
	console.log('[bootstrap-deps]', ...args)
}

function sha256(data) {
	return createHash('sha256').update(data).digest('hex')
}

function replaceFile(path, content) {
	const temporary = `${path}.ns-bootstrap-${process.pid}-${Date.now()}`
	writeFileSync(temporary, content)
	renameSync(temporary, path)
}

function resolvePnpm() {
	const probe = spawnSync('pnpm', ['--version'], { encoding: 'utf8' })
	if (!probe.error && probe.status === 0) {
		return { command: 'pnpm', args: [] }
	}
	const npmExecPath = process.env.npm_execpath
	if (npmExecPath && existsSync(npmExecPath)) {
		const nested = spawnSync(process.execPath, [npmExecPath, '--version'], {
			encoding: 'utf8',
		})
		if (!nested.error && nested.status === 0) {
			return { command: process.execPath, args: [npmExecPath] }
		}
	}
	throw new Error('未找到可用的 pnpm（需要 pnpm 11.x 或通过 pnpm 运行本脚本）')
}

function runPnpmInstall(cwd) {
	const pnpm = resolvePnpm()
	log(`pnpm install (cwd=${cwd})`)
	const result = spawnSync(
		pnpm.command,
		[
			...pnpm.args,
			'install',
			'--ignore-workspace',
			'--ignore-scripts',
			'--no-frozen-lockfile',
			'--prefer-offline',
			'--reporter=append-only',
		],
		{
			cwd,
			stdio: 'inherit',
			env: {
				...process.env,
				COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
			},
		},
	)
	if (result.error) {
		throw new Error(`pnpm install 启动失败：${result.error.message}`)
	}
	if (result.status !== 0) {
		throw new Error(`pnpm install 失败，退出码 ${result.status}`)
	}
}

function readPackageVersion(directory) {
	return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
		.version
}

function verifyBootstrap(nodeModulesDir, options = {}) {
	const expectStub = options.expectStub !== false
	try {
		if (!existsSync(nodeModulesDir)) {
			return false
		}
		if (readPackageVersion(join(nodeModulesDir, 'esbuild')) !== '0.17.3') {
			return false
		}
		if (readPackageVersion(join(nodeModulesDir, 'typescript')) !== '5.9.3') {
			return false
		}
		if (readPackageVersion(join(nodeModulesDir, 'vitest')) !== '3.2.7') {
			return false
		}

		const ssoDir = realpathSync(join(nodeModulesDir, SSO_NAME))
		if (readPackageVersion(ssoDir) !== PUBLIC_SSO_VERSION) {
			return false
		}
		if (expectStub) {
			const ssoEntry = readFileSync(join(ssoDir, 'dist', 'index.mjs'), 'utf8')
			if (
				!ssoEntry.includes(GATEWAY_STUB_MARKER) ||
				!ssoEntry.includes('class LlmGatewayClient')
			) {
				return false
			}
			if (
				!readFileSync(join(ssoDir, 'dist', 'index.d.mts'), 'utf8').includes(
					GATEWAY_STUB_MARKER,
				)
			) {
				return false
			}
		}

		for (const bin of [
			'tsc',
			'vitest',
			'eslint',
			'esbuild',
			'swc',
			'run-s',
			'run-p',
		]) {
			if (!existsSync(join(nodeModulesDir, '.bin', bin))) {
				return false
			}
		}
		return true
	} catch {
		return false
	}
}

function patchLockfile() {
	const original = readFileSync(lockfilePath, 'utf8')
	let lock = original
	const importerPattern =
		/(\n {6}'@nutstore\/sso-js':\n {8}specifier: )\^0\.0\.9(\n {8}version: )0\.0\.9/
	if (importerPattern.test(lock)) {
		lock = lock.replace(
			importerPattern,
			(_match, prefix, suffix) =>
				`${prefix}${PUBLIC_SSO_VERSION}${suffix}${PUBLIC_SSO_VERSION}`,
		)
	}
	lock = lock.replaceAll(
		`${SSO_NAME}@${LOCKED_SSO_VERSION}`,
		`${SSO_NAME}@${PUBLIC_SSO_VERSION}`,
	)
	const privateResolution =
		/^(\s*)resolution: \{integrity: [^\n,]+, tarball: https:\/\/npm\.pkg\.github\.com\/download\/@nutstore\/sso-js\/0\.0\.9\/[^}\n]+\}$/m
	if (!privateResolution.test(lock)) {
		throw new Error(
			'pnpm-lock.yaml 中未找到预期私有 @nutstore/sso-js@0.0.9 tarball，无法安全生成临时替身',
		)
	}
	lock = lock.replace(
		privateResolution,
		(_match, indent) =>
			`${indent}resolution: {integrity: ${PUBLIC_SSO_INTEGRITY}, tarball: ${PUBLIC_SSO_TARBALL}}`,
	)
	if (lock === original) {
		throw new Error('未能在临时 lockfile 中替换 @nutstore/sso-js@0.0.9')
	}
	return lock
}

function writeStageProject(stageDir) {
	const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
	if (!packageJson.dependencies?.[SSO_NAME]) {
		throw new Error(`package.json 缺少 ${SSO_NAME} 依赖`)
	}
	packageJson.dependencies[SSO_NAME] = PUBLIC_SSO_VERSION
	writeFileSync(
		join(stageDir, 'package.json'),
		`${JSON.stringify(packageJson, null, '\t')}\n`,
	)
	writeFileSync(join(stageDir, 'pnpm-lock.yaml'), patchLockfile())
	log(
		`临时工程：${SSO_NAME}@${PUBLIC_SSO_VERSION} 替代 lock 中的 ${LOCKED_SSO_VERSION}（仅存在于临时目录）`,
	)
}

function applyGatewayStub(nodeModulesDir) {
	const ssoDir = realpathSync(join(nodeModulesDir, SSO_NAME))
	const entryPath = join(ssoDir, 'dist', 'index.mjs')
	const typesPath = join(ssoDir, 'dist', 'index.d.mts')
	const packagePath = join(ssoDir, 'package.json')

	const entry = readFileSync(entryPath, 'utf8')
	if (!entry.includes(GATEWAY_STUB_MARKER)) {
		replaceFile(entryPath, `${entry}${GATEWAY_STUB_MJS}`)
	}
	const types = readFileSync(typesPath, 'utf8')
	if (!types.includes(GATEWAY_STUB_MARKER)) {
		replaceFile(typesPath, `${types}${GATEWAY_STUB_DTS}`)
	}

	const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
	packageJson._localSubstitute = {
		sourcePackage: `${SSO_NAME}@${PUBLIC_SSO_VERSION}`,
		substituteFor: `${SSO_NAME}@${LOCKED_SSO_VERSION}`,
		gatewayStub: GATEWAY_STUB_MARKER,
		notice:
			'LlmGatewayClient 是明确报错的本地 stub；其他 0.0.8 公共 API（OAuth / decryptSecret）保持可用。',
	}
	replaceFile(packagePath, `${JSON.stringify(packageJson, null, '\t')}\n`)

	replaceFile(
		join(ssoDir, 'GATEWAY-STUB-NOTICE.txt'),
		[
			'This package is a local build-chain substitute.',
			`source: ${SSO_NAME}@${PUBLIC_SSO_VERSION} (public npm)`,
			`intended for: ${SSO_NAME}@${LOCKED_SSO_VERSION} (private GitHub Packages, unavailable)`,
			'',
			'The bundled LlmGatewayClient is intentionally replaced with a stub that throws:',
			GATEWAY_UNAVAILABLE_MESSAGE,
			'',
			'Do not publish this node_modules tree or a bundle containing this stub as-is.',
		].join('\n') + '\n',
	)
}

function writeMarker(nodeModulesDir) {
	const ssoDir = realpathSync(join(nodeModulesDir, SSO_NAME))
	const marker = {
		schemaVersion: 1,
		bootstrappedAt: new Date().toISOString(),
		repo: repoRoot,
		lockedRequirement: `${SSO_NAME}@${LOCKED_SSO_VERSION}`,
		installedPublicSource: {
			package: `${SSO_NAME}@${PUBLIC_SSO_VERSION}`,
			tarball: PUBLIC_SSO_TARBALL,
			integrity: PUBLIC_SSO_INTEGRITY,
		},
		gatewayStub: {
			marker: GATEWAY_STUB_MARKER,
			error: GATEWAY_UNAVAILABLE_MESSAGE,
			entrySha256: sha256(readFileSync(join(ssoDir, 'dist', 'index.mjs'))),
		},
		verifiedVersions: {
			esbuild: readPackageVersion(join(nodeModulesDir, 'esbuild')),
			typescript: readPackageVersion(join(nodeModulesDir, 'typescript')),
			vitest: readPackageVersion(join(nodeModulesDir, 'vitest')),
		},
		note: 'node_modules 由 bootstrap-deps.mjs 从临时同构工程安装后换入；仓库 package.json / pnpm-lock.yaml 未修改。',
	}
	writeFileSync(
		join(nodeModulesDir, '.bootstrap-deps.json'),
		`${JSON.stringify(marker, null, '\t')}\n`,
	)
}

function parseLfsPointer(text) {
	const oid = /^oid sha256:([a-f0-9]{64})$/m.exec(text)?.[1]
	const size = Number.parseInt(/^size (\d+)$/m.exec(text)?.[1] ?? '', 10)
	if (!oid || !Number.isFinite(size)) {
		throw new Error('无法解析 src/ai/models-api.json 的 Git LFS pointer')
	}
	return { oid, size }
}

async function fetchBytes(url) {
	const response = await fetch(url, {
		headers: { accept: 'application/octet-stream' },
		signal: AbortSignal.timeout(45_000),
	})
	if (!response.ok) {
		return null
	}
	return Buffer.from(await response.arrayBuffer())
}

async function ensureModelsApiJson() {
	if (!existsSync(modelsApiPath)) {
		throw new Error('缺少 src/ai/models-api.json')
	}
	const text = readFileSync(modelsApiPath, 'utf8')
	if (!text.startsWith('version https://git-lfs.github.com/spec/v1')) {
		log('models-api.json 已是真实内容，跳过 LFS 修复')
		return
	}
	const { oid, size } = parseLfsPointer(text)
	const localOverride = process.env.NUTSTORE_MODELS_API_JSON
	const candidates = [localOverride, '/tmp/media-models-api.json'].filter(
		(value) => typeof value === 'string' && value.length > 0,
	)
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue
		const bytes = readFileSync(candidate)
		if (bytes.length === size && sha256(bytes) === oid) {
			writeFileSync(modelsApiPath, bytes)
			log(`models-api.json 已从本地候选恢复：${candidate}`)
			return
		}
	}
	const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
		cwd: repoRoot,
		encoding: 'utf8',
	})
	const commitSha = commit.status === 0 ? commit.stdout.trim() : 'main'
	const urls = [
		`https://media.githubusercontent.com/media/nutstore/obsidian-nutstore-sync/${commitSha}/src/ai/models-api.json`,
		'https://media.githubusercontent.com/media/nutstore/obsidian-nutstore-sync/main/src/ai/models-api.json',
	]
	for (const url of urls) {
		try {
			log(`尝试下载 LFS 内容：${url}`)
			const bytes = await fetchBytes(url)
			if (!bytes) continue
			if (bytes.length !== size || sha256(bytes) !== oid) {
				log(`LFS 内容校验失败，跳过：${url}`)
				continue
			}
			writeFileSync(modelsApiPath, bytes)
			log('models-api.json 已从 GitHub LFS 恢复并通过 SHA-256 校验')
			return
		} catch (error) {
			log(`下载失败：${error instanceof Error ? error.message : String(error)}`)
		}
	}
	throw new Error(
		'src/ai/models-api.json 仍是 Git LFS pointer，且无法获得真实内容。' +
			`请设置 NUTSTORE_MODELS_API_JSON 指向 sha256=${oid} 的 JSON 文件后重试。`,
	)
}

function bootstrapWorkRoot() {
	const directory = join(homedir(), '.cache', 'nutstore-sync-bootstrap', 'work')
	mkdirSync(directory, { recursive: true })
	return directory
}

function backupDirectory() {
	const directory = join(homedir(), '.cache', 'nutstore-sync-bootstrap')
	mkdirSync(directory, { recursive: true })
	return directory
}

function swapNodeModules(stageNodeModules) {
	let backupPath = null
	if (existsSync(nodeModulesPath)) {
		if (!noBackup) {
			backupPath = join(
				backupDirectory(),
				`node_modules-${new Date().toISOString().replace(/[:.]/g, '-')}`,
			)
			try {
				renameSync(nodeModulesPath, backupPath)
			} catch (error) {
				if (error?.code !== 'EXDEV') throw error
				cpSync(nodeModulesPath, backupPath, { recursive: true })
				rmSync(nodeModulesPath, { recursive: true, force: true })
			}
		} else {
			rmSync(nodeModulesPath, { recursive: true, force: true })
		}
	}
	try {
		renameSync(stageNodeModules, nodeModulesPath)
	} catch (error) {
		if (error?.code !== 'EXDEV') {
			if (backupPath && !existsSync(nodeModulesPath) && existsSync(backupPath)) {
				renameSync(backupPath, nodeModulesPath)
			}
			throw error
		}
		try {
			cpSync(stageNodeModules, nodeModulesPath, { recursive: true })
			rmSync(stageNodeModules, { recursive: true, force: true })
		} catch (copyError) {
			rmSync(nodeModulesPath, { recursive: true, force: true })
			if (backupPath && existsSync(backupPath)) {
				renameSync(backupPath, nodeModulesPath)
			}
			throw copyError
		}
	}
	return backupPath
}

async function main() {
	await ensureModelsApiJson()

	if (!force && existsSync(markerPath) && verifyBootstrap(nodeModulesPath)) {
		log('node_modules 已是 bootstrap 状态，跳过。需要重建请使用 --force。')
		return
	}
	if (!existsSync(packageJsonPath) || !existsSync(lockfilePath)) {
		throw new Error('必须在 obsidian-nutstore-sync 仓库根目录运行本脚本')
	}

	const stageDir = mkdtempSync(join(bootstrapWorkRoot(), 'stage-'))
	let moved = false
	try {
		writeStageProject(stageDir)
		runPnpmInstall(stageDir)

		const stageNodeModules = join(stageDir, 'node_modules')
		if (!verifyBootstrap(stageNodeModules, { expectStub: false })) {
			throw new Error('临时安装结果校验失败，未注入 stub')
		}
		applyGatewayStub(stageNodeModules)
		writeMarker(stageNodeModules)
		if (!verifyBootstrap(stageNodeModules)) {
			throw new Error('stub 注入后 node_modules 校验失败')
		}

		const backupPath = swapNodeModules(stageNodeModules)
		moved = true
		if (!verifyBootstrap(nodeModulesPath)) {
			throw new Error('替换后的仓库 node_modules 校验失败')
		}
		rmSync(stageDir, { recursive: true, force: true })
		log(
			'bootstrap 完成：esbuild 0.17.3、.bin 完整、sso 0.0.8 + 明确网关 stub。',
		)
		if (backupPath) {
			log(`旧 node_modules 已备份到：${backupPath}`)
		}
	} catch (error) {
		if (!moved) {
			log(`失败时临时目录保留：${stageDir}`)
		}
		throw error
	}
}

main().catch((error) => {
	console.error(
		'[bootstrap-deps] 失败：',
		error instanceof Error ? error.stack : error,
	)
	process.exitCode = 1
})
