// Send a test push: `npm run test-notify`
//
// Verifies the whole notification path (config -> ntfy -> your phone)
// without waiting for a real listing to show up.

import { config } from '../src/config.js';
import { sendNtfy } from '../src/marketplace/notify.js';

if (!config.ntfyTopic) {
  console.error('NTFY_TOPIC is empty — set it in .env, then restart. See the README Configuration reference.');
  process.exit(1);
}

const server = config.ntfyServer.replace(/\/+$/, '');
console.log(`sending a test push to ${server}/${config.ntfyTopic} …`);

const ok = await sendNtfy({
  title: 'GradeGap test',
  message: 'Notifications are wired up correctly — real alerts will look like this.',
  clickUrl: `http://localhost:${config.port}/#listings`,
});

if (ok) {
  console.log('sent. Check your phone — if nothing arrives, make sure the ntfy app is');
  console.log('subscribed to exactly this topic (they are case-sensitive).');
} else {
  console.error('failed to send. Check the topic name, NTFY_SERVER, and your network.');
  process.exit(1);
}
process.exit(0);
