# ADR 0007 — Recherche à facettes avec Meilisearch

- **Statut** : acceptée
- **Date** : 2026-10-21

## Contexte

Les acheteurs écrivent vite et sur mobile : « tapis berbere », « potrie de safi », parfois en
translittération arabe. Ils filtrent par catégorie, ville, matière et prix. Les résultats doivent
arriver en quelques dizaines de millisecondes, avec le nombre de pièces par facette.

## Décision

- **Meilisearch** héberge un index `products`, projection du catalogue : textes des trois langues,
  attributs filtrables (`category`, `city`, `material`, `price`, `shopId`), tri par prix et date.
- **catalog est le seul client** : la clé d'administration ne quitte pas ce service ; la recherche
  publique passe par `GET /search` du catalogue, qui borne les paramètres (longueur, facettes
  autorisées, pagination) avant d'interroger Meilisearch.
- **Indexation asynchrone** : une modification de produit écrit `catalog.product-changed` dans
  l'outbox ; un consommateur du catalogue met à jour l'index. Une commande de **réindexation
  complète** reconstruit l'index depuis MongoDB (nouvel index puis bascule atomique `swapIndexes`).
- Réglages explicites et versionnés : attributs recherchables par ordre d'importance, règles de
  classement, synonymes métier (« babouche » ↔ « belgha », « tapis » ↔ « zarbia »).

## Alternatives écartées

- **Elasticsearch / OpenSearch** : plus puissant (agrégations, analyse fine), mais plus lourd à
  exploiter et à régler pour un catalogue de quelques dizaines de milliers de produits.
- **Typesense** : comparable ; Meilisearch a été retenu pour sa tolérance aux fautes par défaut et
  ses réglages simples.
- **Requêtes MongoDB** : pas de tolérance aux fautes ni de pertinence.

## Conséquences

- ✅ Recherche tolérante aux fautes et facettée sans code de pertinence maison.
- ⚠️ L'index peut avoir quelques secondes de retard sur le catalogue ; le stock affiché sur la
  fiche produit vient toujours de MongoDB.
- ⚠️ Une instance de plus à sauvegarder… ou à reconstruire : la réindexation complète fait office
  de restauration.
