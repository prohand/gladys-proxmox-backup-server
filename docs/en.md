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
