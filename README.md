# Proxmox Backup Server for Gladys

External Gladys Assistant integration for **read-only monitoring** of Proxmox Backup Server (PBS). It creates one Gladys device per datastore and reports capacity, snapshot inventory, maintenance-task status, and backup freshness.

## Monitored values

- datastore usage percentage, total size, and used space, rounded to two decimal places;
- snapshot count per datastore;
- last verify status and timestamp;
- separate status and timestamp features for the last garbage collection and prune tasks;
- binary `Backup stale` sensor, set to `1` when no snapshot exists or the newest snapshot is older than **26 hours**.

See [the English setup guide](docs/en.md) or [le guide en français](docs/fr.md) for the complete feature reference and the exact least-privilege ACL commands.

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
npm run format      # rewrite files with Prettier
```

Node 24 is required (see `.nvmrc`); it is the version CI and the Docker image use.

The structure, SDK bootstrap, manifest, Docker image, and CI/release workflows are based on Gladys Assistant's [official JavaScript integration template](https://github.com/GladysAssistant/integration-template-js).
