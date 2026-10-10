# Private Modifications Notice

This repository is the maintainer's **own private modifications build** based on
[`nutstore/obsidian-nutstore-sync`](https://github.com/nutstore/obsidian-nutstore-sync).

The current version is **1.5.5**; all differences from upstream in this repository
are the maintainer's private modifications, maintained as a single line of work.
The original upstream project is a general-purpose Obsidian sync plugin; this
repository is tuned for the maintainer's own daily mobile / Obsidian usage.

- Upstream base: `79d35b4e8b47ac43d3531ceb888a722ee942dc5e`
- Current version: `1.5.5`
- Build tag: `mobile-20261010`
- License: GNU Affero General Public License v3.0 only, see `LICENSE`
- The original copyright and license notices are preserved.

## What this repository contains

Private modifications include, but are not limited to:

- session storage cold-read durability and recovery;
- native vault tools (`vault_stat`, `vault_json`, `vault_hash`,
  `vault_batch_edit`, etc.);
- whitelisted settings tools (`settings_read`, `settings_patch`) including tool
  timeout;
- PDF page reading (`view_pdf`) with text-first extraction and image fallback;
- multiple labeled image attachments in the model loop;
- bounded tool output (head/tail + spill), session recovery safety, tool
  timeout/abort/heartbeat, regex/JSON/image/Bash guard rails;
- mobile-oriented tool routing and local build/install scripts.

## Redistribution

AGPL-3.0 allows modification, private use, and redistribution, including network
use, provided the license terms are followed:

- keep the AGPL license and all copyright/attribution notices;
- clearly mark modified files and modification dates;
- distribute the complete corresponding source code of this build under
  AGPL-3.0;
- if this build is offered to users over a network, provide them access to the
  corresponding source code.

Do not represent this build as an official upstream release. There is no
warranty, as stated in the license.

## Build

This repository is source-only. Build locally with:

```bash
node scripts/bootstrap-deps.mjs
node scripts/release-local.mjs
```

The build output is written to `release/nutstore-sync-<version>/`.
