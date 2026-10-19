# AGENTS.md — Chatvardage Message-Service

Règles de travail pour toute personne ou tout agent qui modifie ce dépôt. Le fonctionnement est décrit dans le `README.md` et dans le guide du service d'Infra.

## Contexte du projet

Ce dépôt est le **Message-Service** de Chatvardage.

Architecture d'équipe :

- `Frontend` : client Electron.
- `Mobile` : application Expo (React Native).
- `Serveur-API` : API Gateway / point d'entrée unique (relaie aussi Socket.IO).
- `Authentification` : utilisateurs, authentification et rôles globaux.
- `Room-Service` : serveurs, membres, rôles et salons — seule source de vérité des droits d'accès aux salons.
- `Message-Service` : messages privés et de salon, historique et temps réel.
- `User-Config-Service` : alias, thème, préférences et présence choisie.
- `Dashboard` : panneau d'administration.
- `Infra` : Docker Compose, PostgreSQL, Redis et orchestration globale.

## Stack

- Node.js 22, NestJS 11, TypeScript
- Prisma 6 (version exacte, la même dans tous les services), PostgreSQL 17
- Redis 7 (Pub/Sub) et Socket.IO (namespace `/messages`)
- Jest, ESLint + Prettier (même configuration que les autres services Node)
- Swagger / OpenAPI (`@nestjs/swagger` 11, exposé sous `/docs`)
- Docker

## Responsabilités

- persister les messages privés et de salon dans PostgreSQL (source de vérité) ;
- persister l'état de lecture de chaque conversation (`ConversationReadState`), calculer les messages non lus et rechercher dans les seules conversations accessibles (salons lisibles fournis par Room-Service, `GET /api/internal/users/:userId/channels`) ;
- publier chaque changement sur Redis **après** l'écriture en base, puis le diffuser par Socket.IO ;
- relayer la présence, le profil, l'indicateur de saisie et les changements de serveur signalés par Room-Service (`/api/internal`, jeton interne) ;
- limiter la fréquence des envois (`LimiteEnvoiService`) et des événements Socket.IO bavards.

Ne pas recoder ici une règle de droits sur les salons : toujours demander l'accès à Room-Service (`RoomsClientService`). Ne pas stocker de préférences utilisateur (User-Config-Service).

## Authentification

- REST : `Authorization: Bearer <JWT>` ; Socket.IO : `handshake.auth.token`.
- Le jeton est validé par Authentification (`GET /api/auth/me`) via `src/partage/client-auth.ts`, jamais localement. Ne jamais accepter une identité fournie par le client (`x-user-id`, `handshake.auth.userId`).
- Un socket ouvert est revalidé régulièrement (voir `MessagesGateway`) : un jeton révoqué ou expiré le déconnecte.
- Aucun événement d'un client n'est traité avant `connexion.prete` (authentification terminée).

## Fichiers partagés (`src/partage/`)

`client-auth.ts` et `secrets-production.ts` (et leurs specs) sont **identiques à l'octet près** dans d'autres dépôts. Ne pas les modifier dans un seul dépôt : reporter le même changement partout, puis lancer `A26_5A6_01-Infra/scripts/verifier-fichiers-partages.sh`.

## Code

Pas de commentaires dans le code : les explications vont dans le README, le guide du service d'Infra ou ce fichier. Seules restent les directives d'outils (`eslint-disable-next-line`).

## Swagger

Toutes les routes REST sont sous `/api`; Swagger est exposé sous `/docs`. Une nouvelle route ou un nouveau DTO REST reçoit ses décorateurs `@ApiOperation` / `@ApiProperty`, comme dans Room-Service. Les événements Socket.IO ne sont pas dans Swagger : les documenter dans Infra (`docs/api/temps-reel-*.md`).

`@nestjs/swagger` 11 embarque `js-yaml` 5.3.0 (vulnérabilité modérée). L'`overrides` limité à `@nestjs/swagger` force `js-yaml` ^5.4.2 sans toucher aux autres paquets (la v12 exige NestJS 12). Le retirer quand Swagger 11 corrigera sa dépendance ou lors du passage à NestJS 12.

## Limites connues (acceptées)

Une seule instance : sans adaptateur Redis de Socket.IO, la présence, les limites de fréquence et le retrait des salons ne voient que les clients de l'instance courante. Ne pas lancer plusieurs instances sans traiter ce point.

## Commandes obligatoires avant de terminer une modification

