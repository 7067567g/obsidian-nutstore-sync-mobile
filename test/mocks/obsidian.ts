/**
 * Runtime stub for the type-only `obsidian` package used by Vitest.
 *
 * The published `obsidian` package ships type definitions only, so unit tests
 * resolve the `obsidian` import to this module (see `vitest.config.ts`). Keep the
 * runtime surface in sync with the symbols actually imported by `src`/`test`;
 * every stub below is intentionally inert and DOM-free, so importing a module
 * under test can never fail because of Obsidian itself.
 *
 * Coverage (GATE-E, 2026-10-16): `src`/`test` import these **runtime** symbols
 * from `obsidian` — App, ButtonComponent, Component, DropdownComponent, ItemView,
 * MarkdownRenderer, MarkdownView, Menu, Modal, Notice, Platform, Plugin,
 * PluginSettingTab, Setting, TFile, TFolder, TextComponent, Vault, WorkspaceLeaf,
 * addIcon, apiVersion, loadPdfJs, moment, normalizePath, parseYaml, requestUrl,
 * requireApiVersion, setIcon, stringifyYaml. Type-only symbols
 * (`DataAdapter`, `RequestUrlParam`, `RequestUrlResponse`, `TAbstractFile`, …)
 * are erased at build time and are intentionally not stubbed.
 *
 * R6 CODE-05 hardening: elements are stateful (text/attributes/classes/
 * parent-child), `Notice` records instances for assertions, and
 * `Plugin.loadData`/`saveData` keep data in memory. `test/mocks/obsidian.test.ts`
 * pins these behaviours and fails if `src` starts importing an un-stubbed
 * runtime symbol.
 */

// DOM-free element stand-in. This mock type does not need to satisfy
// `HTMLElement`: consumers type-check against the real `obsidian` package while
// at runtime they only touch the members implemented here. Keeping it locally
// typed avoids `as unknown as HTMLElement` escapes inside the mock.
type StubClassList = {
	add: (...classes: string[]) => void
	remove: (...classes: string[]) => void
	toggle: (cls: string, force?: boolean) => boolean
	contains: (cls: string) => boolean
}

type StubElement = {
	tagName: string
	className: string
	createEl: (tag: string, options?: Record<string, unknown>) => StubElement
	createDiv: (options?: Record<string, unknown>) => StubElement
	empty: () => void
	setText: (text: unknown) => void
	setAttr: (name: string, value: string) => void
	getAttr: (name: string) => string | null
	addClass: (...classes: string[]) => void
	removeClass: (...classes: string[]) => void
	toggleClass: (classes: string | string[], value?: boolean) => boolean
	hasClass: (cls: string) => boolean
	appendChild: <T>(child: T) => T
	remove: () => void
	detach: () => void
	addEventListener: (...args: unknown[]) => void
	removeEventListener: (...args: unknown[]) => void
	style: Record<string, string>
	classList: StubClassList
	textContent: string
	innerHTML: string
	children: StubElement[]
	parentElement: StubElement | null
}

function splitClasses(classes: string): string[] {
	return classes.split(/\s+/).filter(Boolean)
}

/**
 * Stateful element stub: enough DOM semantics that tests can assert on text,
 * attributes, classes and parent/child wiring instead of only "does not throw".
 */
