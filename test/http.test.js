// -----------------------------------------------------------------------------
// The real transport (node:http) and the client against local servers: our
// User-Agent, the API key in its header only, a JSON POST, nothing written
// when beforeSend refuses, size cap before the end, deadlines, one
// connection at a time, a stop that cuts a stuck read, answers that are not
// a JSON object.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { httpRequest } from '../src/emsesp/http.js';
import { EmsClient } from '../src/emsesp/client.js';
import { CODES } from '../src/emsesp/errors.js';
import { TOKEN } from './fixtures/emsesp.js';
import { blackhole, httpServer, refusePort, reply } from './kit/index.mjs';

const base = (port, extra = {}) => ({
  host: '127.0.0.1',
  port,
  path: '/api/system',
  timeout: 2000,
  maxBytes: 64 * 1024,
  ...extra,
});

const failure = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('resolved');
};

test('a GET with our User-Agent, JSON accepted, no keep-alive, no key unless given', async (t) => {
  const srv = await httpServer({ routes: { '/api/system': { system: { version: '3.9.0' } } } });
  t.after(() => srv.close());
  const answer = await httpRequest(base(srv.port));
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.body), { system: { version: '3.9.0' } });
  const [request] = srv.requests;
  assert.match(
    request.headers['user-agent'],
    /^gladys-ems-esp\/0\.1\.0 \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-ems-esp\)$/,
  );
  assert.equal(request.headers.accept, 'application/json');
  assert.equal(request.headers.connection, 'close');
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.headers['content-type'], undefined);
});

test('a POST sends { value } as JSON with the key in its header, and nothing else', async (t) => {
  const srv = await httpServer({ routes: { 'POST /api/boiler/dhw/activated': {} } });
  t.after(() => srv.close());
  const client = new EmsClient({ host: '127.0.0.1', port: srv.port, token: TOKEN });
  await client.post('/api/boiler/dhw/activated', 'off');
  const [request] = srv.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/boiler/dhw/activated', 'never the key in the URL');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(request.body), { value: 'off' });
  client.close();
});

test('beforeSend refusing: not one byte written', async (t) => {
  const hole = await blackhole();
  t.after(() => hole.close());
  const err = await failure(
    httpRequest(
      base(hole.port, {
        method: 'POST',
        body: 'abc',
        beforeSend: () => {
          throw new Error('option off');
        },
      }),
    ),
  );
  assert.equal(err.message, 'option off');
  assert.equal(err.beforeSend, true);
  assert.equal(err.sent, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hole.received, 0);
  assert.equal(hole.open, 0, 'the socket closed');
});

test('an answer larger than allowed is cut before its end', async (t) => {
  const srv = await httpServer({ routes: { '/api/system': { value: 1 } }, bigBody: 200_000 });
  t.after(() => srv.close());
  const err = await failure(httpRequest(base(srv.port)));
  assert.equal(err.code, CODES.TOO_LARGE);
  assert.equal(err.sent, true);
  const declared = await httpServer({
    routes: { '/api/system': reply(200, 'x', { 'content-length': '999999' }) },
  });
  t.after(() => declared.close());
  assert.equal((await failure(httpRequest(base(declared.port)))).code, CODES.TOO_LARGE);
});

test('a silent gateway: timeout, sent; a refused port: unreachable, not sent', async (t) => {
  const hole = await blackhole();
  t.after(() => hole.close());
  const err = await failure(httpRequest(base(hole.port, { timeout: 200 })));
  assert.equal(err.code, CODES.TIMEOUT);
  assert.equal(err.sent, true);
  assert.equal(hole.open, 0, 'closed before settling');
  const port = await refusePort();
  const refused = await failure(httpRequest(base(port)));
  assert.equal(refused.code, CODES.UNREACHABLE);
  assert.equal(refused.sent, false);
});

