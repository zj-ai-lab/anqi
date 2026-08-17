import assert from 'node:assert/strict';
import express from 'express';
import { resolveTrustProxy } from '../src/lib/trust-proxy.js';

assert.deepEqual(resolveTrustProxy(), ['loopback', 'linklocal', 'uniquelocal']);
assert.equal(resolveTrustProxy('1'), 1);
assert.equal(resolveTrustProxy('false'), false);
assert.deepEqual(resolveTrustProxy('loopback, 10.0.0.0/8'), ['loopback', '10.0.0.0/8']);
assert.throws(() => resolveTrustProxy('true'), /不得设为 true/);
assert.throws(() => resolveTrustProxy('11'), /不得大于 10/);

async function probe(trustProxy, headers) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.get('/', (req, res) => res.json({ ip: req.ip, secure: req.secure }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers });
    return response.json();
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const trusted = await probe(resolveTrustProxy(), {
  'X-Forwarded-For': '198.51.100.8, 203.0.113.9',
  'X-Forwarded-Proto': 'https',
  'X-Real-IP': '192.0.2.77',
});
assert.deepEqual(trusted, { ip: '203.0.113.9', secure: true });

const untrusted = await probe(false, {
  'X-Forwarded-For': '198.51.100.8',
  'X-Forwarded-Proto': 'https',
  'X-Real-IP': '192.0.2.77',
});
assert.match(untrusted.ip, /127\.0\.0\.1$/);
assert.equal(untrusted.secure, false);

console.log('trust proxy tests: explicit policy + req.ip/req.secure behavior passed');
