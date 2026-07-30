// One-shot email test: `npm run test-email`. Sends a test message using the
// EMAIL_TO / GMAIL_USER / GMAIL_APP_PASSWORD settings in .env so you can
// prove delivery works before relying on Following-tab alerts.

import { config } from '../src/config.js';
import { sendEmail, emailConfigured } from '../src/marketplace/notify.js';

if (!emailConfigured()) {
  console.error(
    'Email is not configured. Set all three in .env:\n' +
      `  EMAIL_TO            ${config.emailTo ? 'set' : 'MISSING'}\n` +
      `  GMAIL_USER          ${config.gmailUser ? 'set' : 'MISSING'}\n` +
      `  GMAIL_APP_PASSWORD  ${config.gmailAppPassword ? 'set' : 'MISSING'} (App Password, not your Gmail password —\n` +
      '                      create at https://myaccount.google.com/apppasswords)'
  );
  process.exit(1);
}

console.log(`Sending a test email from ${config.gmailUser} to ${config.emailTo}…`);
const ok = await sendEmail({
  subject: 'GradeGap test email',
  text: 'Email alerts are working. Followed-listing notifications (24h-left auctions, Buy It Now price drops) will arrive here.',
});
if (ok) {
  console.log('Sent — check the inbox (and spam, the first time).');
} else {
  console.error(
    'Send FAILED. Usual causes: wrong App Password, 2-Step Verification not\n' +
      'enabled on the Google account, or GMAIL_USER is not the full address.'
  );
  process.exit(1);
}
