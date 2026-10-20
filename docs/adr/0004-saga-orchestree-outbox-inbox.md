# ADR 0004 — Saga orchestrée par orders, avec outbox et inbox transactionnels

- **Statut** : acceptée
- **Date** : 2026-10-21

## Contexte

Passer commande enchaîne trois services : réserver le stock (catalog), encaisser (payments, via
Stripe), confirmer (orders). Une transaction distribuée en deux phases n'est ni disponible entre
MongoDB, PostgreSQL et Stripe, ni souhaitable (verrous tenus pendant la saisie de la carte).

Deux pièges classiques menacent toute saga : publier un message sans avoir validé la transaction
(ou l'inverse), et traiter deux fois un message relivré.

## Décision

- **Orchestration** plutôt que chorégraphie : orders tient la machine à états de la commande et
  envoie des **commandes** (`catalog.reserve-stock`, `payments.request-payment`…) ; catalog et
  payments exécutent et publient des **faits** (`catalog.stock-reserved`…). Le parcours se lit à un
  seul endroit ([saga](../architecture/saga.md)).
- **Outbox transactionnelle** dans chaque producteur : le message est inséré dans la même
  transaction que le changement d'état (table PostgreSQL, ou collection MongoDB dans la même
  transaction). Un relais publie les lignes en attente avec confirmations de publication, puis les
  marque publiées ; plusieurs relais se partagent le travail par `FOR UPDATE SKIP LOCKED`.
- **Inbox** dans chaque consommateur : l'identifiant du message est inséré dans la transaction du
  traitement ; un doublon viole la clé primaire et le message est acquitté sans effet.
- **Transitions conditionnelles et machine à états pure**, testée sans base : un message hors
  séquence est refusé, pas appliqué.
- **Compensations explicites** : libération du stock, annulation ou remboursement du paiement.
- **Échéance de paiement** de 15 minutes stockée sur la commande et balayée chaque minute.

## Alternatives écartées

- **Chorégraphie** (chaque service réagit aux événements des autres) : pas de point central, mais
  le parcours est dispersé dans quatre services et les compensations deviennent difficiles à
  raisonner dès qu'on ajoute une étape.
- **Publier puis valider** (ou valider puis publier) sans outbox : une panne entre les deux laisse
  une commande sans réservation ou une réservation sans commande.
- **Change Data Capture (Debezium)** à la place du relais : robuste, mais un composant de plus
  (Kafka Connect) pour un volume modeste.
- **Moteur de workflow (Temporal)** : très adapté aux sagas longues ; surdimensionné ici et
  masquerait les mécanismes que le projet veut montrer.

## Conséquences

- ✅ Aucun état partiel durable : chaque échec mène à un état final cohérent, testé.
- ✅ Les messages sont rejouables sans risque grâce à l'inbox.
- ⚠️ Latence de quelques centaines de millisecondes due au relais (intervalle de scrutation
  court, réveil immédiat après une écriture dans le même processus).
- ⚠️ Les tables d'outbox et d'inbox grossissent : purge des lignes de plus de 7 jours.
- ⚠️ orders devient un point névralgique : il est sans état en mémoire, répliqué, et ses messages
  attendent dans RabbitMQ s'il est arrêté.
