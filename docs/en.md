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
| Snapshot count                 | Integer    | Number of snapshots currently stored.                                      |
| Last verify status             | Text       | Latest verification status, for example `OK`.                              |
| Last verify date               | Text       | Latest verification date in ISO 8601 format.                               |
| Last garbage collection status | Text       | Latest garbage collection status, for example `OK`.                        |
| Last garbage collection date   | Text       | Latest garbage collection date in ISO 8601 format.                         |
| Last prune status              | Text       | Latest prune status, for example `OK`.                                     |
| Last prune date                | Text       | Latest prune date in ISO 8601 format.                                      |
| Backup stale (> 26 h)          | `0` or `1` | `1` when no snapshot exists or the newest snapshot is older than 26 hours. |
