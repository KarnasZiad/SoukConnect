# ADR 0002 — Des services par capacité métier, reliés par RabbitMQ

- **Statut** : acceptée
- **Date** : 2026-10-21

## Contexte

Le catalogue et la recherche reçoivent l'essentiel du trafic (visiteurs, robots d'indexation) et
doivent rester disponibles quand le paiement est en panne ou en maintenance. Les commandes et les
paiements, eux, ont peu de trafic mais exigent des transactions ACID et une traçabilité
financière. Ces besoins de charge, de données et de disponibilité divergent.

Un monolithe modulaire serait plus simple à exploiter, et c'est le bon choix pour la plupart des
équipes de cette taille. Le projet assume ici un découpage en services pour démontrer ce qu'il
implique : contrats explicites, cohérence à terme, idempotence, observabilité distribuée.

## Décision

- **Quatre services** découpés par capacité métier : `catalog`, `orders`, `payments`,
  `notifications`, plus une **passerelle** qui porte les comptes, les sessions et le panier.
- **Une base par service**, jamais partagée.
- **HTTP synchrone pour les lectures** venues de la passerelle ; **messages asynchrones** pour tout
  ce qui change l'état d'un autre service.
- **RabbitMQ** comme courtier : échange topic, files _quorum_ durables, acquittements manuels,
  confirmations de publication, files de nouvelle tentative et de quarantaine
  ([messagerie](../architecture/messaging.md)).
- Le code commun (contrats Zod, client RabbitMQ, outbox, inbox, démarrage d'un service) vit dans
  des **packages du monorepo**, pas dans un framework partagé à l'exécution.

## Alternatives écartées

- **Monolithe modulaire** : moins de pièces mobiles ; écarté pour l'objectif de démonstration et
  pour isoler la disponibilité du catalogue. Les modules d'un service suivent néanmoins les mêmes
  couches, ce qui permettrait de regrouper des services si l'exploitation le demandait.
- **Kafka** : rétention et rejeu supérieurs, mais un cluster plus lourd et un routage par clé moins
  souple pour des commandes adressées à un seul service. Le volume visé (quelques milliers de
  commandes par jour) ne justifie pas Kafka.
- **Appels HTTP en chaîne** (orders → catalog → payments) : une panne de l'un bloque toute la
  chaîne et laisse des états partiels sans compensation.
- **Redis Streams** : déjà utilisés dans PerfPulse ; RabbitMQ apporte ici le routage par clé, les
  files de quarantaine et les TTL nativement.

## Conséquences

- ✅ Le catalogue se met à l'échelle seul ; une panne de payments n'empêche pas de parcourir.
- ✅ Les frontières entre services sont visibles dans le code (contrats) et dans l'infrastructure.
- ⚠️ Cohérence à terme : une commande est « en attente » quelques centaines de millisecondes ;
  l'interface l'affiche honnêtement.
- ⚠️ Plus d'exploitation : courtier à surveiller, files de quarantaine à traiter, traces à corréler
  (`correlationId` = identifiant de commande dans tous les logs).
