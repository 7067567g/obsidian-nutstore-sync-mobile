import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import {
	createElementStub,
	normalizePath,
	Notice,
	parseYaml,
	Plugin,
	recordedNotices,
	resetRecordedNotices,
	stringifyYaml,
} from './obsidian'

/**
 * Symbols that `src` imports through `import { … } from 'obsidian'` but that are
 * TypeScript-only and therefore erased before runtime. Everything else must be
 * provided by the mock, otherwise a unit test only fails once it happens to
 * import the affected module.
 */
const TYPE_ONLY_IMPORTS = new Set([
	'RequestUrlParam',
	'RequestUrlResponse',
	'TAbstractFile',
])

function collectSourceFiles(dir: string): string[] {
	const files: string[] = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) {
			files.push(...collectSourceFiles(path))
		} else if (
			/\.(ts|tsx)$/.test(entry.name) &&
			!entry.name.includes('.test.')
		) {
			files.push(path)
		}
	}
	return files
}

function runtimeObsidianImports(): Map<string, string[]> {
	const imports = new Map<string, string[]>()
	for (const file of collectSourceFiles('src')) {
		const source = ts.createSourceFile(
			file,
			readFileSync(file, 'utf8'),
			ts.ScriptTarget.Latest,
			true,
			file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		)
		for (const statement of source.statements) {
			if (!ts.isImportDeclaration(statement)) continue
			const specifier = statement.moduleSpecifier
			if (!ts.isStringLiteral(specifier) || specifier.text !== 'obsidian') {
				continue
			}
			const clause = statement.importClause
			if (!clause || clause.isTypeOnly) continue
			const bindings = clause.namedBindings
			if (!bindings || ts.isNamespaceImport(bindings)) continue
			for (const element of bindings.elements) {
				if (element.isTypeOnly) continue
				const name = (element.propertyName ?? element.name).text
				imports.set(name, [...(imports.get(name) ?? []), file])
			}
		}
	}
	return imports
}

describe('obsidian mock contract', () => {
	it('exports every runtime symbol that src imports from obsidian', async () => {
		const mock = await import('./obsidian')
		const missing: string[] = []
		for (const [name, files] of runtimeObsidianImports()) {
			if (TYPE_ONLY_IMPORTS.has(name)) continue
			if (!(name in mock)) {
				missing.push(`${name} (${files.slice(0, 3).join(', ')})`)
			}
		}
		expect(missing).toEqual([])
	})
})

describe('obsidian mock elements', () => {
	it('wires children, text, attributes and classes', () => {
		const parent = createElementStub()
		const child = parent.createEl('span', {
			cls: 'label primary',
			text: 'Hello',
		})

		expect(child.tagName).toBe('span')
		expect(child.parentElement).toBe(parent)
		expect(parent.children).toContain(child)
		expect(child.hasClass('label')).toBe(true)
		expect(child.classList.contains('primary')).toBe(true)
		expect(child.textContent).toBe('Hello')

		child.setAttr('data-id', '42')
		expect(child.getAttr('data-id')).toBe('42')
		expect(child.getAttr('missing')).toBeNull()

		child.setText('Bye')
		expect(child.children).toEqual([])
		expect(child.textContent).toBe('Bye')
	})

	it('tracks class toggles and detaches removed nodes', () => {
		const element = createElementStub()
		element.addClass('a', 'b')
		expect(element.classList.contains('a')).toBe(true)
		expect(element.className).toBe('a b')

		expect(element.toggleClass('a')).toBe(false)
		expect(element.hasClass('a')).toBe(false)
		expect(element.toggleClass('a', true)).toBe(true)
		expect(element.classList.contains('a')).toBe(true)

		element.classList.remove('b')
		expect(element.hasClass('b')).toBe(false)

		const child = element.createDiv()
		expect(element.children).toContain(child)
		child.remove()
		expect(element.children).not.toContain(child)
		expect(child.parentElement).toBeNull()

		element.appendChild(child)
		element.empty()
		expect(element.children).toEqual([])
		expect(child.parentElement).toBeNull()
	})
})

describe('obsidian mock notices and plugin data', () => {
	afterEach(() => {
		resetRecordedNotices()
	})

	it('records created notices for assertions', () => {
		new Notice('First')
		const second = new Notice('Second', 5000)

		expect(recordedNotices().map((notice) => notice.message)).toEqual([
			'First',
			'Second',
		])
		expect(second.timeout).toBe(5000)

		resetRecordedNotices()
		expect(recordedNotices()).toEqual([])
	})

	it('persists plugin data across saveData/loadData', async () => {
		const plugin = new Plugin({}, {})
		expect(await plugin.loadData()).toBeNull()

		await plugin.saveData({ language: 'zh' })
		expect(await plugin.loadData()).toEqual({ language: 'zh' })
	})
})

describe('obsidian mock value helpers', () => {
	it('normalizes vault paths', () => {
		expect(normalizePath('//a//b/../c/')).toBe('a/b/../c')
		expect(normalizePath('a\\b\\c')).toBe('a/b/c')
	})

	it('round-trips flat yaml values', () => {
		const yaml = stringifyYaml({ name: 'note', count: 2 })
		expect(yaml).toBe('name: "note"\ncount: 2\n')
		expect(parseYaml(yaml)).toEqual({ name: '"note"', count: '2' })
	})
})
