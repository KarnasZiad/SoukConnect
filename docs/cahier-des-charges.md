# Cahier des charges — SoukConnect

## 1. Contexte

Les artisans de Marrakech (tapis, poterie, cuir, bois de thuya, dinanderie) vendent surtout dans
les souks et par l'intermédiaire de revendeurs. Leurs clients sont aussi à l'étranger, mais ils
n'ont ni le temps ni les moyens d'ouvrir et de faire vivre une boutique en ligne : paiement,
traduction, logistique et visibilité restent hors de portée.

SoukConnect est une **marketplace multi-vendeurs** : chaque artisan ouvre une boutique, publie ses
pièces et reçoit ses commandes. La plateforme encaisse le paiement, prélève une commission et
reverse le solde à chaque vendeur. Acheteurs et vendeurs échangent par messagerie et suivent la
livraison en temps réel.

## 2. Objectifs

| #   | Objectif                                                                                 | Mesure                                                       |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| O1  | Un artisan publie une pièce en moins de 5 minutes, depuis un téléphone                   | Parcours testé de bout en bout (Playwright, viewport mobile) |
| O2  | Un acheteur trouve une pièce malgré une faute de frappe (« tapis berbere », « potrie »)  | Tests de la recherche : tolérance aux fautes, facettes       |
| O3  | Une commande n'est jamais payée sans stock, ni le stock bloqué sans paiement durablement | Saga testée sur ses chemins d'échec ; réservation expirante  |
| O4  | Un paiement n'est jamais encaissé deux fois                                              | Clé d'idempotence, webhooks dédupliqués, tests de rejeu      |
| O5  | Le site est rapide et bien référencé en français, anglais et arabe                       | Lighthouse > 95 (performance, accessibilité, SEO) en CI      |
| O6  | Un vendeur ne voit jamais les données d'un autre vendeur                                 | Tests d'autorisation sur chaque route vendeur                |

## 3. Acteurs

| Acteur                | Besoins principaux                                                         |
| --------------------- | -------------------------------------------------------------------------- |
| Visiteur              | Parcourir, rechercher, lire une fiche produit dans sa langue               |
| Acheteur              | Panier, paiement, suivi de commande, messagerie avec le vendeur            |
| Vendeur (artisan)     | Boutique, catalogue, stock, commandes à préparer, statistiques, versements |
| Modérateur            | Valider les boutiques et les produits signalés (extension)                 |
| Stripe                | Encaissement par carte (mode test), notifications par webhook signé        |
| Transporteur (simulé) | Mises à jour de livraison (expédiée, en transit, livrée)                   |

## 4. Périmètre

### MVP (v1)

- **Catalogue** : boutiques, produits à attributs variables selon la catégorie (dimensions et
  matière d'un tapis, contenance d'une poterie, type de cuir…), photos, stock, prix en dirhams.
- **Recherche** à facettes (catégorie, ville, matière, fourchette de prix, vendeur), tolérante aux
  fautes de frappe, dans les trois langues.
- **Panier** persistant (invité puis rattaché au compte à la connexion).
- **Commande multi-vendeurs** : une commande peut contenir les pièces de plusieurs artisans ; elle
  suit le parcours **commande → réservation du stock → paiement → confirmation**, avec compensation
  à chaque échec (saga).
- **Paiement Stripe en mode test**, idempotent, confirmé par webhook signé ; **commission par
  vendeur** calculée et inscrite dans un grand livre.
- **Espace vendeur** : produits, stock, commandes, statistiques (chiffre d'affaires, panier moyen,
  produits les plus vus et vendus).
- **Messagerie** acheteur-vendeur et **suivi de commande en temps réel** (Socket.io).
- **Notifications** par e-mail (confirmation, expédition) et dans l'interface.
- **Interface FR, EN et AR**, l'arabe en écriture de droite à gauche.
- **SEO** : rendu serveur, pages produit régénérées (ISR), données structurées `Product`, sitemap.
- **Images** en WebP et AVIF, servies par un CDN.