function createStubEl(tagName = 'div'): StubElement {
	const attributes = new Map<string, string>()
	const classes = new Set<string>()
	const children: StubElement[] = []
	const element: StubElement = {
		tagName,
		className: '',
		createEl: (tag, options) => {
			const child = createStubEl(tag)
			if (typeof options?.cls === 'string') child.addClass(options.cls)
			if (options?.text !== undefined) child.setText(options.text)
			element.appendChild(child)
			return child
		},
		createDiv: (options) => element.createEl('div', options),
		empty: () => {
			for (const child of children.splice(0)) child.parentElement = null
			element.textContent = ''
			element.innerHTML = ''
		},
		setText: (text) => {
			element.empty()
			element.textContent = String(text)
		},
		setAttr: (name, value) => {
			attributes.set(name, String(value))
		},
		getAttr: (name) => attributes.get(name) ?? null,
		addClass: (...values) => {
			for (const value of values) {
				for (const cls of splitClasses(value)) classes.add(cls)
			}
			element.className = [...classes].join(' ')
		},
		removeClass: (...values) => {
			for (const value of values) {
				for (const cls of splitClasses(value)) classes.delete(cls)
			}
			element.className = [...classes].join(' ')
		},
		toggleClass: (value, force) => {
			const list =
				typeof value === 'string'
					? splitClasses(value)
					: value.flatMap(splitClasses)
			for (const cls of list) {
				const next = force === undefined ? !classes.has(cls) : force
				if (next) classes.add(cls)
				else classes.delete(cls)
			}
			element.className = [...classes].join(' ')
			return list.every((cls) => classes.has(cls))
		},
		hasClass: (cls) => classes.has(cls),
		appendChild: (child) => {
			const candidate = child as unknown as Partial<StubElement>
			if (candidate && typeof candidate === 'object') {
				if (typeof candidate.detach === 'function') candidate.detach()
				candidate.parentElement = element
				const stub = candidate as StubElement
				if (!children.includes(stub)) children.push(stub)
			}
			return child
		},
		remove: () => {
			element.detach()
		},
		detach: () => {
			const parent = element.parentElement
			if (!parent) return
			const index = parent.children.indexOf(element)
			if (index >= 0) parent.children.splice(index, 1)
			element.parentElement = null
		},
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		style: {},
		classList: {
			add: (...values) => {
				element.addClass(...values)
			},
			remove: (...values) => {
				element.removeClass(...values)
			},
			toggle: (cls, force) => element.toggleClass(cls, force),
			contains: (cls) => element.hasClass(cls),
		},
		textContent: '',
		innerHTML: '',
		children,
		parentElement: null,
	}
	return element
}

export function normalizePath(path: string) {
	return path
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
}

/** Mock-only: create a detached stateful element stub. */
export function createElementStub(tagName = 'div'): StubElement {
	return createStubEl(tagName)
}

export class Vault {}

export const apiVersion = '1.13.7'

export const Platform = {
	isMobileApp: false,
	isMobile: false,
	isDesktop: false,
	isDesktopApp: false,
	isAndroidApp: false,
	isIosApp: false,
	isPhone: false,
	isTablet: false,
	isMacOS: false,
	isWin: false,
	isLinux: false,
}

export function requestUrl() {
	throw new Error('requestUrl is not implemented in unit tests')
}

export function stringifyYaml(value: Record<string, unknown>) {
	return (
		Object.entries(value)
			.map(([key, item]) => key + ': ' + JSON.stringify(item))
			.join('\n') + '\n'
	)
}

export function parseYaml(text: string): Record<string, unknown> {
	const result: Record<string, unknown> = {}
	for (const line of text.split(/\r?\n/)) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
		if (!match) continue
		const value = match[2].trim()
		result[match[1]] = value === '' ? [] : value
	}
	return result
}

export function loadPdfJs(): Promise<never> {
	return Promise.reject(new Error('loadPdfJs is not implemented in unit tests'))
}

function parseVersion(version: string): number[] {
	return version.split('.').map((part) => Number.parseInt(part, 10) || 0)
}

/** Obsidian's `requireApiVersion` compares the running `apiVersion` to `version`. */
export function requireApiVersion(version: string): boolean {
	const current = parseVersion(apiVersion)
	const required = parseVersion(version)
	for (let i = 0; i < Math.max(current.length, required.length); i += 1) {
		const diff = (current[i] ?? 0) - (required[i] ?? 0)
		if (diff !== 0) return diff > 0
	}
	return true
}

function pad(value: number, width = 2): string {
	return String(value).padStart(width, '0')
}

function toDate(input: unknown): Date {
	if (input instanceof Date) return input
	if (typeof input === 'string' || typeof input === 'number') {
		return new Date(input)
	}
	return new Date()
}

type MomentLike = {
	format: (template?: string) => string
	toISOString: () => string
	valueOf: () => number
	fromNow: () => string
	clone: () => MomentLike
}

/** Minimal `moment` stand-in covering the `format` tokens this plugin uses. */
export function moment(input?: unknown): MomentLike {
	const date = toDate(input)
	return {
		format: (pattern = 'YYYY-MM-DDTHH:mm:ssZ') => {
			const replacements: Record<string, string> = {
				YYYY: String(date.getFullYear()),
				MM: pad(date.getMonth() + 1),
				DD: pad(date.getDate()),
				HH: pad(date.getHours()),
				mm: pad(date.getMinutes()),
				ss: pad(date.getSeconds()),
				SSS: pad(date.getMilliseconds(), 3),
			}
			return pattern.replace(
				/YYYY|MM|DD|HH|mm|ss|SSS/g,
				(token) => replacements[token] ?? token,
			)
		},
		toISOString: () => date.toISOString(),
		valueOf: () => date.getTime(),
		fromNow: () => '',
		clone: () => moment(date),
	}
}

