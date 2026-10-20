# ADR 0001 — Enregistrer les décisions d'architecture

- **Statut** : acceptée
- **Date** : 2026-10-21

## Contexte

SoukConnect répartit une même opération (passer commande) entre plusieurs services et plusieurs
bases. Les compromis qui en découlent — cohérence à terme, livraison au moins une fois, données
copiées entre services — surprennent s'ils ne sont pas écrits.

## Décision

Chaque décision structurante est consignée dans un ADR au format de Michael Nygard (contexte,
décision, alternatives, conséquences), versionné avec le code et relu dans la pull request qui
l'introduit. Un ADR accepté n'est jamais réécrit : un nouvel ADR le remplace et l'ancien passe au
statut « remplacée ».

## Conséquences

- Un nouveau contributeur retrouve la justification des choix sans fouiller l'historique.
- Le modèle de menaces, la documentation d'architecture et les pull requests référencent les ADR.
