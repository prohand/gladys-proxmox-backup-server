# Proxmox Backup Server — configuration

Cette intégration interroge uniquement les routes `GET` de l'API PBS. Elle ne lance, ne modifie et ne supprime aucun backup ou job.

## Droits exacts (lecture seule)

Le rôle intégré **`DatastoreAudit`** contient `Datastore.Audit` : métriques, configuration et liste du contenu, sans accès aux données sauvegardées. Le rôle intégré **`Audit`** sur `/system` fournit `Sys.Audit`, nécessaire pour lire l'historique des tâches du nœud. N'accordez surtout pas `DatastoreAdmin`, `DatastoreBackup`, `DatastorePowerUser`, `Datastore.Prune`, `Datastore.Modify` ou `Datastore.Verify`.

Sur PBS, exécutez en tant que `root` (remplacez le mot de passe et conservez le secret affiché par `generate-token`) :

```bash
proxmox-backup-manager user create gladys@pbs --password 'UN_MOT_DE_PASSE_LONG_ET_UNIQUE'
proxmox-backup-manager user generate-token gladys@pbs monitoring
proxmox-backup-manager acl update /datastore DatastoreAudit --auth-id gladys@pbs --propagate true
proxmox-backup-manager acl update /datastore DatastoreAudit --auth-id 'gladys@pbs!monitoring' --propagate true
proxmox-backup-manager acl update /system Audit --auth-id gladys@pbs --propagate true
proxmox-backup-manager acl update /system Audit --auth-id 'gladys@pbs!monitoring' --propagate true
```

La séparation des privilèges des jetons API est native dans PBS : `generate-token` n'accepte pas d'option `--privsep`. PBS utilise l'intersection des ACL de l'utilisateur et du jeton. Ces quatre ACL identiques sont donc intentionnelles. Pour limiter la supervision à un seul datastore, remplacez `/datastore` par `/datastore/NOM` dans les deux commandes correspondantes. Vérifiez avec :

```bash
proxmox-backup-manager user permissions 'gladys@pbs!monitoring'
```

## Paramètres Gladys

1. URL : `https://pbs.example.com:8007`.
2. Identifiant du jeton : `gladys@pbs!monitoring`.
3. Secret : la valeur affichée une seule fois à la création du jeton.
4. Nœud : généralement `localhost`; indiquez le nom retourné par PBS si nécessaire.
5. Gardez la vérification TLS activée. Ne la désactivez que pour un certificat autosigné sur un réseau de confiance.

Le jeton est envoyé avec l'en-tête natif `Authorization: PBSAPIToken=...`; aucun mot de passe n'est envoyé à chaque requête.

## Fonctionnalités exposées

Chaque datastore PBS est représenté par un appareil Gladys comportant les fonctionnalités en lecture seule suivantes :

Les trois valeurs de capacité (`Usage`, `Total size` et `Used space`) sont rattachées à la fonctionnalité Gladys `data/size`, tout en conservant leur unité en pourcentage ou en gigaoctets.

| Fonctionnalité                 | Valeur      | Description                                                                         |
| ------------------------------ | ----------- | ----------------------------------------------------------------------------------- |
| Usage                          | Pourcentage | Espace utilisé, arrondi à deux décimales.                                           |
| Total size                     | Gigaoctets  | Capacité totale du datastore, arrondie à deux décimales.                            |
| Used space                     | Gigaoctets  | Espace utilisé, arrondi à deux décimales.                                           |
| Snapshot count                 | Entier      | Nombre de snapshots actuellement stockés.                                           |
| Last verify                    | Texte       | Dernier statut de vérification avec sa date ISO 8601, ou `Never run`.               |
| Last garbage collection status | Texte       | Dernier statut du garbage collection, par exemple `OK`.                             |
| Last garbage collection date   | Texte       | Date du dernier garbage collection au format ISO 8601.                              |
| Last prune status              | Texte       | Dernier statut du prune, par exemple `OK`.                                          |
| Last prune date                | Texte       | Date du dernier prune au format ISO 8601.                                           |
| Backup stale (> 26 h)          | `0` ou `1`  | `1` lorsqu'aucun snapshot n'existe ou que le plus récent date de plus de 26 heures. |