export class Component {
	onload(): void {}
	onunload(): void {}
	load(): void {
		this.onload()
	}
	unload(): void {
		this.onunload()
	}
	register(_callback: unknown): void {}
	registerEvent(_eventRef: unknown): void {}
	registerDomEvent(..._args: unknown[]): void {}
	registerInterval(id: number): number {
		return id
	}
	addChild<T>(child: T): T {
		return child
	}
	removeChild<T>(child: T): T {
		return child
	}
}

const recordedNoticeInstances: Notice[] = []

/** Mock-only: notices created since the last `resetRecordedNotices()`. */
export function recordedNotices(): readonly Notice[] {
	return recordedNoticeInstances
}

/** Mock-only: clear the notice log between assertions. */
export function resetRecordedNotices(): void {
	recordedNoticeInstances.length = 0
}

export class Notice {
	message: string | DocumentFragment | undefined
	timeout: number | undefined

	constructor(message?: string | DocumentFragment, timeout?: number) {
		this.message = message
		this.timeout = timeout
		recordedNoticeInstances.push(this)
	}

	setMessage(message: string | DocumentFragment): this {
		this.message = message
		return this
	}

	hide(): void {}
}

export class TextComponent {
	inputEl: StubElement

	constructor() {
		this.inputEl = createStubEl()
	}

	setValue(_value: string): this {
		return this
	}
	getValue(): string {
		return ''
	}
	setPlaceholder(_placeholder: string): this {
		return this
	}
	setDisabled(_disabled: boolean): this {
		return this
	}
	onChange(_callback: (value: string) => unknown): this {
		return this
	}
	onChanged(): void {}
}

export class DropdownComponent {
	selectEl: StubElement

	constructor() {
		this.selectEl = createStubEl()
	}

	addOption(_value: string, _display: string): this {
		return this
	}
	addOptions(_options: Record<string, string>): this {
		return this
	}
	setValue(_value: string): this {
		return this
	}
	getValue(): string {
		return ''
	}
	setDisabled(_disabled: boolean): this {
		return this
	}
	onChange(_callback: (value: string) => unknown): this {
		return this
	}
}

export class ButtonComponent {
	buttonEl: StubElement

	constructor(_containerEl?: StubElement) {
		this.buttonEl = createStubEl()
	}

	setButtonText(_text: string): this {
		return this
	}
	setIcon(_icon: string): this {
		return this
	}
	setTooltip(_tooltip: string): this {
		return this
	}
	setCta(): this {
		return this
	}
	setWarning(): this {
		return this
	}
	setDisabled(_disabled: boolean): this {
		return this
	}
	onClick(_callback: (event: unknown) => unknown): this {
		return this
	}
}

export class Setting {
	settingEl: StubElement
	infoEl: StubElement
	nameEl: StubElement
	descEl: StubElement
	controlEl: StubElement

	constructor(containerEl: StubElement) {
		this.settingEl = containerEl
		this.infoEl = containerEl
		this.nameEl = containerEl
		this.descEl = containerEl
		this.controlEl = containerEl
	}

	setName(_name: string): this {
		return this
	}
	setDesc(_desc: string | DocumentFragment): this {
		return this
	}
	setClass(_cls: string): this {
		return this
	}
	setHeading(): this {
		return this
	}
	setTooltip(_tooltip: string): this {
		return this
	}
	setDisabled(_disabled: boolean): this {
		return this
	}
	setDynamicTooltip(): this {
		return this
	}
	addText(callback?: (component: TextComponent) => unknown): this {
		callback?.(new TextComponent())
		return this
	}
	addTextArea(callback?: (component: TextComponent) => unknown): this {
		callback?.(new TextComponent())
		return this
	}
	addSearch(callback?: (component: TextComponent) => unknown): this {
		callback?.(new TextComponent())
		return this
	}
	addDropdown(callback?: (component: DropdownComponent) => unknown): this {
		callback?.(new DropdownComponent())
		return this
	}
	addButton(callback?: (component: ButtonComponent) => unknown): this {
		callback?.(new ButtonComponent())
		return this
	}
	addToggle(_callback?: (component: unknown) => unknown): this {
		return this
	}
	addExtraButton(_callback?: (component: unknown) => unknown): this {
		return this
	}
	addMomentFormat(_callback?: (component: unknown) => unknown): this {
		return this
	}
	addSlider(_callback?: (component: unknown) => unknown): this {
		return this
	}
	addColorPicker(_callback?: (component: unknown) => unknown): this {
		return this
	}
	addProgressBar(_callback?: (component: unknown) => unknown): this {
		return this
	}
}

