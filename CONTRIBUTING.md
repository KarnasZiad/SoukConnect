# Contribuer à SoukConnect

## Flux de travail

1. Créer une branche depuis `main` : `feat/<sujet>`, `fix/<sujet>`, `docs/<sujet>`, `chore/<sujet>`.
2. Commiter en [Conventional Commits](https://www.conventionalcommits.org/fr/), vérifié par
   commitlint ; la portée est le package concerné (`feat(orders): …`, `fix(web): …`).
3. Ouvrir une pull request en remplissant le template (checklists saga, sécurité et performance).
4. La CI doit être verte : format, lint, typecheck, tests et couverture, build, tests d'intégration
   sur conteneurs réels, images Docker scannées, CodeQL, Trivy et revue des dépendances.
5. Fusion en _squash merge_. `main` est protégée : pas de push direct, pull request et checks CI
   obligatoires, historique linéaire. Le dépôt a un seul mainteneur, donc aucune approbation n'est
   exigée ; en équipe, la règle passe à une approbation d'un code owner (`CODEOWNERS`).

## Prérequis

- Node.js 22 (`.nvmrc`), pnpm 10 via Corepack (`corepack enable`)
- Docker pour les bases, RabbitMQ et Meilisearch en local, et pour les tests d'intégration

## Organisation du monorepo

| Dossier     | Contenu                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| `apps/`     | Front Next.js                                                                   |
| `services/` | Passerelle et services métier, chacun avec sa base, son Dockerfile, son OpenAPI |
| `packages/` | Code partagé sans effet de bord : contrats, messagerie, socle des services      |
| `docs/`     | Cahier des charges, user stories, architecture, ADR, sécurité                   |

Un service n'importe jamais le code d'un autre service : il passe par `packages/contracts`.

## Commandes

| Commande                | Rôle                                                                        |
| ----------------------- | --------------------------------------------------------------------------- |
| `pnpm dev`              | Tous les services et le front en mode watch (Turborepo)                     |
| `pnpm lint`             | ESLint avec règles typées, zéro avertissement toléré                        |
| `pnpm typecheck`        | TypeScript strict sur tous les packages                                     |
| `pnpm test:coverage`    | Tests unitaires et HTTP avec seuils de couverture                           |
| `pnpm test:integration` | MongoDB, PostgreSQL, Redis, RabbitMQ réels (Testcontainers)                 |
| `pnpm --filter <pkg> …` | Une tâche sur un seul package, ex. `pnpm --filter @soukconnect/orders test` |

## Revue de code

Le relecteur vérifie en priorité :

- **Argent** : montants entiers en centimes, aucun prix venu du client, idempotence de chaque
  écriture, sommes du grand livre.
- **Saga** : outbox dans la transaction, inbox côté consommateur, transitions conditionnelles,
  compensation testée pour chaque échec.
- **Autorisation** : identité tirée du jeton interne, ressource d'autrui répondue en `404`.
- **Contrats** : schéma Zod partagé, changement incompatible = nouveau type de message.
- **Front** : rendu serveur des pages publiques, textes dans les trois langues, mise en page RTL.
