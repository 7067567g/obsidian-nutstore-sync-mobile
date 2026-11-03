export const BASIC_ENV_CASES = [
	{
		name: 'basename',
		path: 'draft.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'draft.md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'basename',
		path: 'notes/draft.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'draft.md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'basename',
		path: '草稿.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'draft.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'basename',
		path: 'draft.md.bak',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'draft.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'basename',
		path: 'DRAFT.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'draft.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'basename',
		path: 'a/b/draft.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'draft.md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'basename',
		path: 'draft-md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'draft.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'basename',
		path: '.draft.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'draft.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'dot names',
		path: '.draft',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '.*',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'dot names',
		path: 'notes/.draft',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '.*',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'dot names',
		path: '目录/.草稿',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '.*',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'dot names',
		path: 'draft',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '.*',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'dot names',
		path: 'a.draft',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '.*',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'dot names',
		path: '.config/settings.json',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '.*',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'dot names',
		path: '.gitignore',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '.*',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'dot names',
		path: 'notes/visible.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '.*',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'case-sensitive',
		path: 'Draft.MD',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'Draft*.MD',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'case-sensitive',
		path: 'DraftOne.MD',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'Draft*.MD',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'case-sensitive',
		path: 'draft.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'Draft*.MD',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'case-sensitive',
		path: 'DRAFT.MD',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'Draft*.MD',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'case-sensitive',
		path: 'notes/DraftTwo.MD',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'Draft*.MD',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'case-sensitive',
		path: 'DraftOne.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'Draft*.MD',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'case-sensitive',
		path: '草稿.MD',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'Draft*.MD',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'case-sensitive',
		path: 'Draft.MD.bak',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'Draft*.MD',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'case-insensitive',
		path: 'Draft.MD',
		isDir: false,
		caseSensitive: false,
		rules: [
			{
				expr: 'Draft*.MD',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'case-insensitive',
		path: 'DraftOne.MD',
		isDir: false,
		caseSensitive: false,
		rules: [
			{
				expr: 'Draft*.MD',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'case-insensitive',
		path: 'draft.md',
		isDir: false,
		caseSensitive: false,
		rules: [
			{
				expr: 'Draft*.MD',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'case-insensitive',
		path: 'DRAFT.MD',
		isDir: false,
		caseSensitive: false,
		rules: [
			{
				expr: 'Draft*.MD',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'case-insensitive',
		path: 'notes/drafttwo.md',
		isDir: false,
		caseSensitive: false,
		rules: [
			{
				expr: 'Draft*.MD',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'case-insensitive',
		path: 'DraftOne.md',
		isDir: false,
		caseSensitive: false,
		rules: [
			{
				expr: 'Draft*.MD',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'case-insensitive',
		path: '草稿.MD',
		isDir: false,
		caseSensitive: false,
		rules: [
			{
				expr: 'Draft*.MD',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'case-insensitive',
		path: 'Draft.MD.bak',
		isDir: false,
		caseSensitive: false,
		rules: [
			{
				expr: 'Draft*.MD',
				type: 'exclude',
			},
		],
		included: true,
	},
] as const
