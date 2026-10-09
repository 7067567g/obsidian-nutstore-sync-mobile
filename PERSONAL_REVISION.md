# Personal Revision Notice

This repository is a **personal modified version** of
[`nutstore/obsidian-nutstore-sync`](https://github.com/nutstore/obsidian-nutstore-sync).

- Base upstream commit: `79d35b4e8b47ac43d3531ceb888a722ee942dc5e`
- Personal revision date: `2026-10-10`
- Git branch: `main`
- Git tag: `personal-20261010`
- Current version: `1.5.5`
- License: GNU Affero General Public License v3.0 only, see `LICENSE`
- This personal revision remains licensed under AGPL-3.0. The original
  copyright and license notices are preserved.

## Why this revision exists

The upstream project is a general-purpose Obsidian sync plugin. This personal
revision was created for day-to-day use on a phone and adds/fixes:

- session storage cold-read durability and recovery;
- native vault tools (`vault_list`, `vault_read`, `vault_grep`,
  `vault_links`, `vault_frontmatter`, `vault_batch_edit`);
- whitelisted settings tools (`settings_read`, `settings_patch`);
- PDF page reading (`view_pdf`) with text-first extraction and image fallback;
- multiple labeled image attachments in the model loop;
- mobile-oriented tool routing and local build/install scripts.

## 1.5.4 changes (2026-10-09/10)

- session log torn-tail scanner and repair; atomic temp promotion on startup;
- per-tool `timeoutMs` / active wall-clock deadline, hidden-page time excluded;
- pre-persist guard for side-effect tools and `TOOL_OUTCOME_UNKNOWN` recovery;
- root `vault_grep` guard rails and execution budgets.

## 1.5.5 changes (2026-10-10)

- #94 checkpoint barrier: side-effect tool calls are persisted before the body; interrupted executions recover as `TOOL_OUTCOME_UNKNOWN` and are not auto-retried;
- #92 recovery: 0 B/stale atomic temp and backup artifacts are cleaned or restored on startup;
- #91 bounded output: head/tail retention plus spill files and locator metadata;
- #96 timeout/abort/heartbeat: active wall-clock budget, just-bash abort propagation, 2 s heartbeat metrics;
- #100 guard rails: regex complexity precheck, `vault_json` stat-before-read 20 MiB, image/PDF entry limits, Bash write/recursion budgets, `vault_stat` walk deadline;
- #97 capability probe fields in startup diagnostics;
- native tools registered (`vault_stat`, `vault_json`, `vault_hash`), settings whitelist extended with tool timeout;
- real-device smoke: 72 MB-class long session (first paint ~3 s, smooth scrolling), crash-point matrix r1–r10, external-write conflict.

## What this means for redistribution

AGPL-3.0 allows modification, personal use, and redistribution, including
network use, provided the license terms are followed:

- keep the AGPL license and all copyright/attribution notices;
- clearly mark modified files and modification dates;
- distribute the complete corresponding source code of the modified version
  under AGPL-3.0;
- if the modified version is offered to users over a network, provide them
  access to the corresponding source code.

Do not represent this personal revision as an official upstream release.
There is no warranty, as stated in the license.

## Build

This revision is installed on the author's phone as a local Obsidian plugin
build. Build and install scripts are included in the repository
(`构建与安装.sh`, `scripts/release-local.mjs`, `scripts/bootstrap-deps.mjs`).
