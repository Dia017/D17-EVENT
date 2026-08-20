# D17 Events — Backend

API qui gère les réservations : génère un code + QR code, envoie l'e-mail de confirmation, et
sauvegarde les billets pour que le panier soit persistant (retrouvable par e-mail).

## 1. Installation en local

```bash
cd backend
npm install
cp .env.example .env
```

Ouvrez `.env` et renseignez vos identifiants SMTP (voir section Gmail ci-dessous).
Vous pouvez aussi laisser SMTP vide pour tester sans envoi d'e-mail : la réservation,
le QR code et le panier fonctionneront quand même, seul l'e-mail ne partira pas.

```bash
npm start
```

Le serveur tourne sur `http://localhost:3000`.

## 2. Configurer l'envoi d'e-mail avec Gmail (gratuit)

1. Allez sur https://myaccount.google.com/security et activez la **validation en 2 étapes**.
2. Allez sur https://myaccount.google.com/apppasswords et créez un **mot de passe d'application**.
3. Dans `.env` :
   - `SMTP_USER` = votre adresse Gmail
   - `SMTP_PASS` = le mot de passe d'application généré (pas votre mot de passe Gmail)

Alternative recommandée pour un vrai lancement : un service transactionnel comme
**Resend**, **Mailgun** ou **SendGrid** (meilleure délivrabilité que Gmail à grande échelle).
Ils fournissent aussi des identifiants SMTP compatibles avec ce même fichier `.env`.

## 3. Déployer en ligne (gratuit, recommandé : Render)

1. Créez un compte sur https://render.com
2. Créez un dépôt Git (GitHub) contenant ce dossier `backend/`
3. Sur Render : **New > Web Service**, connectez le dépôt
4. Build command : `npm install` — Start command : `npm start`
5. Dans l'onglet **Environment**, ajoutez les mêmes variables que dans `.env`
6. Déployez — Render vous donne une URL du type `https://d17events-backend.onrender.com`

⚠️ Sur le plan gratuit de Render, le stockage des fichiers (`data/tickets.json`) est
réinitialisé à chaque redéploiement. Pour un vrai lancement, prévoyez une base de données
(Render PostgreSQL gratuit, par exemple) — je peux vous aider à migrer si besoin.

## 4. Connecter le site

Dans le fichier du site (`d17events.html`), tout en haut du `<script>`, remplacez :

```js
const API_BASE = 'https://VOTRE-BACKEND.onrender.com';
```

par l'URL réelle de votre backend une fois déployé.

## Points de terminaison de l'API

- `POST /api/reservations` — crée une réservation
  Corps attendu : `{ showId, artist, venue, city, date, qty, price, email }`
  Retourne le billet créé, incluant `code` et `qrDataUrl`.

- `GET /api/reservations?email=...` — retourne tous les billets liés à cet e-mail
