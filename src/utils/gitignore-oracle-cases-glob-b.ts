export const GLOB_OP_CASES_B = [
	{
		name: 'range',
		path: 'part0.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'part[0-9].md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'range',
		path: 'part9.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'part[0-9].md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'range',
		path: 'partA.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'part[0-9].md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'range',
		path: 'part10.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'part[0-9].md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'range',
		path: 'notes/part5.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'part[0-9].md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'range',
		path: 'part-.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'part[0-9].md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'range',
		path: 'part5.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'part[0-9].md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'range',
		path: '章节5.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'part[0-9].md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'negated range',
		path: 'partA.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'part[!0-9].md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'negated range',
		path: 'part-.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'part[!0-9].md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'negated range',
		path: 'part5.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'part[!0-9].md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'negated range',
		path: 'part10.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'part[!0-9].md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'negated range',
		path: 'notes/partZ.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'part[!0-9].md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'negated range',
		path: 'part_.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'part[!0-9].md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'negated range',
		path: 'part.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'part[!0-9].md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'negated range',
		path: '章节A.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'part[!0-9].md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'posix digit class',
		path: 'item-0.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'item-[[:digit:]].txt',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'posix digit class',
		path: 'item-9.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'item-[[:digit:]].txt',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'posix digit class',
		path: 'item-a.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'item-[[:digit:]].txt',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'posix digit class',
		path: 'item-10.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'item-[[:digit:]].txt',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'posix digit class',
		path: 'notes/item-5.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'item-[[:digit:]].txt',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'posix digit class',
		path: 'item--.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'item-[[:digit:]].txt',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'posix digit class',
		path: 'item-5.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'item-[[:digit:]].txt',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'posix digit class',
		path: '项目-5.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'item-[[:digit:]].txt',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'literal braces',
		path: 'report.{md,txt}',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'report.{md,txt}',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'literal braces',
		path: 'report.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'report.{md,txt}',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'literal braces',
		path: 'report.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'report.{md,txt}',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'literal braces',
		path: 'notes/report.{md,txt}',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'report.{md,txt}',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'literal braces',
		path: '报告.{md,txt}',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'report.{md,txt}',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'literal braces',
		path: 'report.csv',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'report.{md,txt}',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'literal braces',
		path: 'report.{md}',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'report.{md,txt}',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'literal braces',
		path: 'reportmdtxt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: 'report.{md,txt}',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'literal Chinese with star',
		path: '草稿.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '草稿*.md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'literal Chinese with star',
		path: '草稿一.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '草稿*.md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'literal Chinese with star',
		path: '笔记/草稿二.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '草稿*.md',
				type: 'exclude',
			},
		],
		included: false,
	},
	{
		name: 'literal Chinese with star',
		path: '草稿.txt',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '草稿*.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'literal Chinese with star',
		path: '正式稿.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '草稿*.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'literal Chinese with star',
		path: 'draft.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '草稿*.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'literal Chinese with star',
		path: '草稿/说明.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '草稿*.md',
				type: 'exclude',
			},
		],
		included: true,
	},
	{
		name: 'literal Chinese with star',
		path: '.草稿.md',
		isDir: false,
		caseSensitive: true,
		rules: [
			{
				expr: '草稿*.md',
				type: 'exclude',
			},
		],
		included: true,
	},
] as const
