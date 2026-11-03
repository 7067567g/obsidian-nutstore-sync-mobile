export const PATH_ANCHOR_CASES = [
	{
		name: 'root anchor',
		path: 'draft.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/draft.md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'root anchor',
		path: 'notes/draft.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/draft.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'root anchor',
		path: '草稿/draft.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/draft.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'root anchor',
		path: 'DRAFT.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/draft.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'root anchor',
		path: 'draft.md.bak',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/draft.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'root anchor',
		path: 'a/draft.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/draft.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'root anchor',
		path: 'draft-md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/draft.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'root anchor',
		path: '.draft.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/draft.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'root directory',
		path: 'vendor',
		isDir: true,
		caseSensitive: true,
		rules: [
			{
				expr: '/vendor/',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'root directory',
		path: 'vendor',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/vendor/',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'root directory',
		path: 'vendor/a.js',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/vendor/',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'root directory',
		path: 'src/vendor/a.js',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/vendor/',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'root directory',
		path: 'src/vendor',
		isDir: true,
		caseSensitive: true,
		rules: [
			{
				expr: '/vendor/',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'root directory',
		path: 'vendors/a.js',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/vendor/',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'root directory',
		path: 'vendor.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/vendor/',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'root directory',
		path: '供应商/a.js',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/vendor/',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'slash relative',
		path: 'docs/a.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'docs/*.md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'slash relative',
		path: 'docs/说明.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'docs/*.md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'slash relative',
		path: 'docs/a.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'docs/*.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'slash relative',
		path: 'docs/deep/a.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'docs/*.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'slash relative',
		path: 'archive/docs/a.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'docs/*.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'slash relative',
		path: 'documentation/a.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'docs/*.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'slash relative',
		path: 'docs/.draft.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'docs/*.md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'slash relative',
		path: 'docs/a.md.bak',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'docs/*.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'directory only',
		path: 'cache',
		isDir: true,
		caseSensitive: true,
		rules: [
			{
				expr: 'cache/',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'directory only',
		path: 'cache',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'cache/',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'directory only',
		path: 'cache/item.json',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'cache/',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'directory only',
		path: 'src/cache/item.json',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'cache/',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'directory only',
		path: 'src/cache',
		isDir: true,
		caseSensitive: true,
		rules: [
			{
				expr: 'cache/',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'directory only',
		path: 'cached/item.json',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'cache/',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'directory only',
		path: '资料/cache/条目.json',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'cache/',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'directory only',
		path: 'cache.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'cache/',
				type: 'exclude',
			},
		],
		included: true,
	},
] as const
