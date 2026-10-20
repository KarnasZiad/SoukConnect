# ADR 0008 — Next.js : rendu serveur, ISR et interface FR, EN, AR

- **Statut** : acceptée
- **Date** : 2026-10-21

## Contexte

Le trafic d'une marketplace vient en grande partie des moteurs de recherche : les fiches produit
doivent être rendues côté serveur, rapides (Lighthouse > 95) et déclinées en trois langues, dont
l'arabe, qui s'écrit de droite à gauche.

## Décision

- **Next.js 16, App Router** : composants serveur pour les pages publiques, composants client
  limités aux zones interactives (panier, filtres, messagerie).
- **ISR** pour les fiches produit et les boutiques : pages générées à la première visite puis
  servies depuis le cache, **régénérées à la demande** quand le produit change (`revalidateTag`
  déclenché par l'événement `catalog.product-changed`, via une route signée), avec une durée de
  vie de secours d'une heure.
- **Recherche et espace connecté rendus dynamiquement** (jamais mis en cache entre utilisateurs).
- **i18n avec `next-intl`** : la langue est le premier segment de l'URL (`/fr`, `/en`, `/ar`) ;
  `<html lang dir>` est fixé côté serveur ; balises `hreflang` et URL canoniques par langue.
- **RTL par les propriétés logiques CSS** (`ms-*`, `me-*`, `text-start` de Tailwind) plutôt que
  par une feuille de style miroir ; les icônes directionnelles sont retournées en RTL.
- **Images** par `next/image` : formats AVIF puis WebP, tailles adaptées, chargeur Cloudflare
  Images en production (`/cdn-cgi/image/…`), optimiseur intégré de Next.js en local.
- Appels à l'API : **côté serveur** vers l'adresse interne de la passerelle ; **côté client** sur
  la même origine (`/api`, routé par l'Ingress), donc cookie de session de première partie.

## Alternatives écartées

- **Génération statique complète au build** : des dizaines de milliers de pages à chaque
  déploiement, et un stock ou un prix périmés jusqu'au suivant.
- **Rendu côté client uniquement (SPA)** : mauvais pour le référencement et le LCP sur mobile.
- **Remix / React Router 7, Nuxt** : comparables ; Next.js est le standard des offres visées et
  maîtrise l'ISR à la demande.

## Conséquences

- ✅ Pages produit servies depuis le cache, à jour quelques secondes après une modification.
- ⚠️ Le cache de Next.js doit être partagé entre répliques en production (gestionnaire de cache
  Redis) ; en v1, une seule réplique du front ou un cache par réplique avec revalidation diffusée.
- ⚠️ Chaque texte d'interface existe en trois langues : un test vérifie que les trois fichiers de
  messages ont les mêmes clés.
