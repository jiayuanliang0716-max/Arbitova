'use strict';
/**
 * src/path_b/mailer.js
 *
 * Thin wrapper that reuses the Brevo SMTP config already present in the Path A
 * environment (BREVO_SMTP_KEY + BREVO_SMTP_NAME). Creates a fresh transporter
 * per call to stay stateless and avoid connection-state issues across long-lived
 * processes.
 *
 * DO NOT import this from any Path A file.
 */

const nodemailer = require('nodemailer');

const FROM_ADDRESS = '"Arbitova Escrow" <dev@arbitova.com>';

async function sendMail({ to, subject, text, html }) {
  const key = process.env.BREVO_SMTP_KEY;
  const user = process.env.BREVO_SMTP_NAME;

  if (!key || !user) {
    console.warn('[path_b/mailer] BREVO_SMTP_KEY / BREVO_SMTP_NAME not set — skipping email to', to);
    return { skipped: true };
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    auth: { user, pass: key },
  });

  const info = await transporter.sendMail({
    from: FROM_ADDRESS,
    to,
    subject,
    text,
    html: html || `<pre>${text}</pre>`,
  });

  console.log(`[path_b/mailer] sent to ${to} — messageId=${info.messageId}`);
  return info;
}

module.exports = { sendMail };
