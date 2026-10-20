# ADR 0006 — Passerelle API : sessions côté serveur et jetons internes signés

- **Statut** : acceptée
- **Date** : 2026-10-21

## Contexte

Le navigateur appelle une seule API ; derrière, quatre services doivent savoir qui agit et avec
quel rôle, sans que chacun réimplémente l'authentification ni fasse confiance à un en-tête
falsifiable.

## Décision

- **Une passerelle Fastify** est le seul point d'entrée HTTP : authentification, limitation de
  débit, en-têtes de sécurité, identifiant de requête, routage vers les services, OpenAPI agrégé.
- **Sessions côté serveur** : un identifiant aléatoire de 256 bits dans un cookie `HttpOnly`,
  `Secure`, `SameSite=Lax` (préfixe `__Host-`) ; Redis stocke la session sous l'empreinte SHA-256
  de cet identifiant. Révocation immédiate, rotation à la connexion, expiration glissante de 7
  jours.
- **Protection CSRF** : `SameSite=Lax` et contrôle de l'en-tête `Origin` sur toute requête qui
  modifie l'état.
- **Jeton interne** : pour chaque requête routée, la passerelle signe un JWT **EdDSA (Ed25519)**
  de 60 secondes, audience = service cible, portant `sub`, `role` et `shopId`. Les services le
  vérifient avec la clé publique de la passerelle (bibliothèque `jose`) et rejettent toute requête
  sans jeton valide. La passerelle **supprime** les en-têtes `authorization` et `x-user-*` venus du
  client.
- **Socket.io** : la passerelle émet un ticket (même format, audience `notifications`) que le
  client présente à la connexion.
- **Webhooks Stripe** : routés sans session vers payments, corps brut préservé pour la vérification
  de signature.
- **Mots de passe** : Argon2id (paramètres OWASP), verrouillage progressif par compte et par IP.

## Alternatives écartées

- **JWT dans le navigateur** (stockage local ou cookie) : révocation difficile, jeton volable par
  XSS s'il est lisible par JavaScript, taille transportée à chaque requête.
- **Secret partagé HMAC entre passerelle et services** : un service compromis pourrait signer des
  jetons ; avec EdDSA, seuls les détenteurs de la clé privée (la passerelle) signent.
- **mTLS ou maillage de services (Istio, Linkerd)** : l'identité du service appelant, pas celle de
  l'utilisateur ; complémentaire, envisageable plus tard.
- **Service d'identité séparé (Keycloak)** : très complet, mais un composant lourd pour deux rôles
  et une connexion par e-mail.

## Conséquences

- ✅ Les services n'ont aucune logique de session : ils vérifient une signature et lisent des
  claims typés.
- ✅ Un jeton intercepté entre services expire en une minute et ne vaut que pour un service.
- ⚠️ La passerelle est critique : sans état local, répliquée, et ses clés sont rotatives (le
  `kid` du jeton désigne la clé ; les services acceptent la clé courante et la précédente).
