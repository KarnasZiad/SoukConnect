## Objectif

<!-- Problème résolu, user story ou issue (ex. US-05, #42). -->

## Changements

-

## Comment tester

<!-- Étapes reproductibles pour le relecteur. -->

## Checklist de l'auteur

- [ ] Titre en Conventional Commits (`feat(orders): ...`)
- [ ] Tests ajoutés ou mis à jour ; `pnpm lint`, `pnpm typecheck` et `pnpm test` passent en local
- [ ] Documentation, contrats OpenAPI et ADR mis à jour si une décision change

## Checklist messagerie et saga (si un service publie ou consomme un message)

- [ ] Le message est écrit dans l'outbox, dans la même transaction que le changement d'état
- [ ] Le consommateur est idempotent (inbox) et refuse un message hors séquence
- [ ] Le schéma du message est dans `packages/contracts` ; un changement incompatible crée un nouveau type
- [ ] Chaque échec a sa compensation, et elle est testée

## Checklist sécurité

- [ ] Toute entrée externe (corps, paramètres, messages, webhooks) est validée par un schéma Zod borné
- [ ] Un vendeur ou un acheteur n'accède jamais aux données d'un autre (identité tirée du jeton interne)
- [ ] Aucun montant ni prix n'est accepté du client
- [ ] Aucun secret ni donnée personnelle dans les logs, les erreurs ou les fixtures

## Checklist performance (si le front ou une requête change)

- [ ] Pas de requête N+1 ; index présent pour chaque nouveau filtre
- [ ] Pages publiques rendues côté serveur ou en ISR ; images via `next/image`
- [ ] Textes ajoutés dans les trois langues (fr, en, ar) et mise en page vérifiée en RTL
