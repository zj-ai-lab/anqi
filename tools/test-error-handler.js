import assert from 'node:assert/strict';
import { errorHandler } from '../src/middleware/errors.js';

function responseDouble(headersSent = false) {
  return {
    headersSent,
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const oldEnv = process.env.NODE_ENV;
const oldConsoleError = console.error;
const logged = [];
console.error = (...args) => logged.push(args);
try {
  process.env.NODE_ENV = 'production';
  const production = responseDouble();
  errorHandler(new Error('SQLITE_ERROR at /private/case-data.db'), {}, production, () => {});
  assert.equal(production.statusCode, 500);
  assert.equal(production.body.error, 'server error');
  assert.equal(production.body.code, 'internal_error');
  assert.match(production.body.error_id, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(JSON.stringify(production.body), /SQLITE|private|case-data/);
  assert.match(String(logged[0][1]), /SQLITE_ERROR/);

  const client = responseDouble();
  const syntax = new Error('Unexpected token reveals request fragment');
  syntax.status = 400;
  errorHandler(syntax, {}, client, () => {});
  assert.deepEqual(
    { status: client.statusCode, error: client.body.error, code: client.body.code },
    { status: 400, error: 'bad request', code: 'bad_request' }
  );
  assert.doesNotMatch(JSON.stringify(client.body), /Unexpected token|fragment/);

  process.env.NODE_ENV = 'test';
  const development = responseDouble();
  errorHandler(new Error('developer detail'), {}, development, () => {});
  assert.equal(development.body.error, 'developer detail');

  const sent = responseDouble(true);
  const original = new Error('stream failed');
  let forwarded;
  errorHandler(original, {}, sent, (error) => { forwarded = error; });
  assert.equal(forwarded, original);
} finally {
  console.error = oldConsoleError;
  if (oldEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = oldEnv;
}

console.log('error handler tests: production redaction + correlation id + development detail passed');