test('an abort settles once the socket is closed', async (t) => {
  const hole = await blackhole();
  t.after(() => hole.close());
  const controller = new AbortController();
  const pending = failure(httpRequest(base(hole.port, { signal: controller.signal })));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hole.open, 1);
  controller.abort();
  const err = await pending;
  assert.equal(err.code, CODES.ABORTED);
  assert.equal(err.sent, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hole.open, 0);
});

test('the client: one connection at a time, the stop first, a stuck read cut', async (t) => {
  let open = 0;
  let peak = 0;
  const seen = [];
  const server = createServer((req, res) => {
    open += 1;
    peak = Math.max(peak, open);
    res.on('close', () => {
      open -= 1;
    });
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    if (req.url === '/api/thermostat') {
      return; // stuck: never answers
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    }, 20);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.on('connection', (socket) => t.after(() => socket.destroy()));
  const client = new EmsClient({ host: '127.0.0.1', port: server.address().port, token: TOKEN });
  const a = client.get('/api/system');
  const b = failure(client.get('/api/thermostat'));
  const c = client.get('/api/system');
  await a;
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The read is stuck; c waits behind it; the stop cuts it and leaves first.
  await client.stop('/api/boiler/dhw/activated', 'off');
  assert.equal((await b).code, CODES.ABORTED);
  await c;
  assert.deepEqual(seen, [
    'GET /api/system',
    'GET /api/thermostat',
    'POST /api/boiler/dhw/activated',
    'GET /api/system',
  ]);
  assert.equal(peak, 1, 'never two connections');
  client.close();
});

test('the client: no JSON object, an HTTP 401 or 404, a bad path never leaves', async (t) => {
  const srv = await httpServer({
    routes: {
      '/api/system': reply(200, '<html>'),
      '/api/boiler': reply(200, '[1,2]'),
      '/api/thermostat': reply(200, 'null'),
      '/api/boiler/dhw/seltemp': reply(401, '{"message":"unauthorized"}'),
    },
  });
  t.after(() => srv.close());
  const client = new EmsClient({ host: '127.0.0.1', port: srv.port, token: TOKEN });
  assert.equal((await failure(client.get('/api/system'))).code, CODES.BAD_ANSWER);
  assert.equal((await failure(client.get('/api/boiler'))).code, CODES.BAD_ANSWER);
  assert.equal((await failure(client.get('/api/thermostat'))).code, CODES.BAD_ANSWER);
  const denied = await failure(client.get('/api/boiler/dhw/seltemp'));
  assert.equal(denied.code, CODES.HTTP);
  assert.equal(denied.status, 401);
  const missing = await failure(client.get('/api/mixer'));
  assert.equal(missing.code, CODES.HTTP);
  assert.equal(missing.status, 404);
  for (const path of ['/api/a/../b', '/api/a?x=1', '/rest/signIn', '/api/Boiler', '/api/a/b/c/d']) {
    assert.equal((await failure(client.get(path))).code, CODES.BAD_ANSWER, path);
  }
  assert.equal(srv.requests.length, 5, 'a bad path never leaves');
  assert.ok(!Object.keys(client).includes('authorization'), 'the key is not enumerable');
  const strings = Object.values(client).filter((v) => typeof v === 'string');
  assert.ok(!strings.some((v) => v.includes(TOKEN)));
  client.close();
});

test('a connection not up within sendWithin: LATE, nothing written, settled at once', async () => {
  const { EventEmitter } = await import('node:events');
  let written = false;
  let destroyed = false;
  // A connection that never comes up (no 'socket' event).
  const request = () => {
    const req = new EventEmitter();
    req.end = () => {
      written = true;
    };
    req.destroy = () => {
      destroyed = true;
    };
    return req;
  };
  const at = performance.now();
  const err = await failure(
    httpRequest({
      ...base(1, { timeout: 5000, sendWithin: 100 }),
      method: 'POST',
      body: 'x',
      request,
    }),
  );
  assert.equal(err.code, CODES.LATE);
  assert.equal(err.sent, false);
  assert.equal(written, false);
  assert.equal(destroyed, true);
  assert.ok(performance.now() - at < 1000, 'well before the 5 s deadline');
});
