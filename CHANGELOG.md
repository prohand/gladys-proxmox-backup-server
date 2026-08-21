# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

### Added

- `CLAUDE.md` contributor guide.
- `CHANGELOG.md` and a Dependabot configuration for npm, Docker, and GitHub Actions.
- `npm run check:pbs`, a read-only diagnostic script reporting which inventory route each
  datastore uses and cross-checking it against the full snapshot list.
- Tests covering the integration lifecycle (`src/runtime.js`): poll throttling, re-discovery,
  retry after a failed refresh, and the startup backoff.

### Changed

- Snapshot count and backup freshness are read from the datastore backup groups instead of
  the full snapshot list, which avoids downloading megabytes of JSON on every refresh.
  The snapshot listing remains as a fallback, now logged as a warning instead of being silent.
- The task history is paged until the newest verify, garbage collection, and prune tasks are
  found, so they no longer fall out of a fixed 500-task window on a busy datastore.
- The startup connection is retried four times with an exponential backoff before the
  integration reports itself as disconnected.
- The lifecycle moved out of `index.js` into `src/runtime.js` with injectable dependencies.
- `normalizeConfig()` now keeps only the keys declared in the manifest.
- The Docker build uses `npm ci` alone, without an `npm install` fallback that would ignore
  the lockfile.
- `engines.node` is aligned with CI and the Docker image (Node 24), and `.nvmrc` was added.

### Fixed

- A datastore that is offline or unmounted no longer publishes `NaN` for usage, total size,
  and used space.
- Text features no longer carry the meaningless `min`/`max` numeric range.

### Removed

- The unused `taskSummary()` helper, replaced by `taskDetails()` when statuses and dates were
  split into separate features.

## [1.0.1]

- Configurable task date format, offered as a dropdown in the integration settings.

## [1.0.0]

- Initial release: read-only monitoring of PBS datastores, capacity, snapshot inventory,
  maintenance task status, and backup freshness.
