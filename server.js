require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

const CORS_ORIGIN = process.env.CORS_ORIGIN || true; // true = reflète l'origine de la requête
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

const JWT_SECRET = process.env.JWT_SECRET || 'change-moi-en-production';
const COOKIE_NAME = 'd17_session';

const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const TICKETS_FILE = path.join(__dirname, 'data', 'tickets.json');

function readJson(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function generateCode() {
  const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `D17-${part()}-${part()}`;
}
function generateVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 chiffres
}
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---------- e-mail (optionnel selon config SMTP) ----------
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// envoie le code de vérification à 6 chiffres ; renvoie true si l'e-mail a pu être envoyé
async function sendVerificationEmail(email, name, code) {
  if (!transporter) return false;
  try {
    await transporter.sendMail({
      from: process.env.FROM_EMAIL || process.env.SMTP_USER,
      to: email,
      subject: `Votre code de vérification D17 Events : ${code}`,
      html: `
        <div style="font-family:Arial,sans-serif; max-width:420px; margin:0 auto; color:#0c2942;">
          <h2 style="letter-spacing:1px;">D17 EVENTS</h2>
          <p>Bonjour ${name || ''},</p>
          <p>Voici votre code de vérification pour activer votre compte :</p>
          <p style="text-align:center; font-size:32px; font-weight:700; letter-spacing:6px; margin:24px 0;">${code}</p>
          <p style="color:#5c7994; font-size:12.5px;">Ce code expire dans 15 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.</p>
        </div>
      `,
    });
    return true;
  } catch (err) {
    console.error('Erreur envoi e-mail de vérification:', err.message);
    return false;
  }
}

// ---------- auth : middleware ----------
function authRequired(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Vous devez être connecté." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Session expirée, reconnectez-vous." });
  }
}

function setSessionCookie(res, user) {
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

app.get('/', (req, res) => res.send('D17 Events API — OK'));

// ---------- Inscription (envoie un code de vérification, ne connecte pas encore) ----------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "Le nom est requis." });
    if (!isValidEmail(email)) return res.status(400).json({ error: "Adresse e-mail invalide." });
    if (!password || password.length < 6) return res.status(400).json({ error: "Le mot de passe doit contenir au moins 6 caractères." });

    const users = readJson(USERS_FILE);
    const existing = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (existing && existing.verified) {
      return res.status(409).json({ error: "Un compte existe déjà avec cet e-mail." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const code = generateVerificationCode();
    const user = existing || { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    user.name = name.trim();
    user.email = email.toLowerCase();
    user.passwordHash = passwordHash;
    user.verified = false;
    user.verificationCode = code;
    user.verificationExpires = Date.now() + 15 * 60 * 1000; // 15 minutes

    if (!existing) users.push(user);
    writeJson(USERS_FILE, users);

    const emailSent = await sendVerificationEmail(user.email, user.name, code);
    res.json({
      pendingVerification: true,
      email: user.email,
      // Uniquement si l'e-mail n'a pas pu être envoyé (SMTP non configuré) : renvoie le code pour permettre de tester quand même.
      devCode: emailSent ? undefined : code,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de l'inscription." });
  }
});

// ---------- Vérification du code envoyé par e-mail ----------
app.post('/api/auth/verify', (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!isValidEmail(email) || !code) {
      return res.status(400).json({ error: "E-mail ou code manquant." });
    }
    const users = readJson(USERS_FILE);
    const user = users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
    if (!user) return res.status(404).json({ error: "Compte introuvable." });
    if (user.verified) return res.status(400).json({ error: "Ce compte est déjà vérifié." });
    if (!user.verificationCode || Date.now() > user.verificationExpires) {
      return res.status(400).json({ error: "Code expiré, demandez-en un nouveau." });
    }
    if (String(code).trim() !== user.verificationCode) {
      return res.status(400).json({ error: "Code incorrect." });
    }

    user.verified = true;
    delete user.verificationCode;
    delete user.verificationExpires;
    writeJson(USERS_FILE, users);

    setSessionCookie(res, user);
    res.json({ id: user.id, name: user.name, email: user.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de la vérification." });
  }
});

// ---------- Renvoyer un code de vérification ----------
app.post('/api/auth/resend-code', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!isValidEmail(email)) return res.status(400).json({ error: "Adresse e-mail invalide." });
    const users = readJson(USERS_FILE);
    const user = users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
    if (!user || user.verified) return res.status(400).json({ error: "Aucune vérification en attente pour cet e-mail." });

    const code = generateVerificationCode();
    user.verificationCode = code;
    user.verificationExpires = Date.now() + 15 * 60 * 1000;
    writeJson(USERS_FILE, users);

    const emailSent = await sendVerificationEmail(user.email, user.name, code);
    res.json({ ok: true, devCode: emailSent ? undefined : code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de l'envoi du code." });
  }
});

// ---------- Connexion ----------
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || !password) {
      return res.status(400).json({ error: "E-mail ou mot de passe manquant." });
    }
    const users = readJson(USERS_FILE);
    const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (!user) return res.status(401).json({ error: "E-mail ou mot de passe incorrect." });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "E-mail ou mot de passe incorrect." });

    if (!user.verified) {
      return res.status(403).json({ error: "Compte non vérifié.", needsVerification: true, email: user.email });
    }

    setSessionCookie(res, user);
    res.json({ id: user.id, name: user.name, email: user.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de la connexion." });
  }
});

