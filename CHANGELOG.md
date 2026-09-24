# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

### Changed

- Widgets: three tiles per card so no tile sits alone on a row; usage shown as a whole
  percent; sizes shown in GB or TB with the local decimal separator. `PBS datastore` shows
  the free space as a tile and used / total space as a status row; `PBS backups` drops the
  datastore count tile (the status rows list every datastore) and shortens its French labels.
- `PBS datastore` widget: verify, garbage collection, and prune are shown as cards (name,
  date formatted by Gladys, colored result badge such as `Réussie`) in place of the 30-day
  usage chart, since a widget holds a single chart or card list.

### Fixed

- `Time zone` setting (IANA name, for example `Europe/Paris`): task and backup dates were
  always shown in UTC, two hours behind in French summer time. Defaults to `UTC`.
- The Release workflow runs Prettier on the manifest after `jq`, so the release commit no
  longer fails the CI format check.

### Added

- Gladys 5.1 dashboard widgets: `PBS datastore` (one datastore in detail, with a live usage
  gauge and a 30-day chart) and `PBS backups` (every datastore on one card), each with a
  `Refresh` button that reads PBS again.
- Gladys 5.1 scene triggers, fired once per change: maintenance task finished (filter on
  datastore, task type, and result), new backup, backup stale, PBS unreachable, and PBS
  reachable again.
- Gladys 5.1 scene actions: get a datastore status (usage, snapshots, last tasks) and get a
  backup report with counters and a ready-to-send text in English or French.

- `CLAUDE.md` contributor guide.
- `CHANGELOG.md` and a Dependabot configuration for npm, Docker, and GitHub Actions.
- `npm run check:pbs`, a read-only diagnostic script reporting which inventory route each
  datastore uses and cross-checking it against the full snapshot list.
- Tests covering the integration lifecycle (`src/runtime.js`): poll throttling, re-discovery,
  retry after a failed refresh, and the startup backoff.

### Changed

- Requires Gladys 5.1.0 or later (`gladys_version`), and the integration SDK 0.14.

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
- Text features publish a `min`/`max` range again: Gladys stores those columns as NOT NULL
  and compares them to detect a structure change, so publishing them empty left the
  "Update" button of the Discovery screen showing forever on an already-added datastore.

### Removed

- The unused `taskSummary()` helper, replaced by `taskDetails()` when statuses and dates were
  split into separate features.

## [1.0.1]

- Configurable task date format, offered as a dropdown in the integration settings.

## [1.0.0]

- Initial release: read-only monitoring of PBS datastores, capacity, snapshot inventory,
  maintenance task status, and backup freshness.