export class Modal {
	app: unknown
	containerEl: StubElement
	modalEl: StubElement
	contentEl: StubElement
	titleEl: StubElement
	scope: unknown

	constructor(app: unknown) {
		this.app = app
		this.containerEl = createStubEl()
		this.modalEl = createStubEl()
		this.contentEl = createStubEl()
		this.titleEl = createStubEl()
		this.scope = {}
	}

	open(): void {
		this.onOpen()
	}
	close(): void {
		this.onClose()
	}
	onOpen(): void {}
	onClose(): void {}
}

export class App {}

export class TFile {
	path: string
	name: string
	basename: string
	extension: string
	parent: TFolder | null
	stat: { ctime: number; mtime: number; size: number }

	constructor(path = '') {
		this.path = path
		const name = path.split('/').pop() ?? ''
		const dot = name.lastIndexOf('.')
		this.name = name
		this.basename = dot > 0 ? name.slice(0, dot) : name
		this.extension = dot > 0 ? name.slice(dot + 1) : ''
		this.parent = null
		this.stat = { ctime: 0, mtime: 0, size: 0 }
	}
}

export class TFolder {
	path: string
	name: string
	children: unknown[]
	parent: TFolder | null

	constructor(path = '') {
		this.path = path
		this.name = path.split('/').pop() ?? ''
		this.children = []
		this.parent = null
	}

	isRoot(): boolean {
		return this.path === '' || this.path === '/'
	}
}

export class WorkspaceLeaf {
	view: unknown

	constructor() {
		this.view = null
	}

	openFile(_file: TFile): Promise<void> {
		return Promise.resolve()
	}
	setViewState(_state: unknown): Promise<void> {
		return Promise.resolve()
	}
	detach(): void {}
}

export class ItemView extends Component {
	leaf: WorkspaceLeaf
	containerEl: StubElement
	contentEl: StubElement

	constructor(leaf?: WorkspaceLeaf) {
		super()
		this.leaf = leaf ?? new WorkspaceLeaf()
		this.containerEl = createStubEl()
		this.contentEl = createStubEl()
	}

	getViewType(): string {
		return ''
	}
	getDisplayText(): string {
		return ''
	}
	onOpen(): Promise<void> {
		return Promise.resolve()
	}
	onClose(): Promise<void> {
		return Promise.resolve()
	}
}

export class MarkdownView extends ItemView {
	file: TFile | null
	editor: unknown

	constructor(leaf?: WorkspaceLeaf) {
		super(leaf)
		this.file = null
		this.editor = null
	}

	getMode(): string {
		return 'source'
	}
}

export class MarkdownRenderer {
	static render(..._args: unknown[]): Promise<void> {
		return Promise.resolve()
	}
}

class MenuItem {
	setTitle(_title: string): this {
		return this
	}
	setIcon(_icon: string): this {
		return this
	}
	onClick(_callback: (event: unknown) => unknown): this {
		return this
	}
	setDisabled(_disabled: boolean): this {
		return this
	}
	setChecked(_checked: boolean): this {
		return this
	}
	setSection(_section: string): this {
		return this
	}
}

export class Menu {
	addItem(callback: (item: MenuItem) => unknown): this {
		callback(new MenuItem())
		return this
	}
	addSeparator(): this {
		return this
	}
	showAtMouseEvent(_event: unknown): this {
		return this
	}
	showAtPosition(_position: unknown): this {
		return this
	}
	hide(): void {}
}

export class PluginSettingTab {
	app: unknown
	plugin: unknown
	containerEl: StubElement

	constructor(app: unknown, plugin: unknown) {
		this.app = app
		this.plugin = plugin
		this.containerEl = createStubEl()
	}

	display(): void {}
	hide(): void {}
}

export class Plugin extends Component {
	app: unknown
	manifest: unknown
	private storedData: unknown = null

	constructor(app: unknown, manifest: unknown) {
		super()
		this.app = app
		this.manifest = manifest
	}

	async loadData(): Promise<unknown> {
		return this.storedData
	}
	async saveData(data: unknown): Promise<void> {
		this.storedData = data
	}
	addSettingTab(_tab: PluginSettingTab): void {}
	registerView(_type: string, _factory: unknown): void {}
	addCommand(_command: unknown): unknown {
		return _command
	}
	addRibbonIcon(
		_icon: string,
		_title: string,
		_callback: unknown,
	): StubElement {
		return createStubEl()
	}
	addStatusBarItem(): StubElement {
		return createStubEl()
	}
}

export function setIcon(_parent: unknown, _icon: string): void {}
export function addIcon(_name: string, _svg: string): void {}
