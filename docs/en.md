# Proxmox Backup Server — setup

This integration only calls PBS API `GET` routes. It cannot start, alter, prune, or delete backups or jobs.

## Exact read-only permissions

Grant the built-in `DatastoreAudit` role (`Datastore.Audit`) on `/datastore`, and the built-in `Audit` role (`Sys.Audit`) on `/system` so the task history can be read. Do not grant any datastore write, backup, prune, verify, or admin role.

```bash
proxmox-backup-manager user create gladys@pbs --password 'A_LONG_UNIQUE_PASSWORD'
proxmox-backup-manager user generate-token gladys@pbs monitoring
proxmox-backup-manager acl update /datastore DatastoreAudit --auth-id gladys@pbs --propagate true
proxmox-backup-manager acl update /datastore DatastoreAudit --auth-id 'gladys@pbs!monitoring' --propagate true
proxmox-backup-manager acl update /system Audit --auth-id gladys@pbs --propagate true
proxmox-backup-manager acl update /system Audit --auth-id 'gladys@pbs!monitoring' --propagate true
```

PBS API tokens use separate ACL entries by design; `generate-token` does not accept a `--privsep` option. Effective token permissions are the intersection of the parent user's permissions and the token's own permissions, hence the matching ACLs. Replace `/datastore` with `/datastore/NAME` in both datastore commands to restrict monitoring to one store. Enter the full token ID and the one-time secret in Gladys. Keep TLS verification enabled unless the server uses a self-signed certificate on a trusted network.

The refresh interval defaults to 15 minutes. It cannot be set below 5 minutes to limit growth of the Gladys database, and it can be increased up to 24 hours.

The general `Date format` dropdown controls all task dates. It offers ISO 8601, day/month/year, year-month-day, and month/day/year formats. Dates are formatted in UTC.

> After changing and saving the date format, open the affected PBS device in Gladys and save it again to apply the change.

## Exposed features

Each PBS datastore is exposed as one Gladys device with these read-only features:

The three capacity values (`Usage`, `Total size`, and `Used space`) are mapped to the Gladys `data/size` capability while retaining their percent or gigabyte unit.

| Feature                        | Value      | Description                                                                |
| ------------------------------ | ---------- | -------------------------------------------------------------------------- |
| Usage                          | Percentage | Used datastore capacity, rounded to two decimal places.                    |
| Total size                     | Gigabytes  | Total datastore capacity, rounded to two decimal places.                   |
| Used space                     | Gigabytes  | Used datastore capacity, rounded to two decimal places.                    |
| Snapshot count                 | Integer    | Number of snapshots currently stored, summed over the backup groups.       |
| Last verify status             | Text       | Latest verification status, for example `OK`.                              |
| Last verify date               | Text       | Latest verification date, in the configured format.                        |
| Last garbage collection status | Text       | Latest garbage collection status, for example `OK`.                        |
| Last garbage collection date   | Text       | Latest garbage collection date, in the configured format.                  |
| Last prune status              | Text       | Latest prune status, for example `OK`.                                     |
| Last prune date                | Text       | Latest prune date, in the configured format.                               |
| Backup stale (> 26 h)          | `0` or `1` | `1` when no snapshot exists or the newest snapshot is older than 26 hours. |

## Behaviour notes

- Snapshot count and backup freshness are read from the datastore's backup groups (`backup-count` and `last-backup`), so a datastore holding thousands of snapshots costs one small response per refresh. If a PBS release does not expose those counters, the integration falls back to listing the snapshots.
- The task history is read page by page until the newest verify, garbage collection, and prune tasks have been found (up to 2000 tasks), so a busy datastore does not push them out of view and back to `Never run`.
- Datastores that are offline or unmounted report no capacity; the integration then publishes `0` for usage, total size, and used space rather than an invalid value.
- A refresh that fails (network error, timeout, PBS restart) is retried on the next one-minute Gladys tick instead of waiting a full refresh interval. At startup, the connection is retried four times with an exponential backoff before the integration reports itself as disconnected.

## Checking which inventory route is used

The integration prefers the cheap `groups` route and falls back to the full snapshot list; the fallback is logged as a warning in the container logs (`Falling back to the snapshot list for datastore ...`, with the PBS error that caused it).

To check it against your server without installing anything in Gladys, run the read-only diagnostic from a clone of this repository:

```bash
PBS_URL=https://pbs.example.com:8007 \
PBS_TOKEN_ID='gladys@pbs!monitoring' \
PBS_TOKEN_SECRET='the-token-secret' \
npm run check:pbs
```

It prints, per datastore, the route actually used, how long each route takes, and the last verify/GC/prune task. It also cross-checks the snapshot count and the newest backup against the full snapshot list, and exits with code `1` if the two disagree. Add `PBS_NODE=...` for a node other than `localhost`, and `PBS_VERIFY_TLS=false` for a self-signed certificate.

The same routes can be checked by hand:

```bash
curl -sSf -H "Authorization: PBSAPIToken=gladys@pbs!monitoring:SECRET" \
  'https://pbs.example.com:8007/api2/json/admin/datastore/NAME/groups' | head -c 400
```

An HTTP 403 means the ACL is missing `Datastore.Audit` on that datastore; an HTTP 404 means this PBS release does not serve the route and the snapshot fallback is expected.
