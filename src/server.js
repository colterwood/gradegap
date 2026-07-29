import express from 'express';
import { config } from './config.js';
import { openDb } from './db/db.js';
import { makeQueries } from './db/queries.js';
import { createSyncManager } from './sync/syncRunner.js';
import { makeApiRouter } from './routes/api.js';

// Players are discovered from the Ladder crawl itself, so there's no config
// seeding here anymore; config/players.json is only an optional allowlist.
const db = openDb();
const q = makeQueries(db);
const syncManager = createSyncManager(db, q);

const app = express();
app.use(express.json());
app.use('/api', makeApiRouter(db, q, syncManager));
app.use(express.static(config.publicDir));

app.listen(config.port, '127.0.0.1', () => {
  console.log(`GradeGap running at http://localhost:${config.port}${config.mock ? '  (MOCK mode)' : ''}`);
});
