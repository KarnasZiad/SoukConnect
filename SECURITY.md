# Politique de sécurité

## Signaler une vulnérabilité

Merci de **ne pas** ouvrir d'issue publique. Utilisez le formulaire privé de GitHub :
[Security → Report a vulnerability](https://github.com/KarnasZiad/SoukConnect/security/advisories/new).

Indiquez la version ou le commit concerné, les étapes pour reproduire et l'impact estimé. L'objectif
est d'accuser réception sous 72 heures et de publier un correctif accompagné d'un avis de sécurité.

## Périmètre

- Paiement : double encaissement, commande confirmée sans paiement, webhook accepté sans signature
  valide, montant ou commission falsifiés
- Comptes : prise de contrôle de session, contournement du verrouillage, élévation de rôle
- Données : accès aux commandes, adresses ou conversations d'un autre utilisateur ; produit d'un
  autre vendeur modifié
- Front : XSS, redirection ouverte, contournement de la CSP

Le paiement fonctionne en **mode test Stripe** : aucune vraie carte ne doit être utilisée.

## Documentation de sécurité

- [Modèle de menaces](docs/security/threat-model.md)
- [Passerelle, sessions et jetons internes](docs/adr/0006-passerelle-sessions-et-jetons-internes.md)
- [Décisions d'architecture](docs/adr/)