### Extensions (feuille de route)

- Recommandations « produits similaires ».
- Back-office de modération.
- Suivi de livraison sur carte (Leaflet).
- Application mobile React Native partageant les types TypeScript.

### Hors périmètre

- Versement réel aux vendeurs (Stripe Connect en production), facturation, TVA : le grand livre
  calcule les montants, le virement reste simulé.
- Transporteur réel : les étapes de livraison sont saisies par le vendeur ou simulées.

## 5. Exigences non fonctionnelles

| Domaine       | Exigence                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------- |
| Performance   | Lighthouse > 95 sur l'accueil, la recherche et une fiche produit ; LCP < 2,5 s en 4G simulée       |
|               | API : p95 < 200 ms en lecture, < 500 ms pour passer commande (hors latence Stripe)                 |
| Disponibilité | La recherche et le catalogue restent consultables si les commandes ou les paiements sont arrêtés   |
| Cohérence     | Les messages entre services sont livrés au moins une fois et traités une seule fois (outbox/inbox) |
| Sécurité      | OWASP ASVS niveau 2 ; mots de passe Argon2id ; sessions côté serveur ; webhooks signés ;           |
|               | aucun numéro de carte ne transite par nos serveurs (Stripe Elements)                               |
| Données       | Loi 09-08 (CNDP) et RGPD : minimisation, export et suppression du compte, journaux sans PII        |
| Accessibilité | WCAG 2.2 AA ; navigation au clavier ; mise en page miroir correcte en arabe                        |
| Observabilité | Logs JSON (Pino) corrélés par identifiant de requête, métriques Prometheus, healthchecks           |
| Qualité       | TypeScript strict ; couverture > 80 % ; tests d'intégration sur conteneurs réels ; e2e Playwright  |
| Exploitation  | Images Docker non root ; Kubernetes (Ingress NGINX) ; environnement éphémère par pull request      |

## 6. Contraintes

- Monorepo **Turborepo** ; tout le code en TypeScript.
- Services Node.js indépendants : **catalog**, **orders**, **payments**, **notifications**,
  derrière une **passerelle API** ; communication asynchrone par **RabbitMQ**.
- **MongoDB** pour le catalogue, **PostgreSQL** pour les commandes et les paiements, **Redis** pour
  le panier et les sessions, **Meilisearch** pour la recherche (justification : [ADR 0003](adr/0003-cohabitation-sql-nosql.md)).
- Contrats d'API **OpenAPI** générés depuis les schémas de validation, publiés par chaque service.

## 7. Livrables

| Lot | Contenu                                                                                   |
| --- | ----------------------------------------------------------------------------------------- |
| L0  | Conception : ce cahier, user stories, C4, saga (UML), modèle de données, ADR, menaces     |
| L1  | Contrats d'événements, messagerie (outbox, inbox, reprises), socle commun des services    |
| L2  | Catalogue et recherche (MongoDB, Meilisearch), réservation de stock                       |
| L3  | Commandes et saga (PostgreSQL)                                                            |
| L4  | Paiements Stripe, webhooks, commissions                                                   |
| L5  | Passerelle : comptes, sessions, panier, routage, OpenAPI agrégé                           |
| L6  | Notifications : messagerie et suivi en temps réel, e-mails                                |
| L7  | Front Next.js : boutique, espace vendeur, i18n FR/EN/AR                                   |
| L8  | Playwright, Lighthouse CI, Kubernetes, environnement de prévisualisation par pull request |

## 8. Critères d'acceptation globaux

- Chaque user story _Must_ est couverte par au moins un test automatisé.
- La CI (lint, types, tests, scans de sécurité, images Docker) est verte sur `main`, protégée.
- Un parcours complet — recherche, panier, paiement par carte de test, confirmation, message au
  vendeur, expédition — passe en e2e sur la pile complète.
