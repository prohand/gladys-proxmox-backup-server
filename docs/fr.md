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
6. L'intervalle de rafraîchissement est de 15 minutes par défaut. Il ne peut pas être inférieur à 5 minutes afin de limiter la croissance de la base Gladys, et peut être augmenté jusqu'à 24 heures.
7. La liste déroulante générale `Format de date` s'applique à toutes les dates des tâches. Elle propose les formats ISO 8601, jour/mois/année, année-mois-jour et mois/jour/année. Les dates sont formatées en UTC.

> Après avoir modifié et sauvegardé le format de date, ouvrez l'appareil PBS concerné dans Gladys et sauvegardez-le de nouveau pour appliquer le changement.

Le jeton est envoyé avec l'en-tête natif `Authorization: PBSAPIToken=...`; aucun mot de passe n'est envoyé à chaque requête.

## Fonctionnalités exposées

Chaque datastore PBS est représenté par un appareil Gladys comportant les fonctionnalités en lecture seule suivantes :

Les trois valeurs de capacité (`Usage`, `Total size` et `Used space`) sont rattachées à la fonctionnalité Gladys `data/size`, tout en conservant leur unité en pourcentage ou en gigaoctets.

| Fonctionnalité                 | Valeur      | Description                                                                         |
| ------------------------------ | ----------- | ----------------------------------------------------------------------------------- |
| Usage                          | Pourcentage | Espace utilisé, arrondi à deux décimales.                                           |
| Total size                     | Gigaoctets  | Capacité totale du datastore, arrondie à deux décimales.                            |
| Used space                     | Gigaoctets  | Espace utilisé, arrondi à deux décimales.                                           |
| Snapshot count                 | Entier      | Nombre de snapshots stockés, cumulé sur les groupes de sauvegarde.                  |
| Last verify status             | Texte       | Dernier statut de vérification, par exemple `OK`.                                   |
| Last verify date               | Texte       | Date de la dernière vérification, au format configuré.                              |
| Last garbage collection status | Texte       | Dernier statut du garbage collection, par exemple `OK`.                             |
| Last garbage collection date   | Texte       | Date du dernier garbage collection, au format configuré.                            |
| Last prune status              | Texte       | Dernier statut du prune, par exemple `OK`.                                          |
| Last prune date                | Texte       | Date du dernier prune, au format configuré.                                         |
| Backup stale (> 26 h)          | `0` ou `1`  | `1` lorsqu'aucun snapshot n'existe ou que le plus récent date de plus de 26 heures. |

## Détails de fonctionnement

- Le nombre de snapshots et la fraîcheur des sauvegardes sont lus depuis les groupes de sauvegarde du datastore (`backup-count` et `last-backup`) : un datastore contenant des milliers de snapshots ne coûte qu'une petite réponse par rafraîchissement. Si une version de PBS n'expose pas ces compteurs, l'intégration revient à la liste complète des snapshots.
- L'historique des tâches est lu page par page jusqu'à trouver les dernières tâches de vérification, de garbage collection et de prune (jusqu'à 2000 tâches) : sur un datastore très actif, elles ne disparaissent plus de la fenêtre consultée et ne repassent pas à `Never run`.
- Un datastore hors ligne ou non monté ne renvoie aucune capacité ; l'intégration publie alors `0` pour l'usage, la taille totale et l'espace utilisé, plutôt qu'une valeur invalide.
- Un rafraîchissement en échec (erreur réseau, délai dépassé, redémarrage de PBS) est retenté au tick Gladys suivant, sans attendre un intervalle complet. Au démarrage, la connexion est retentée quatre fois avec un délai exponentiel avant que l'intégration ne se déclare déconnectée.

## Vérifier la route d'inventaire utilisée

L'intégration privilégie la route économique `groups` et se rabat sur la liste complète des snapshots ; ce repli est tracé en avertissement dans les logs du conteneur (`Falling back to the snapshot list for datastore ...`, avec l'erreur PBS qui l'a déclenché).

Pour le vérifier sur votre serveur sans rien installer dans Gladys, lancez le diagnostic en lecture seule depuis un clone de ce dépôt :

```bash
PBS_URL=https://pbs.example.com:8007 \
PBS_TOKEN_ID='gladys@pbs!monitoring' \
PBS_TOKEN_SECRET='le-secret-du-jeton' \
npm run check:pbs
```

Il affiche, pour chaque datastore, la route réellement utilisée, le temps de réponse de chaque route et les dernières tâches verify/GC/prune. Il recoupe également le nombre de snapshots et la date du plus récent avec la liste complète des snapshots, et se termine avec le code `1` en cas de divergence. Ajoutez `PBS_NODE=...` pour un nœud autre que `localhost`, et `PBS_VERIFY_TLS=false` pour un certificat autosigné.

Les mêmes routes se vérifient à la main :

```bash
curl -sSf -H "Authorization: PBSAPIToken=gladys@pbs!monitoring:SECRET" \
  'https://pbs.example.com:8007/api2/json/admin/datastore/NOM/groups' | head -c 400
```

Un HTTP 403 signale une ACL sans `Datastore.Audit` sur ce datastore ; un HTTP 404 signifie que cette version de PBS ne sert pas la route et que le repli sur les snapshots est normal.
