#!/usr/bin/env node
/**
 * CODE-03 / GATE-C ratchet (R6): the `no-unsafe-*` family plus
 * `no-misused-promises` must stay at `error` for non-test TypeScript sources,
 * and the bulk-suppression ledger must not come back. Runs inside
 * `tests/run.sh` right after `eslint`.
 *
 * If a future round genuinely needs a new suppression, decide that explicitly
 * in the round plan and update this script in the same commit — do not quietly
 * turn the rules off again.
 */
import { access } from 'node:fs/promises'
import { ESLint } from 'eslint'

const STRICT_RULES = [
	'@typescript-eslint/no-unsafe-assignment',
	'@typescript-eslint/no-unsafe-argument',
	'@typescript-eslint/no-unsafe-call',
	'@typescript-eslint/no-unsafe-member-access',
	'@typescript-eslint/no-unsafe-return',
	'@typescript-eslint/no-misused-promises',
]

const SOURCE_SAMPLES = [
	'src/ai/tools/vault-json.ts',
	'src/components/SyncProgressModal.ts',
	'src/services/chat.service.ts',
	'src/index.ts',
]

const SUPPRESSIONS_FILE = 'eslint-suppressions.json'

const eslint = new ESLint({ cwd: process.cwd() })
let failed = false

try {
	await access(SUPPRESSIONS_FILE)
	console.error(
		`FAIL  ${SUPPRESSIONS_FILE} exists; fix violations instead of pinning them`,
	)
	failed = true
} catch {
	// expected: the ledger is intentionally gone
}

for (const file of SOURCE_SAMPLES) {
	const config = await eslint.calculateConfigForFile(file)
	for (const rule of STRICT_RULES) {
		const severity = config?.rules?.[rule]?.[0]
		if (severity !== 2) {
			console.error(
				`FAIL  ${rule} in ${file}: expected severity 2, got ${String(severity)}`,
			)
			failed = true
		}
	}
}

if (failed) process.exit(1)
console.log(
	`OK  ${STRICT_RULES.length} rules × ${SOURCE_SAMPLES.length} files = error; no ${SUPPRESSIONS_FILE}`,
)
