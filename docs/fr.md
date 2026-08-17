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
