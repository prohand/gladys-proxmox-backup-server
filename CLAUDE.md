# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

An **external Gladys Assistant integration** that monitors a Proxmox Backup Server (PBS)
in **read-only** mode. It runs as a standalone Node.js process in a Docker container,
connects to Gladys through `@gladysassistant/integration-sdk`, and exposes one Gladys
device per PBS datastore.

Hard constraint: **only `GET` calls to the PBS API**. Never add a route or feature that
starts, alters, prunes, verifies, or deletes anything on PBS. The documented ACL is
`DatastoreAudit` + `Audit`; any new API call must work under those roles alone.

## Commands

```bash
npm install
npm test            # node --test (built-in runner, no framework)
npm run lint        # eslint .
npm run format      # prettier --write .
npm run format:check
npm start           # node index.js — needs a reachable Gladys instance
```

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, then `test` on Node 24.
Run all three locally before pushing; formatting is a hard CI gate.

## Layout

| Path                                | Role                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.js`                          | SDK bootstrap and lifecycle: `onScanRequest`, `onPoll`, `onAction`, `onConfigUpdated`, `connected`. Holds the mutable `config` and the two in-memory maps.   |
| `src/config.js`                     | `normalizeConfig()` — coerces raw manifest config, clamps `poll_frequency` to 300…86400 s.                                                                   |
| `src/proxmox.js`                    | `ProxmoxClient` (raw `node:http`/`node:https`, no HTTP dependency) plus pure helpers: `formatTaskDate`, `taskDetails`, `taskSummary`, `newestSnapshotEpoch`. |
| `src/datastores.js`                 | Device/feature definitions (`buildDatastoreDevice`), state mapping (`buildDatastoreStates`), polling gate (`isPollDue`), orchestration (`readDatastore`).    |
| `gladys-assistant-integration.json` | Manifest: version, `docker_image`, bilingual `config_schema`, actions. Version and image tag are bumped **only** by `release.yml`.                           |
| `docs/en.md`, `docs/fr.md`          | User-facing setup guides — kept in sync, both languages.                                                                                                     |
| `test/`                             | One `*.test.js` per source file, plus `manifest.test.js` which asserts manifest invariants.                                                                  |

## Conventions

- ESM only (`"type": "module"`), Node 24 (`.nvmrc`, `engines`, CI, and the Docker image all agree), no transpilation, no bundler.
- **Zero runtime dependencies** beyond the Gladys SDK. Do not add an HTTP client, a date
  library, or a test framework — `node:http`, manual token formatting, and `node:test`
  are deliberate choices.
- Prettier owns formatting (100 cols, single quotes, trailing commas); ESLint only catches
  real mistakes. Never fight Prettier with manual wrapping.
- Everything user-visible is bilingual **en + fr**: manifest labels/descriptions, action
  results, connection-status messages, and the two docs files. A change that touches one
  language must touch the other.
- Business logic lives in pure, exported functions taking explicit `now`/`dateFormat`
  arguments, and `createRuntime()` takes its I/O as injected dependencies, so tests need
  neither a clock, a network, nor a Gladys instance. Keep `index.js` thin.
- Task dates are formatted in **UTC** — both `formatTaskDate` branches use `getUTC*`.

## Reading PBS efficiently

`readInventory()` prefers `/admin/datastore/{store}/groups` (`backup-count` + `last-backup`)
over listing every snapshot, and falls back to the snapshot list only when those counters are
missing. `fetchTasks()` pages the task history until the newest verify, GC, and prune tasks
have been seen (`TASK_MAX_PAGES` × `TASK_PAGE_SIZE`). Keep both cheap: a refresh runs for
every datastore, forever.

## Polling model

Gladys only accepts a device `poll_frequency` of 60 s (`GLADYS_POLL_FREQUENCY_MS`), so the
device is polled every minute and `isPollDue()` throttles the actual PBS calls down to the
user-configured `poll_frequency`. The timestamp is written _before_ the request and deleted
on failure so an error retries on the next tick. The 300 s floor exists to limit growth of
the Gladys state database — do not lower it.

`datastoreByExternalId` is rebuilt by `discover()`; an unknown `external_id` during a poll
triggers one re-discovery before giving up. `start()` retries the initial connection with an
exponential backoff before reporting a disconnected status.

## Release

Add user-visible changes to `CHANGELOG.md` under `## [Unreleased]`. Never bump the version by hand. Use **Actions → Release → Run workflow** (patch/minor/major):
it bumps `package.json`, `package-lock.json`, and both `version` and `docker_image` in the
manifest, tags `vX.Y.Z`, then calls `build.yml` to publish the multi-arch ghcr.io image.

## Docker

Rootfs is read-only in the Gladys sandbox; `/data` is the only writable volume and the
process runs as a non-root user. Never write outside `/data`. The image copies `index.js`,
`src/`, and the manifest only — add any new runtime file to the Dockerfile `COPY` list.

## When changing features

Adding or renaming a device feature changes its `external_id`, which Gladys treats as a new
feature (the old one lingers on existing installs). Prefer adding to renaming, and update in
the same change: `buildDatastoreDevice`, `buildDatastoreStates`, both docs tables, the README
feature list, and `test/datastores.test.js`.
