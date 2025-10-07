import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import nodemailer from 'nodemailer';

const app = express();

/* -------------------- Proxy / security / parsing -------------------- */
// Behind Cloudflare/cloudflared: respect X-Forwarded-* (required for rate-limit & correct IPs)
app.set('trust proxy', 1);

// Helmet (keep CORP off for now since API returns JSON only)
app.use(helmet({ crossOriginResourcePolicy: false }));

app.use(express.json({ limit: '1mb' }));

// CORS: allow curl/no-origin + explicit origins from env
app.use(
    cors({
        origin: (origin, cb) => {
            const allow = (process.env.ALLOWED_ORIGIN || '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            if (!origin || allow.includes(origin)) return cb(null, true);
            return cb(new Error('CORS blocked from origin: ' + origin));
        },
        methods: ['GET', 'POST', 'OPTIONS'],
    })
);

/* --------------------------- Rate limiting -------------------------- */
// Keep conservative limits; works correctly now that trust proxy is set
app.use(
    '/api/',
    rateLimit({
        windowMs: 60_000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false,
        skipFailedRequests: true, // don't count timeouts/5xx
    })
);

/* ----------------------- Nodemailer transporter --------------------- */
// Create once; use short timeouts so requests never hang
const transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST, // e.g. mail.crunchstudy.com
    port: Number(process.env.MAIL_PORT || 587),
    secure: false, // STARTTLS on 587
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
    requireTLS: true,
    // Fast timeouts so API returns promptly even if SMTP unreachable
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000,
    tls: {
        // TEMPORARY until a valid cert is in place; remove when not needed
        rejectUnauthorized: false,
        servername: process.env.MAIL_HOST,
    },
});

// Verify SMTP asynchronously (log only; do not block startup)
transporter
    .verify()
    .then(() => console.log('SMTP ready.'))
    .catch((err) => console.error('SMTP verify failed:', err.message));

/* ------------------------------- Utils ------------------------------ */
const isEmail = (v = '') => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const nowISO = () => new Date().toISOString();

// Small helper to enforce max time per send (defensive)
async function sendWithTimeout(sendPromise, ms = 6000) {
    let to;
    const timeout = new Promise((_, rej) => {
        to = setTimeout(() => rej(new Error('SMTP_TIMEOUT')), ms);
    });
    try {
        return await Promise.race([sendPromise, timeout]);
    } finally {
        clearTimeout(to);
    }
}

/* ---------------------------- Healthcheck --------------------------- */
app.get('/health', (_req, res) => res.json({ ok: true, time: nowISO() }));

/* ------------------------ Send estimate route ----------------------- */
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

        // During bring-up/testing, you can skip email entirely:
        if (process.env.DISABLE_EMAIL === 'true') {
            return res.status(200).json({
                ok: true,
                note: 'email disabled',
                submittedAt: nowISO(),
            });
        }

        const FROM_NAME = process.env.FROM_NAME || 'Website';
        const FROM_ADDR = process.env.MAIL_USER; // e.g., no-reply@patioblindsdirect.com
        const LEADS_TO = process.env.LEADS_TO || 'joe@patioblindsdirect.com';

        const internalText = [
            `Name: ${name}`,
            `Email: ${email}`,
            `Phone: ${phone}`,
            `City: ${city}`,
            `Type: ${type || '—'}`,
            `Message: ${message || '—'}`,
            `Submitted: ${nowISO()}`,
        ].join('\n');

        // 1) Internal lead to Joe (DMARC-aligned From; reply goes to submitter)
        const internalP = transporter.sendMail({
            from: `"${FROM_NAME}" <${FROM_ADDR}>`,
            to: LEADS_TO,
            replyTo: email,
            subject: `New Estimate — ${name} (${city})`,
            text: internalText,
        });

        // 2) Auto-reply to submitter (reply goes to Joe)
        const autorespP = transporter.sendMail({
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
      `,
        });

        // Enforce per-send timeouts so we never hang the request
        const [internal, autoresp] = await Promise.all([
            sendWithTimeout(internalP, 7000),
            sendWithTimeout(autorespP, 7000),
        ]);

        return res.json({
            ok: true,
            leadId: internal?.messageId || null,
            autoId: autoresp?.messageId || null,
        });
    } catch (err) {
        console.error('MAIL_SEND_FAILED:', err);
        // Do not hang; return a clear failure quickly
        const code = err?.message === 'SMTP_TIMEOUT' ? 504 : 502;
        return res.status(code).json({ ok: false, error: 'MAIL_SEND_FAILED' });
    }
});

/* ----------------------------- Boot server -------------------------- */
const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () =>
    console.log(`Mail API listening on http://localhost:${PORT}`)
);
