import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import { createImHub } from '../src/lib/im/hub.js';
const db = new Database(':memory:'); runMigrations(db);
let constructed = 0; const hub = createImHub({ db, supervisor: {}, env: {}, transportFactory: () => { constructed += 1; throw new Error('must remain disabled'); } });
await hub.start(); assert.equal(hub.status().connection.state, 'disabled'); assert.equal(constructed, 0); await hub.stop(); db.close(); console.log('IM hub disabled zero-external-call guard passed');