// ---------- Déconnexion ----------
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// ---------- Utilisateur courant ----------
app.get('/api/auth/me', (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.json(null);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ id: payload.id, name: payload.name, email: payload.email });
  } catch {
    res.json(null);
  }
});

// ---------- Créer une réservation (compte requis) ----------
app.post('/api/reservations', authRequired, async (req, res) => {
  try {
    const { showId, artist, venue, city, date, qty, price, paymentMethod } = req.body || {};
    const email = req.user.email;

    if (!artist || !venue || !city || !date) {
      return res.status(400).json({ error: "Informations du concert manquantes." });
    }
    const quantity = Number(qty);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 8) {
      return res.status(400).json({ error: "Quantité de billets invalide." });
    }
    const unitPrice = Number(price);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return res.status(400).json({ error: "Prix invalide." });
    }
    const allowedMethods = ['bankily', 'masrvi', 'sadad', 'especes'];
    const method = allowedMethods.includes(paymentMethod) ? paymentMethod : 'especes';

    const code = generateCode();
    const total = unitPrice * quantity;
    const qrPayload = `D17EVENTS|${code}|${artist}|${date}|${quantity} billet(s)`;
    const qrDataUrl = await QRCode.toDataURL(qrPayload, { margin: 1, width: 320 });

    const ticket = {
      id: crypto.randomUUID(),
      code,
      showId: showId || null,
      artist, venue, city, date,
      qty: quantity,
      price: unitPrice,
      total,
      userId: req.user.id,
      email,
      qrDataUrl,
      paymentMethod: method,
      paymentStatus: 'en_attente', // à confirmer manuellement tant qu'aucun compte marchand n'est branché
      emailSent: false,
      createdAt: new Date().toISOString(),
    };

    const tickets = readJson(TICKETS_FILE);
    tickets.push(ticket);
    writeJson(TICKETS_FILE, tickets);

    if (transporter) {
      try {
        await transporter.sendMail({
          from: process.env.FROM_EMAIL || process.env.SMTP_USER,
          to: email,
          subject: `Votre billet — ${artist} (${date})`,
          html: `
            <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; color:#0c2942;">
              <h2 style="letter-spacing:1px;">D17 EVENTS</h2>
              <p>Merci pour votre réservation, ${req.user.name} !</p>
              <table style="width:100%; border-collapse:collapse; margin:16px 0; font-size:14px;">
                <tr><td style="padding:6px 0; color:#5c7994;">Concert</td><td style="text-align:right; font-weight:600;">${artist}</td></tr>
                <tr><td style="padding:6px 0; color:#5c7994;">Lieu</td><td style="text-align:right;">${venue}, ${city}</td></tr>
                <tr><td style="padding:6px 0; color:#5c7994;">Date</td><td style="text-align:right;">${date}</td></tr>
                <tr><td style="padding:6px 0; color:#5c7994;">Billets</td><td style="text-align:right;">${quantity}</td></tr>
                <tr><td style="padding:6px 0; color:#5c7994;">Total</td><td style="text-align:right; font-weight:600;">${total.toLocaleString('fr-FR')} MRU</td></tr>
              </table>
              <p style="text-align:center;">
                <img src="${qrDataUrl}" alt="QR code du billet" style="width:220px; height:220px;" />
              </p>
              <p style="text-align:center; font-family:monospace; letter-spacing:1px; color:#5c7994;">${code}</p>
              <p style="color:#5c7994; font-size:12.5px; text-align:center;">Présentez ce code à l'entrée de la salle.</p>
            </div>
          `,
        });
        ticket.emailSent = true;
        const tickets2 = readJson(TICKETS_FILE).map(t => (t.id === ticket.id ? ticket : t));
        writeJson(TICKETS_FILE, tickets2);
      } catch (mailErr) {
        console.error('Erreur envoi e-mail:', mailErr.message);
      }
    }

    res.json(ticket);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Une erreur est survenue lors de la réservation." });
  }
});

// ---------- Billets du compte connecté ----------
app.get('/api/reservations', authRequired, (req, res) => {
  const tickets = readJson(TICKETS_FILE);
  res.json(tickets.filter(t => t.userId === req.user.id));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`D17 Events API en écoute sur le port ${PORT}`);
  console.log(transporter ? "Envoi d'e-mail : activé" : "Envoi d'e-mail : désactivé (SMTP non configuré)");
});
