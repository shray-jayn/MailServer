import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import nodemailer from 'nodemailer';

const app = express();

// --- Security & body parsing ---
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', 1);
app.use(cors({
    origin: (origin, cb) => {
        const allow = (process.env.ALLOWED_ORIGIN || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
        // Allow no-origin (e.g., curl) and listed origins
        if (!origin || allow.includes(origin)) return cb(null, true);
        return cb(new Error('CORS blocked from origin: ' + origin));
    }
}));

// --- Rate limit (per IP) ---
app.use('/api/', rateLimit({ windowMs: 60_000, max: 20 }));

// --- Nodemailer transporter (Mailcow) ---
const transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST,       // mail.crunchstudy.com
    port: Number(process.env.MAIL_PORT || 587),
    secure: false,                     // STARTTLS on 587
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
    requireTLS: true,                  // force upgrade to TLS
    tls: {
        // ⚠️ TEMPORARY until you install a valid cert:
        rejectUnauthorized: false,       // accept self-signed
        servername: process.env.MAIL_HOST // ensure SNI is set
    }
});

// Verify SMTP on boot (logs only)
transporter.verify().then(() => {
    console.log('SMTP ready.');
}).catch(err => {
    console.error('SMTP verify failed:', err.message);
});

// --- Helpers ---
const isEmail = (v = '') => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const nowISO = () => new Date().toISOString();

// --- Healthcheck ---
app.get('/health', (_req, res) => res.json({ ok: true, time: nowISO() }));

// --- Send estimate endpoint ---
app.post('/api/send-estimate', async (req, res) => {
    try {
        const { name, email, phone, city, type, message } = req.body || {};

        // Basic validation
        if (!name || !email || !phone || !city) {
            return res.status(400).json({ ok: false, error: 'MISSING_FIELDS' });
        }
        if (!isEmail(email)) {
            return res.status(400).json({ ok: false, error: 'INVALID_EMAIL' });
        }

        const FROM_NAME = process.env.FROM_NAME || 'Website';
        const FROM_ADDR = process.env.MAIL_USER; // no-reply@patioblindsdirect.com
        const LEADS_TO = process.env.LEADS_TO || 'joe@patioblindsdirect.com';

        // 1) Internal lead to Joe (DMARC-aligned From; reply goes to submitter)
        const internal = await transporter.sendMail({
            from: `"${FROM_NAME}" <${FROM_ADDR}>`,
            to: LEADS_TO,
            replyTo: email,
            subject: `New Estimate — ${name} (${city})`,
            text: [
                `Name: ${name}`,
                `Email: ${email}`,
                `Phone: ${phone}`,
                `City: ${city}`,
                `Type: ${type || '—'}`,
                `Message: ${message || '—'}`,
                `Submitted: ${nowISO()}`
            ].join('\n')
        });

        // 2) Auto-reply to submitter (reply goes to Joe)
        const autoresp = await transporter.sendMail({
            from: `"${FROM_NAME}" <${FROM_ADDR}>`,
            to: email,
            replyTo: LEADS_TO,
            subject: 'We received your estimate request — Patio Blinds Direct',
            html: `
        <div style="font-family:Inter,system-ui,Arial,sans-serif;line-height:1.6;color:#111">
          <h2 style="margin:0 0 8px">Thanks, ${name}!</h2>
          <p>We received your request for a free estimate. A specialist will contact you shortly.</p>
          <p><strong>Summary</strong><br>
          Phone: ${phone}<br>
          City: ${city}<br>
          Blind Type: ${type || '—'}<br>
          Message: ${message ? String(message).replace(/[<>]/g, '') : '—'}</p>
          <p>Questions? Reply to this email or call (626) 430-4003.</p>
          <p style="color:#6b7280">Patio Blinds Direct • Serving all Southern California</p>
        </div>
      `
        });

        return res.json({ ok: true, leadId: internal.messageId, autoId: autoresp.messageId });
    } catch (err) {
        console.error('MAIL_SEND_FAILED:', err);
        return res.status(500).json({ ok: false, error: 'MAIL_SEND_FAILED' });
    }
});

// --- Start server ---
const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => console.log(`Mail API listening on http://localhost:${PORT}`));
