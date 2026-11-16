import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';

const db = openDb(config.dbPath);
const { app, scans } = createApp({ db, config, log: (m) => console.log(`[overpass] ${m}`) });

const server = app.listen(config.port, () => {
  console.log(`Overpass Tag Hunter listening on http://localhost:${config.port}`);
  console.log(`  overpass: ${[config.overpassUrl, ...config.overpassFallbackUrls].join(', ')}`);
  console.log(`  database: ${config.dbPath}`);
});

function shutdown() {
  scans.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
