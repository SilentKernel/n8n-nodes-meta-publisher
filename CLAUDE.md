# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An n8n community node package that publishes to Instagram, Facebook Pages, and Threads (images, videos, reels, stories, carousels) via the Meta Graph API. Source is TypeScript in `nodes/` and `credentials/`; the package ships the compiled `dist/` only.

## Commands

This package uses **`@n8n/node-cli`** (`n8n-node …`) for its toolchain — not a hand-rolled tsc/gulp setup.

```bash
npm run build      # n8n-node build (compiles TS to dist/ + copies icons)
npm run dev        # n8n-node dev (runs the node in a local n8n)
npm run lint       # n8n-node lint (eslint via eslint.config.mjs)
npm run lint:fix   # n8n-node lint --fix
npm test           # n8n-node build + node --test "test/**/*.test.js"
npm run release    # n8n-node release (release-it: bump, commit, tag, push → CI publishes)
```

Requires **Node 22 LTS** (the `@n8n/node-cli` dep `isolated-vm` resolves a prebuilt binary on Node 22; newer Node may try to compile it and fail locally). Lockfile is **npm** (`package-lock.json`).

**Cloud support is disabled** (`n8n.strict: false` in package.json). `eslint.config.mjs` uses `configWithoutCloudSupport` and turns off the strict rules the upstream code doesn't satisfy (pervasive `any`, `no-console`, missing `pairedItem`/`usableAsTool`, identical light/dark icons, credential icon/test). The package is installable as a community node but is **not** eligible for n8n Cloud verification. Re-enable rules in `eslint.config.mjs` if the nodes are brought up to standard.

### CI / release
- `.github/workflows/ci.yml` — on PRs and pushes to `main`: `npm ci` → lint → build → `node --test`.
- `.github/workflows/publish.yml` — on a version tag (`*.*.*`): `npm run release`, which in CI runs lint → build → `npm publish` with provenance. Cut a release with `npm run release` locally (needs a clean `main` with an upstream); it bumps/commits/tags/pushes and the tag triggers the publish workflow.

### Testing
`test/fb-multi-photo.test.js` (Node's built-in `node:test`) runs against the compiled `dist/` with a mocked Graph client. For manual checks, point an n8n instance at the package via `npm link` / community-node install.

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
