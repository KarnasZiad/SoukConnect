# User stories

Priorisation MoSCoW. Les critères marqués 🔒 sont aussi des exigences de sécurité, couvertes par
des tests automatisés. Les identifiants sont repris dans les pull requests et les tests.

## Epic 1 — Découvrir l'artisanat

**US-01 · Parcourir le catalogue dans ma langue** — _Must_

> En tant que visiteur, je veux parcourir les pièces en français, en anglais ou en arabe.

- La langue se choisit dans l'en-tête et figure dans l'URL (`/fr`, `/en`, `/ar`) ; à défaut, elle
  suit `Accept-Language`.
- En arabe, la page entière est en `dir="rtl"` : navigation, formulaires et carrousels inversés.
- Prix en dirhams, formatés selon la langue et l'usage marocain (`fr-MA` : `1.250,00 MAD`, `en` :
  `MAD 1,250.00`, `ar-MA` : `1.250,00 د.م.`, en chiffres latins comme au Maroc).
- Les textes d'un produit non traduit s'affichent dans la langue du vendeur, avec la mention
  « non traduit ».

**US-02 · Rechercher malgré les fautes** — _Must_

> En tant que visiteur, je veux trouver « tapis berbère » même en tapant « tapis berbere » ou
> « tapis berbèr ».

- Une ou deux fautes par mot sont tolérées ; les accents sont ignorés.
- Facettes : catégorie, ville, matière, fourchette de prix, vendeur, avec le nombre de résultats.
- Tri par pertinence, prix croissant ou décroissant, nouveauté.
- Les résultats arrivent en moins de 100 ms côté serveur ; l'URL reflète la recherche.
- 🔒 La clé d'administration du moteur ne quitte jamais le serveur.

**US-03 · Consulter une fiche produit rapide et bien référencée** — _Must_

- Photos en WebP ou AVIF, dimensionnées pour l'écran ; la première est prioritaire.
- Attributs propres à la catégorie (dimensions et nœuds d'un tapis, matière d'un sac…).
- La page est générée à l'avance et régénérée quand le vendeur modifie le produit (ISR).
- Données structurées `Product` et `Offer`, balises `hreflang` vers les autres langues.

## Epic 2 — Acheter

**US-04 · Remplir un panier, même sans compte** — _Must_

- Le panier d'un invité survit au rechargement et à la fermeture de l'onglet (30 jours).
- À la connexion, il est fusionné avec le panier du compte.
- La quantité est plafonnée au stock disponible ; un produit retiré de la vente est signalé.

**US-05 · Commander auprès de plusieurs artisans en une fois** — _Must_

- Une commande regroupe des pièces de vendeurs différents ; chaque vendeur ne voit que ses lignes.
- Le stock est réservé pendant le paiement (15 minutes), puis libéré si le paiement n'aboutit pas.
- Si une pièce n'est plus disponible, la commande est refusée avant tout paiement, avec la liste
  des pièces en cause.
- 🔒 Un double clic ou une requête rejouée ne crée qu'une commande (clé d'idempotence).

**US-06 · Payer par carte en toute sécurité** — _Must_

- Le paiement passe par Stripe (mode test) ; le numéro de carte ne transite jamais par nos
  serveurs.
- La commande n'est confirmée qu'à réception du webhook de Stripe, pas sur la redirection du
  navigateur.
- 🔒 Un webhook non signé, mal signé ou trop ancien (plus de 5 minutes) est refusé.
- 🔒 Un webhook reçu deux fois n'a d'effet qu'une fois.

**US-07 · Suivre ma commande en temps réel** — _Should_

- Les étapes (payée, en préparation, expédiée, livrée) s'affichent sans recharger la page.
- Un e-mail est envoyé à la confirmation et à l'expédition.

## Epic 3 — Vendre

**US-08 · Ouvrir ma boutique** — _Must_

> En tant qu'artisan, je veux présenter mon atelier et mon savoir-faire.

- Nom, ville, description dans une ou plusieurs langues, photo de l'atelier.
- La boutique est visible après validation (statut « en attente » en v1, modération en extension).

**US-09 · Publier une pièce depuis mon téléphone** — _Must_

- Formulaire utilisable sur mobile ; les attributs proposés dépendent de la catégorie.
- Le stock et le prix se modifient en un geste ; la recherche est à jour en quelques secondes.
- 🔒 Un vendeur ne peut modifier que les produits de sa boutique.

**US-10 · Préparer mes commandes** — _Must_

- La liste ne montre que mes lignes de commande payées, avec l'adresse de livraison.
- Je passe une ligne à « expédiée » avec un numéro de suivi ; l'acheteur est notifié.
- 🔒 Un vendeur n'accède jamais à la commande d'un autre vendeur, même par son identifiant.

**US-11 · Suivre mes ventes** — _Should_

- Chiffre d'affaires, commission prélevée, montant net, panier moyen, sur 7, 30 et 90 jours.
- Produits les plus vus et les plus vendus.

## Epic 4 — Échanger

**US-12 · Poser une question au vendeur** — _Must_

- Une conversation par couple acheteur-vendeur, rattachée au produit d'origine.
- Les messages arrivent en temps réel ; hors ligne, ils sont lus à la reconnexion.
- 🔒 Seuls les deux participants lisent la conversation ; le contenu est affiché comme texte.
- 🔒 Limitation de débit des messages contre le spam.

## Epic 5 — Exploiter la plateforme

**US-13 · Percevoir la commission de chaque vente** — _Must_

- Chaque boutique a un taux de commission (10 % par défaut), figé sur la commande au moment de
  l'achat.
- Le grand livre enregistre pour chaque vendeur : montant brut, commission, montant net ; la somme
  des écritures d'une commande est égale au montant payé.

**US-14 · Créer et gérer mon compte** — _Must_

- Inscription par e-mail et mot de passe (Argon2id), rôle acheteur ou vendeur.
- 🔒 Session dans un cookie `HttpOnly`, `Secure`, `SameSite=Lax`, révocable ; verrouillage
  progressif après des échecs de connexion.
- Export et suppression du compte (loi 09-08, RGPD).

**US-15 · Modérer les boutiques et les produits** — _Could_ (extension)

- File des boutiques en attente et des produits signalés ; décision tracée.
