# ADR 0003 — MongoDB pour le catalogue, PostgreSQL pour l'argent, Redis et Meilisearch en appui

- **Statut** : acceptée
- **Date** : 2026-10-21

## Contexte

Les données de SoukConnect n'ont pas toutes la même forme ni les mêmes exigences :

- un **produit** a des attributs qui dépendent de sa catégorie (dimensions et densité de nœuds d'un
  tapis, contenance d'une poterie, type de tannage d'un sac), des textes en trois langues et des
  photos ; il est lu des milliers de fois pour une écriture ;
- une **commande** et un **paiement** engagent de l'argent : ils exigent des contraintes
  d'intégrité, des transitions atomiques et des requêtes d'agrégation pour la comptabilité ;
- un **panier** et une **session** sont éphémères, lus et écrits à chaque page ;
- la **recherche** doit tolérer les fautes, ignorer les accents et compter des facettes en
  quelques millisecondes.

## Décision

| Donnée                  | Stockage      | Pourquoi                                                                                                                     |
| ----------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Catalogue, réservations | MongoDB 8     | Documents aux attributs variables lus d'un bloc ; transactions multi-documents (jeu de réplicas) pour réserver tout ou rien  |
| Commandes, saga         | PostgreSQL 17 | Transitions conditionnelles, `FOR UPDATE SKIP LOCKED`, contraintes `CHECK`, agrégats vendeur                                 |
| Paiements, grand livre  | PostgreSQL 17 | ACID, montants `bigint`, unicité de l'identifiant Stripe et de chaque webhook                                                |
| Comptes                 | PostgreSQL 17 | Unicité de l'e-mail, données personnelles à supprimer précisément                                                            |
| Sessions, panier        | Redis 7       | Accès en O(1), expiration native (TTL), partagé par les répliques de la passerelle                                           |
| Recherche               | Meilisearch   | Tolérance aux fautes, facettes, pertinence multilingue sans configuration lourde ([ADR 0007](0007-recherche-meilisearch.md)) |
| Conversations           | MongoDB 8     | Fil de messages append-only, lu par conversation, TTL des notifications                                                      |

Les attributs d'un produit restent **validés** : chaque catégorie a son schéma Zod, appliqué à
l'écriture. MongoDB apporte la souplesse du stockage, pas l'absence de règles.

## Alternatives écartées

- **PostgreSQL partout, attributs en `jsonb`** : techniquement viable et plus simple à exploiter ;
  écarté pour isoler la charge de lecture du catalogue des données financières et pour montrer la
  cohabitation, que le cahier des charges demande de justifier.
- **MongoDB partout** : les transactions existent, mais les contraintes d'intégrité, les
  verrous de ligne et les agrégations comptables sont plus naturels et mieux outillés en SQL.
- **Recherche dans MongoDB (`$text`, Atlas Search)** : `$text` ne tolère pas les fautes ; Atlas
  Search lie le projet à un fournisseur.

## Conséquences

- ✅ Chaque modèle de données sert la requête dominante de son service.
- ⚠️ Quatre moteurs à sauvegarder et à surveiller ; chaque service n'en utilise qu'un ou deux.
- ⚠️ Pas de jointure entre catalogue et commandes : les lignes de commande copient le titre, le
  prix et le taux de commission au moment de la réservation, ce qui est de toute façon correct
  comptablement (un prix modifié après l'achat ne change pas la commande).
- ⚠️ L'index Meilisearch est une **projection** du catalogue : il peut avoir quelques secondes de
  retard, et se reconstruit entièrement depuis MongoDB.
