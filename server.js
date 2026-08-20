require('dotenv').config();
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'data', 'tickets.json');

function readTickets() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeTickets(tickets) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(tickets, null, 2));
}

function generateCode() {
  const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `D17-${part()}-${part()}`;
}

// Le transporteur d'e-mail n'est créé que si les identifiants SMTP sont configurés.
// Sans configuration, le serveur fonctionne quand même (réservation + QR + stockage)
// mais l'e-mail n'est simplement pas envoyé — utile pour tester avant de brancher un vrai compte mail.
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

app.get('/', (req, res) => {
  res.send('D17 Events API — OK');
});

// Créer une réservation : génère le code + QR, l'enregistre, envoie l'e-mail si configuré
app.post('/api/reservations', async (req, res) => {
  try {
    const { showId, artist, venue, city, date, qty, price, email } = req.body || {};

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Adresse e-mail invalide." });
    }
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
      email,
      qrDataUrl,
      emailSent: false,
      createdAt: new Date().toISOString(),
    };

    const tickets = readTickets();
    tickets.push(ticket);
    writeTickets(tickets);

    if (transporter) {
      try {
        await transporter.sendMail({
          from: process.env.FROM_EMAIL || process.env.SMTP_USER,
          to: email,
          subject: `Votre billet — ${artist} (${date})`,
          html: `
            <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; color:#0c2942;">
              <h2 style="letter-spacing:1px;">D17 EVENTS</h2>
              <p>Merci pour votre réservation !</p>
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
        const tickets2 = readTickets().map(t => (t.id === ticket.id ? ticket : t));
        writeTickets(tickets2);
      } catch (mailErr) {
        console.error('Erreur envoi e-mail:', mailErr.message);
        // La réservation reste valide même si l'e-mail échoue ; le billet est visible dans le panier.
      }
    }

    res.json(ticket);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Une erreur est survenue lors de la réservation." });
  }
});

// Récupérer les billets d'un e-mail donné (panier persistant)
app.get('/api/reservations', (req, res) => {
  const { email } = req.query;
  const tickets = readTickets();
  if (email) {
    return res.json(
      tickets.filter(t => t.email.toLowerCase() === String(email).toLowerCase())
    );
  }
  res.json(tickets);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`D17 Events API en écoute sur le port ${PORT}`);
  console.log(transporter ? 'Envoi d\'e-mail : activé' : 'Envoi d\'e-mail : désactivé (SMTP non configuré)');
});
