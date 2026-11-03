export const REINCLUSION_CASES = [
	{
		name: 'parent reinclusion',
		path: 'docs',
		isDir: true,
		caseSensitive: true,
		rules: [
			{
				expr: '/*',
				type: 'exclude',
			},
			{
				expr: '/docs',
				type: 'include',
			},
			{
				expr: '/docs/**',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'parent reinclusion',
		path: 'docs/guide.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/*',
				type: 'exclude',
			},
			{
				expr: '/docs',
				type: 'include',
			},
			{
				expr: '/docs/**',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'parent reinclusion',
		path: 'docs/指南.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/*',
				type: 'exclude',
			},
			{
				expr: '/docs',
				type: 'include',
			},
			{
				expr: '/docs/**',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'parent reinclusion',
		path: 'other/file.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/*',
				type: 'exclude',
			},
			{
				expr: '/docs',
				type: 'include',
			},
			{
				expr: '/docs/**',
				type: 'include',
			},
		],
		included: false,
	},
	{
		name: 'parent reinclusion',
		path: 'other',
		isDir: true,
		caseSensitive: true,
		rules: [
			{
				expr: '/*',
				type: 'exclude',
			},
			{
				expr: '/docs',
				type: 'include',
			},
			{
				expr: '/docs/**',
				type: 'include',
			},
		],
		included: false,
	},
	{
		name: 'parent reinclusion',
		path: 'docs/deep/a.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/*',
				type: 'exclude',
			},
			{
				expr: '/docs',
				type: 'include',
			},
			{
				expr: '/docs/**',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'parent reinclusion',
		path: 'readme.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/*',
				type: 'exclude',
			},
			{
				expr: '/docs',
				type: 'include',
			},
			{
				expr: '/docs/**',
				type: 'include',
			},
		],
		included: false,
	},
	{
		name: 'parent reinclusion',
		path: '资料/说明.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '/*',
				type: 'exclude',
			},
			{
				expr: '/docs',
				type: 'include',
			},
			{
				expr: '/docs/**',
				type: 'include',
			},
		],
		included: false,
	},
	{
		name: 'nested exclusion after reinclusion',
		path: 'workspace/note.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'workspace/',
				type: 'exclude',
			},
			{
				expr: 'workspace',
				type: 'include',
			},
			{
				expr: 'workspace/**',
				type: 'include',
			},
			{
				expr: 'workspace/generated/',
				type: 'exclude',
			},
			{
				expr: 'workspace/generated',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'nested exclusion after reinclusion',
		path: 'workspace/笔记.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'workspace/',
				type: 'exclude',
			},
			{
				expr: 'workspace',
				type: 'include',
			},
			{
				expr: 'workspace/**',
				type: 'include',
			},
			{
				expr: 'workspace/generated/',
				type: 'exclude',
			},
			{
				expr: 'workspace/generated',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'nested exclusion after reinclusion',
		path: 'workspace/generated/other.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'workspace/',
				type: 'exclude',
			},
			{
				expr: 'workspace',
				type: 'include',
			},
			{
				expr: 'workspace/**',
				type: 'include',
			},
			{
				expr: 'workspace/generated/',
				type: 'exclude',
			},
			{
				expr: 'workspace/generated',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'nested exclusion after reinclusion',
		path: 'workspace/generated',
		isDir: true,
		caseSensitive: true,
		rules: [
			{
				expr: 'workspace/',
				type: 'exclude',
			},
			{
				expr: 'workspace',
				type: 'include',
			},
			{
				expr: 'workspace/**',
				type: 'include',
			},
			{
				expr: 'workspace/generated/',
				type: 'exclude',
			},
			{
				expr: 'workspace/generated',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'nested exclusion after reinclusion',
		path: 'other/note.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'workspace/',
				type: 'exclude',
			},
			{
				expr: 'workspace',
				type: 'include',
			},
			{
				expr: 'workspace/**',
				type: 'include',
			},
			{
				expr: 'workspace/generated/',
				type: 'exclude',
			},
			{
				expr: 'workspace/generated',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'nested exclusion after reinclusion',
		path: 'workspace/generated/deep/a.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'workspace/',
				type: 'exclude',
			},
			{
				expr: 'workspace',
				type: 'include',
			},
			{
				expr: 'workspace/**',
				type: 'include',
			},
			{
				expr: 'workspace/generated/',
				type: 'exclude',
			},
			{
				expr: 'workspace/generated',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'nested exclusion after reinclusion',
		path: 'workspace.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'workspace/',
				type: 'exclude',
			},
			{
				expr: 'workspace',
				type: 'include',
			},
			{
				expr: 'workspace/**',
				type: 'include',
			},
			{
				expr: 'workspace/generated/',
				type: 'exclude',
			},
			{
				expr: 'workspace/generated',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'nested exclusion after reinclusion',
		path: '工作区/笔记.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'workspace/',
				type: 'exclude',
			},
			{
				expr: 'workspace',
				type: 'include',
			},
			{
				expr: 'workspace/**',
				type: 'include',
			},
			{
				expr: 'workspace/generated/',
				type: 'exclude',
			},
			{
				expr: 'workspace/generated',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'leaf reinclusion',
		path: 'keep.tmp',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '*.tmp',
				type: 'exclude',
			},
			{
				expr: 'keep.tmp',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'leaf reinclusion',
		path: 'notes/keep.tmp',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '*.tmp',
				type: 'exclude',
			},
			{
				expr: 'keep.tmp',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'leaf reinclusion',
		path: 'drop.tmp',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '*.tmp',
				type: 'exclude',
			},
			{
				expr: 'keep.tmp',
				type: 'include',
			},
		],
		included: false,
	},
	{
		name: 'leaf reinclusion',
		path: 'notes/drop.tmp',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '*.tmp',
				type: 'exclude',
			},
			{
				expr: 'keep.tmp',
				type: 'include',
			},
		],
		included: false,
	},
	{
		name: 'leaf reinclusion',
		path: '保留.tmp',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '*.tmp',
				type: 'exclude',
			},
			{
				expr: 'keep.tmp',
				type: 'include',
			},
		],
		included: false,
	},
	{
		name: 'leaf reinclusion',
		path: 'keep.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '*.tmp',
				type: 'exclude',
			},
			{
				expr: 'keep.tmp',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'leaf reinclusion',
		path: 'a/keep.tmp/b',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '*.tmp',
				type: 'exclude',
			},
			{
				expr: 'keep.tmp',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'leaf reinclusion',
		path: '.keep.tmp',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '*.tmp',
				type: 'exclude',
			},
			{
				expr: 'keep.tmp',
				type: 'include',
			},
		],
		included: false,
	},
	{
		name: 'excluded parent pruning',
		path: 'private',
		isDir: true,
		caseSensitive: true,
		rules: [
			{
				expr: 'private/',
				type: 'exclude',
			},
			{
				expr: 'private/readme.md',
				type: 'include',
			},
		],
		included: false,
	},
	{
		name: 'excluded parent pruning',
		path: 'private/readme.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'private/',
				type: 'exclude',
			},
			{
				expr: 'private/readme.md',
				type: 'include',
			},
		],
		included: false,
	},
	{
		name: 'excluded parent pruning',
		path: 'private/说明.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'private/',
				type: 'exclude',
			},
			{
				expr: 'private/readme.md',
				type: 'include',
			},
		],
		included: false,
	},
	{
		name: 'excluded parent pruning',
		path: 'public/readme.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'private/',
				type: 'exclude',
			},
			{
				expr: 'private/readme.md',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'excluded parent pruning',
		path: 'nested/private/readme.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'private/',
				type: 'exclude',
			},
			{
				expr: 'private/readme.md',
				type: 'include',
			},
		],
		included: false,
	},
	{
		name: 'excluded parent pruning',
		path: 'private.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'private/',
				type: 'exclude',
			},
			{
				expr: 'private/readme.md',
				type: 'include',
			},
		],
		included: true,
	},
	{
		name: 'excluded parent pruning',
		path: 'private/deep/a.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'private/',
				type: 'exclude',
			},
			{
				expr: 'private/readme.md',
				type: 'include',
			},
		],
		included: false,
	},
	{
		name: 'excluded parent pruning',
		path: '公开/说明.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'private/',
				type: 'exclude',
			},
			{
				expr: 'private/readme.md',
				type: 'include',
			},
		],
		included: true,
	},
] as const
