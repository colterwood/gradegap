// Phone push via ntfy.sh — a plain HTTP POST to a topic, no account or SDK.
// The generic watcher sends AGGREGATE messages only ("7 new listings…");
// the Following tab's alerts are the one deliberate exception (per-item,
// each linking straight to its listing). An empty NTFY_TOPIC disables
// pushes entirely; failures return false so callers can leave listings
// unnotified and retry next run.

import { config } from '../config.js';

export async function sendNtfy({ title, message, clickUrl, priority = 'default' }) {
  if (!config.ntfyTopic) return false;
  const url = `${config.ntfyServer.replace(/\/+$/, '')}/${encodeURIComponent(config.ntfyTopic)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: message,
      headers: {
        Title: title,
        Priority: priority,
        ...(clickUrl ? { Click: clickUrl } : {}),
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Email via Gmail SMTP (nodemailer + a Google App Password). Following-tab
// alerts only. Missing config disables it silently — sendEmail returns
// false and callers treat it exactly like a failed ntfy push.
let transporterPromise = null;

export const emailConfigured = () =>
  Boolean(config.gmailUser && config.gmailAppPassword && config.emailTo);

async function getTransporter() {
  if (!transporterPromise) {
    // Lazy import: nodemailer never loads unless email is actually used.
    transporterPromise = import('nodemailer').then((m) =>
      (m.default ?? m).createTransport({
        service: 'gmail',
        auth: { user: config.gmailUser, pass: config.gmailAppPassword },
      })
    );
  }
  return transporterPromise;
}

export async function sendEmail({ subject, text }) {
  if (!emailConfigured()) return false;
  try {
    const transporter = await getTransporter();
    await transporter.sendMail({
      from: `GradeGap <${config.gmailUser}>`,
      to: config.emailTo,
      subject,
      text,
    });
    return true;
  } catch {
    return false;
  }
}
