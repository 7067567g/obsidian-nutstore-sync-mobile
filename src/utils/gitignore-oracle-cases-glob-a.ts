export const GLOB_OP_CASES_A = [
	{
		name: 'single star',
		path: 'a.tmp',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '*.tmp',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'single star',
		path: 'notes/a.tmp',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '*.tmp',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'single star',
		path: '笔记/草稿.tmp',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '*.tmp',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'single star',
		path: 'a.tmp.bak',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '*.tmp',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'single star',
		path: '.tmp',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '*.tmp',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'single star',
		path: 'a.TMP',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '*.tmp',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'single star',
		path: 'tmp',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '*.tmp',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'single star',
		path: 'deep/a.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '*.tmp',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'ordinary repeated stars',
		path: 'abcd',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'ab**cd',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'ordinary repeated stars',
		path: 'abXXcd',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'ab**cd',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'ordinary repeated stars',
		path: 'notes/abXXcd',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'ab**cd',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'ordinary repeated stars',
		path: 'ab/x/cd',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'ab**cd',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'ordinary repeated stars',
		path: 'ab中cd',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'ab**cd',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'ordinary repeated stars',
		path: 'abXXcd.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'ab**cd',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'ordinary repeated stars',
		path: 'aXXcd',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'ab**cd',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'ordinary repeated stars',
		path: 'abccd',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'ab**cd',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'escaped star',
		path: 'version*.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'version\\*.md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'escaped star',
		path: 'version1.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'version\\*.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'escaped star',
		path: 'notes/version*.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'version\\*.md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'escaped star',
		path: '版本*.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'version\\*.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'escaped star',
		path: 'version.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'version\\*.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'escaped star',
		path: 'version**.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'version\\*.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'escaped star',
		path: 'version*.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'version\\*.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'escaped star',
		path: '*version.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'version\\*.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'question mark',
		path: 'result1.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'result?.txt',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'question mark',
		path: 'resultA.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'result?.txt',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'question mark',
		path: 'result12.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'result?.txt',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'question mark',
		path: 'result.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'result?.txt',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'question mark',
		path: 'src/result1.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'result?.txt',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'question mark',
		path: 'result-.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'result?.txt',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'question mark',
		path: 'result1.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'result?.txt',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'question mark',
		path: '.result1.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'result?.txt',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'escaped question',
		path: 'name?.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'name\\?.txt',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'escaped question',
		path: 'name1.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'name\\?.txt',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'escaped question',
		path: 'notes/name?.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'name\\?.txt',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'escaped question',
		path: '名称?.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'name\\?.txt',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'escaped question',
		path: 'nameA.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'name\\?.txt',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'escaped question',
		path: 'name??.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'name\\?.txt',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'escaped question',
		path: 'name.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'name\\?.txt',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'escaped question',
		path: 'name?.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'name\\?.txt',
				type: 'exclude',
			},
		],
		included: true,
	},
] as const
