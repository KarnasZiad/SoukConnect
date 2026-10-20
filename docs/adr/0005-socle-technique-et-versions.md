# ADR 0005 — Socle technique et politique de versions

- **Statut** : acceptée
- **Date** : 2026-10-21

## Contexte

Cinq services, un front et des packages partagés doivent rester cohérents : mêmes versions, mêmes
conventions, une seule commande pour tout vérifier. Le cahier initial citait Next.js 14 ; la
version courante au démarrage du projet est la 16.

## Décision

- **Monorepo pnpm + Turborepo** : graphe de tâches (`build` dépend du `build` des dépendances),
  cache local et en CI, filtres par package.
- **TypeScript strict partout**, ESM natif côté serveur (`nodenext`).
- Les packages partagés exportent une condition **`@soukconnect/source`** qui pointe vers les
  sources : vérification de types, tests et développement sans compilation préalable ; le build
  de production utilise `dist/`.
- **Fastify 5** pour tous les services, schémas **Zod 4** convertis en **OpenAPI 3.1** par
  `fastify-type-provider-zod` et publiés par `@fastify/swagger` (`/openapi.json`).
- **Logs Pino** en JSON, corrélés par `x-request-id` et `correlationId`.
- **Next.js 16** (App Router, React 19) pour le front.

| Dépendance              | Version | Raison                                                                             |
| ----------------------- | ------- | ---------------------------------------------------------------------------------- |
| Node.js                 | 22 LTS  | LTS jusqu'en avril 2027                                                            |
| TypeScript              | 5.9     | typescript-eslint ne supporte pas encore TypeScript 7                              |
| Fastify                 | 5       | Version courante, écosystème officiel (cookies, débit, proxy)                      |
| Next.js / React         | 16 / 19 | Versions maintenues ; `proxy.ts`, cache explicite                                  |
| MongoDB / driver        | 8 / 7   | Transactions multi-documents sur jeu de réplicas                                   |
| PostgreSQL              | 17      | Alignée sur les autres projets ; la 18 sera évaluée à part                         |
| RabbitMQ / amqplib      | 4.3 / 2 | Files _quorum_ ; la 4.4 date de la veille du projet ; amqplib 2 embarque ses types |
| Redis / ioredis         | 7.4 / 5 | ioredis 5 éprouvé ; la v6 sera évaluée dans une PR dédiée                          |
| Meilisearch             | 1.54    | Recherche tolérante aux fautes, facettes                                           |
| Stripe (SDK)            | 22      | Dernière version mineure éprouvée ; la 23 date de moins d'un mois                  |
| Vitest / Testcontainers | 4 / 11  | Alignés sur les autres projets du portfolio                                        |

Une dépendance n'entre dans le projet que si sa version a au moins deux semaines. Dependabot
propose les mises à jour mineures et correctives chaque semaine ; les majeures font l'objet d'une
pull request dédiée.

## Conséquences

- ✅ `pnpm lint`, `pnpm typecheck`, `pnpm test` vérifient tout le monorepo ; Turborepo ne relance
  que ce qui a changé.
- ⚠️ ESM impose des extensions `.js` dans les imports TypeScript côté serveur.
- ⚠️ Les packages partagés doivent rester sans effet de bord à l'import : ils sont chargés par
  plusieurs services et par les tests.
