# Chatvardage — Messages et temps réel

Microservice NestJS/Prisma : messages privés et de salon, historique paginé, état de lecture et non-lus, recherche, accusés de livraison, Redis Pub/Sub et Socket.IO (namespace `/messages`). Chaque création, modification ou suppression est écrite dans PostgreSQL avant d'être publiée. Si la publication Redis échoue après l'écriture, ou n'aboutit pas à temps (2 s pour la connexion et 2 s pour la commande, nouvelles tentatives comprises), l'échec est journalisé et la requête réussit quand même : les clients récupèrent le changement par REST à leur prochaine lecture (historique avec `deliveredAt` et `updatedAt`, non-lus, état de lecture). Tant que ce client ne relit pas l'API (ouverture de la conversation, reconnexion, retour au premier plan), il n'affiche ni le nouveau message, ni la livraison, ni la lecture perdus.

## Lancer le service complet

Le [README Infra](https://github.com/Chatvardage/A26_5A6_01-Infra/blob/main/README.md) est le point de départ : clonage des dépôts, secrets, Docker Compose, administration et clients.

```bash
cd ../A26_5A6_01-Infra
docker compose up --build -d --wait
./scripts/healthcheck.sh
```

## Développer ce dépôt seul

Prérequis : Docker Compose v2 ; hors Docker, Node 22, PostgreSQL et Redis. Authentification et Room-Service doivent être joignables sur l'hôte.

```bash
cp .env.example .env
docker compose -f compose.local.yml up --build
```

Service : `http://localhost:3004`. Santé : `GET /api/health`. Swagger (REST) : `http://localhost:3004/docs`. Le Compose individuel utilise les mêmes ports qu'Infra : lancer un seul environnement à la fois. Les valeurs de `.env.example` sont réservées au développement.

## Vérifications

```bash
npm ci
npm audit --audit-level=high
npx prisma generate
npm run lint
npm run format:check
npm run test:cov -- --runInBand
npm run build
```

La couverture est exigée à 100 %. Les tests unitaires simulent Prisma, Redis et les autres services.

Le cache de déduplication des événements `typing` garde au plus 1 000 cibles par socket : une nouvelle cible remplace la plus ancienne lorsque cette limite est atteinte.

### Tests d'intégration (PostgreSQL réel)

`npm run test:integration` exécute les vraies requêtes Prisma des non-lus, de l'état de lecture, de la recherche et de la confirmation de livraison. Ils exigent une base **jetable** dont le nom finit par `_test`, car chaque test vide les tables. Avec le PostgreSQL d'Infra démarré :

```bash
docker exec chatvardage-postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "CREATE ROLE ms_test LOGIN PASSWORD '"'"'ms_test'"'"';" -c "CREATE DATABASE chatvardage_messages_test OWNER ms_test;"'

export DATABASE_URL="postgresql://ms_test:ms_test@localhost:5432/chatvardage_messages_test?schema=public"
npx prisma migrate deploy
npm run test:integration
```

Le CI n'a pas de PostgreSQL et ne les lance pas.

## Contrats

Les routes, événements et règles sont décrits dans Infra :

- [Guide du service](https://github.com/Chatvardage/A26_5A6_01-Infra/blob/main/docs/services/Message-Service.md) : configuration, routes, droits, limites.
- [Temps réel des messages privés](https://github.com/Chatvardage/A26_5A6_01-Infra/blob/main/docs/api/temps-reel-dm.md) et [des salons](https://github.com/Chatvardage/A26_5A6_01-Infra/blob/main/docs/api/temps-reel-salons.md) : événements Socket.IO, position de lecture `(lastReadAt, lastReadMessageId)`.
- [Ouverture directe d'un message](https://github.com/Chatvardage/A26_5A6_01-Infra/blob/main/docs/api/recherche-pagination-directe.md) : paramètres `around`, `cursor` et `direction=after`.
- [Résumé de recherche](https://github.com/Chatvardage/A26_5A6_01-Infra/blob/main/docs/api/recherche-resume.md) : `GET /api/messages/search/summary`.
- [Architecture](https://github.com/Chatvardage/A26_5A6_01-Infra/blob/main/docs/architecture.md), [scénario de validation](https://github.com/Chatvardage/A26_5A6_01-Infra/blob/main/docs/validation.md), [versions](https://github.com/Chatvardage/A26_5A6_01-Infra/blob/main/docs/versions.md).

Les migrations appartiennent à ce dépôt (`prisma/migrations`) ; Infra crée seulement les bases et les comptes SQL. L'image finale ne contient ni npm ni npx : elle applique les migrations avec le CLI Prisma installé (`node node_modules/prisma/build/index.js migrate deploy`).
