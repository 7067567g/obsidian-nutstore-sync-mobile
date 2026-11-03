export const GLOBSTAR_CASES = [
	{
		name: 'leading globstar',
		path: 'logs',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '**/logs',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'leading globstar',
		path: 'work/logs',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '**/logs',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'leading globstar',
		path: '工作/历史/logs',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '**/logs',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'leading globstar',
		path: 'catalogs',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '**/logs',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'leading globstar',
		path: 'logs.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '**/logs',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'leading globstar',
		path: 'a/logs/b.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '**/logs',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'leading globstar',
		path: 'log',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '**/logs',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'leading globstar',
		path: 'a/b/logs',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '**/logs',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'middle globstar',
		path: 'a/b',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'a/**/b',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'middle globstar',
		path: 'a/x/b',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'a/**/b',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'middle globstar',
		path: 'a/x/y/b',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'a/**/b',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'middle globstar',
		path: 'x/a/b',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'a/**/b',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'middle globstar',
		path: 'a/中/b',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'a/**/b',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'middle globstar',
		path: 'a/b.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'a/**/b',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'middle globstar',
		path: 'a/x/b/c',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'a/**/b',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'middle globstar',
		path: 'ab',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'a/**/b',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'trailing globstar',
		path: 'archive',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'archive/**',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'trailing globstar',
		path: 'archive/a.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'archive/**',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'trailing globstar',
		path: 'archive/资料/条目.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'archive/**',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'trailing globstar',
		path: 'nested/archive/a.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'archive/**',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'trailing globstar',
		path: 'archive.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'archive/**',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'trailing globstar',
		path: 'archives/a.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'archive/**',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'trailing globstar',
		path: 'archive/.keep',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'archive/**',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'trailing globstar',
		path: 'archive/a/b/c.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'archive/**',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'non-segment double star',
		path: 'a/b/c',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'a/**b/c',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'non-segment double star',
		path: 'a/xxb/c',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'a/**b/c',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'non-segment double star',
		path: 'a/x/yb/c',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'a/**b/c',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'non-segment double star',
		path: 'a/中b/c',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'a/**b/c',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'non-segment double star',
		path: 'x/a/b/c',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'a/**b/c',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'non-segment double star',
		path: 'a/bb/c',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'a/**b/c',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'non-segment double star',
		path: 'a/x/c',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'a/**b/c',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'non-segment double star',
		path: 'a/b/c/d',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'a/**b/c',
				type: 'exclude',
			},
		],
		included: false,
	},
] as const
