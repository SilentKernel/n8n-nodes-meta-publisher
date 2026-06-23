# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An n8n community node package that publishes to Instagram, Facebook Pages, and Threads (images, videos, reels, stories, carousels) via the Meta Graph API. Source is TypeScript in `nodes/` and `credentials/`; the package ships the compiled `dist/` only.

## Commands

```bash
npm run build      # rimraf dist + tsc + gulp build:icons (copies .svg/.png into dist)
npm run dev        # tsc --watch
npm run lint       # eslint nodes credentials package.json (uses eslint-plugin-n8n-nodes-base)
npm run lintfix    # eslint --fix
npm run format     # prettier --write on nodes + credentials
```

There is no test runner. Validation is **build + lint**. `prepublishOnly` re-runs build then lint with the stricter `.eslintrc.prepublish.js`. Requires Node >= 20.15. Lockfile is pnpm (`pnpm-lock.yaml`).

### Testing locally
Run `npm run build`, then point an n8n instance at the package via `npm link` / community-node install, and exercise the node in a workflow. There is no automated test harness.

## Architecture

Four nodes registered in `package.json`'s `n8n` block, all sharing the same icon and the constants/ops in `nodes/MetaPublisher/lib/`:

- **MetaPublisher** (`MetaPublisher.node.ts`) — the only node that actually calls Meta. ~960-line `description` defines the UI; `execute()` is thin.
- **MetaPublisherJsonGenerator** — builds Meta Publisher **job JSON** from UI fields; emits payloads, does not call Meta.
- **MetaPublisherUtils** — **deprecated** predecessor of the JSON Generator (carries a "Deprecated Notice"). Prefer JsonGenerator for new work.
- **MetaPublisherBinaryUpload** — placeholder/preview node, no `execute()`, just a notice.

Facebook **Multi-Photo** (`publishFbMultiPhoto`) uploads each photo unpublished to `/{page}/photos` then creates one `/{page}/feed` post with `attached_media`; see `OPS.publishFbMultiPhoto` + `fbPublishMultiPhoto`.

### The "job" abstraction (central concept)
MetaPublisher accepts two **Input Source** modes (`inputSource` param):
- `fields` — read each value with `getNodeParameter`.
- `json` — read a job object (or array of jobs) from an item path (`jsonProp`, e.g. `$json` or `data.post`).

Both paths converge in `runJob(i, job)` inside `execute()`. Every value resolves as `job.X ?? getNodeParameter('X', i, default)` — i.e. a JSON job field always overrides the UI field. `runJob` switches on `job.resource` → `job.operation` and dispatches to a method on the **`OPS`** object.

### OPS layer (`lib/ops.ts`)
`OPS` is a flat map of operation methods (`publishImage`, `publishReel`, `publishFbVideo`, `threadsPublishCarousel`, …) keyed by the operation constants in `lib/constant.ts`. Each method orchestrates the Meta **create → poll → publish** flow and returns a `PublishResult` (see `lib/types.ts`). Per-platform Graph API calls live in `lib/ig.ts`, `lib/fb.ts`, `lib/threads.ts`.

### Supporting libs
- `lib/client.ts` — `apiRequest()`: single Graph entry point (`GRAPH_VERSION`/`GRAPH_BASE` here, currently `v23.0`). Pulls the `metaGraphApi` credential and appends `access_token` to the query string. Heavily `console.log`s requests/responses for debugging.
- `lib/poll.ts` — `pollUntil({ check, isDone, intervalMs, maxMs })` generic poller used while Meta processes media.
- `lib/utils.ts` — `sleep`, `jitter` (adds 0–300ms), `retry` (exponential backoff).
- `lib/constant.ts` — operation/resource string constants. **Source of truth** shared by MetaPublisher, JsonGenerator, and Utils so their option values stay in sync.
- `lib/types.ts` — `Platform`, `PublishResult`, `CarouselItem`, status unions.

### Credential
Single credential `metaGraphApi` (`credentials/MetaGraphApi.credentials.ts`): one Access Token field (prefer long-lived). Used by `apiRequest` via query-string `access_token`.

## Conventions when editing

- Adding/renaming an operation means touching **constant.ts**, the **MetaPublisher** UI + `runJob` switch, the **OPS** method, the platform lib, **and** the JsonGenerator (and likely Utils) so the option lists match. Keep operation `value`s identical across nodes — they are the dispatch keys.
- n8n UI fields are governed by strict `eslint-plugin-n8n-nodes-base` rules (description casing, trailing periods, default-value correctness, alphabetized options, etc.). Run `npm run lint` after editing any node `description`.
- Carousel user tags and similar UI collections arrive as `{ tag: [...] }`; `runJob` normalizes via `Array.isArray(rawTags?.tag) ? rawTags.tag : []` before passing to OPS.
- Polling/timeout: `pollSec` (default 2) and `maxWaitSec` (default 300) are overridable per job. IG publish/permalink steps are wrapped in try/catch so a late error doesn't fail an already-published post.
