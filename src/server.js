import express from 'express';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { openDb } from './db/db.js';
import { makeQueries } from './db/queries.js';
import { createSyncManager } from './sync/syncRunner.js';
import { createWatchRunner } from './marketplace/watchRunner.js';
import { makeApiRouter } from './routes/api.js';
import { makeWatchRouter } from './routes/watchApi.js';

// Last-resort guards. Node's default for an unhandled rejection is to KILL
// the process — one stray async error in a scraper event handler or a
// notification push would take the whole server down mid-check, with the
// stack lost unless someone was watching the terminal. Log loudly, append
// to data/errors.log (survives the console), and keep serving: for a local
// single-user app, staying up beats dying silently.
function logFatal(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind}: ${err?.stack ?? err}\n`;
  console.error(line.trimEnd());
  try {
    appendFileSync(path.join(config.dataDir, 'errors.log'), line);
  } catch {
    /* data dir missing — console already has it */
  }
}
process.on('unhandledRejection', (err) => logFatal('unhandledRejection', err));
process.on('uncaughtException', (err) => logFatal('uncaughtException', err));

// Players are discovered from the Ladder crawl itself, so there's no config
// seeding here anymore; config/players.json is only an optional allowlist.
const db = openDb();
const q = makeQueries(db);
const syncManager = createSyncManager(db, q);
const watchRunner = createWatchRunner(db, q, { syncManager });

const app = express();
app.use(express.json());
app.use('/api', makeApiRouter(db, q, syncManager));
app.use('/api', makeWatchRouter(db, q, watchRunner));
app.use(express.static(config.publicDir));

// One listener per configured interface (BIND_HOST may list several).
let announced = false;
for (const host of config.bindHosts) {
  const server = app.listen(config.port, host, () => {
    if (!announced) {
      console.log(`GradeGap running at http://localhost:${config.port}${config.mock ? '  (MOCK mode)' : ''}`);
      // Checks run on a timer while the server is up (0 = manual only).
      watchRunner.startScheduler();
      announced = true;
    }
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.log(`  also listening on ${host}:${config.port} — this app has NO login, so only`);
      console.log('  expose interfaces you trust (a Tailscale IP is private; 0.0.0.0 is your whole LAN).');
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRNOTAVAIL') {
      console.error(`\nCannot bind ${host}:${config.port} — that address doesn't exist on this machine.`);
      console.error('If it is your Tailscale IP, make sure Tailscale is connected (`tailscale ip -4`).');
    } else if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${config.port} is already in use on ${host} — is GradeGap already running?`);
    } else {
      console.error(`\nFailed to listen on ${host}:${config.port}: ${err.message}`);
    }
    process.exit(1);
  });
}
