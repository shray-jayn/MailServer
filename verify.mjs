import 'dotenv/config';
import nodemailer from 'nodemailer';

const tx = nodemailer.createTransport({
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
try {
    await tx.verify();
    console.log('✅ SMTP ready');
    const info = await tx.sendMail({
        from: `"${process.env.FROM_NAME || 'Website'}" <${process.env.MAIL_USER}>`,
        to: process.env.LEADS_TO,
        subject: 'SMTP test',
        text: 'Hello from the mail server.',
    });
    console.log('✅ Test mail sent:', info.messageId);
} catch (e) {
    console.error('❌ SMTP failed:', e);
}