```bash
npm audit --audit-level=high
npm run lint
npm run format:check
npm run build
npm run test:cov
```

**Audit des dépendances** : le CI lance `npm audit --audit-level=high` (dépendances de dev comprises). Si un avis `high` ou `critical` sans correctif compatible le bloque, forcer une version corrigée par un `overrides` ciblé dans `package.json` si elle existe ; sinon consigner l'exception dans la section « Limites connues (acceptées) » ci-dessus (paquet, avis, raison, condition de retrait). Ne pas retirer ni affaiblir l'étape.

Après un changement des requêtes de non-lus, d'état de lecture ou de recherche, lancer aussi `npm run test:integration` contre une base jetable (voir le README) : les tests unitaires simulent Prisma et ne prouvent pas le SQL réel (par exemple, Prisma n'échappe pas `%` et `_` dans `contains`).

La couverture est exigée à **100 %** (voir `coverageThreshold` dans `package.json`) : toute nouvelle branche atteignable doit être testée. Les tests unitaires simulent Prisma, Redis et les autres services.

## Docker

Le conteneur tourne sous l'utilisateur `node` et exécute `prisma migrate deploy` avant de démarrer. Pour lancer le service seul : `docker compose -f compose.local.yml up --build` (Authentification et Room-Service attendus sur l'hôte). La stack complète est dans `A26_5A6_01-Infra`.

## Documentation

Mettre à jour le `README.md` et, dans Infra, `docs/services/Message-Service.md` et `docs/api/temps-reel-*.md` à chaque changement de route, d'événement Socket.IO ou de variable d'environnement, ainsi que `docs/API.md` de Serveur-API si le contrat vu par les clients change.

## Documentation centrale

Infra est la référence du démarrage complet, des architectures, contrats et scénarios de validation. Le README local décrit le dépôt et ses commandes; les guides détaillés sont dans `A26_5A6_01-Infra/docs/`. Toute modification de contrat doit mettre à jour la référence centrale et ses liens.

## Choix délibérés (ne pas « corriger »)

- **Confirmation de livraison atomique** : une seule requête confirme et publie `private-message.delivered` ; l'`UPDATE` conditionnel ne change pas `updatedAt`, même si le texte est modifié entre l'autorisation et la confirmation.
- **Revalidation pendant une panne d'Auth** : les sockets sont conservés, comme pour la revalidation périodique ; un avertissement agrégé les signale.
- **Pas de validation UUID des identifiants** : les colonnes sont en `TEXT` (pas de `@db.Uuid`) et une cible absente est déjà refusée par le contrat.
- **CLI Prisma appelé par `build/index.js`** : c'est le `bin` déclaré de la version figée ; npm/npx sont absents de l'image.
- **`overrides` de `js-yaml` limité à `@nestjs/swagger`** (voir Swagger plus haut).
- **La promesse de validation Auth en cours est supprimée à l'invalidation** : reprendre une validation commencée avant une révocation serait une faille. Fichier partagé avec Room-Service.
- **Publication de l'état de lecture** seulement si la lecture relue correspond encore à la date avancée par cet appel ; l'état en base reste monotone. Pas de verrou distribué : chaque consommateur garde la position maximale `(lastReadAt, lastReadMessageId)`.
- **Une date Redis invalide est rejetée par la gateway** avant d'atteindre les clients.
- **`Promise.all` à trois opérations pour deux résultats** : la troisième renvoie `void` et son échec doit se propager.
- **`OR` des compteurs de non-lus DM** : la clause des conversations jamais lues est nécessaire ; une optimisation SQL demande une mesure de charge.
- **Fusion de recherche** : charger au plus deux fois `limit + 1` lignes détermine la page globale et son curseur ; la limite maximale borne ce coût.
- **Curseur de recherche non signé** : il ne donne aucun droit, la portée est recalculée depuis l'identité authentifiée.
- **Invalidation de toutes les listes de salons lisibles après un changement de serveur** : elle privilégie les droits actuels.
- **Recherche sans limite de fréquence spécifique** : limite connue. Avant une forte charge, mesurer et ajouter une limite ou un index trigramme dans ce service.
- **Chaîne de migrations** : `20260916163000_init` crée `PrivateMessage`, `20260923130000_add_room_message` crée `RoomMessage`, puis `20261006175849_etat_lecture` et `20261006194000_position_lecture` ajoutent l'état de lecture. Une base neuve n'exige aucune migration corrective.
