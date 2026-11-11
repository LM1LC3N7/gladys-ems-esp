// -----------------------------------------------------------------------------
// The app on the REAL clock (sped up 20 times: performance.now, Date.now and
// the timers move by themselves) and a real local HTTP server playing
// EMS-ESP (the answers of the fake of test/fixtures): the reads come at the
// measured interval, never sooner; a stop cuts a stuck read and leaves at
// once.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EmsApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { identityKey } from '../src/model.js';
import { TOKEN, fakeEmsEsp } from './fixtures/emsesp.js';
import { httpServer, measurePeriod, realClock, reply, spyOn } from './kit/index.mjs';

const SPEED = 20;
const INTERVAL = 30_000;
const DHW_MODE = '/api/boiler/dhw/activated';
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function boot(t, { stuck } = {}) {
  const dev = fakeEmsEsp({ timers: globalThis });
  // Real milliseconds: 50 ms here is 1 s of the app's clock (x20).
  dev.applyDelay = 50;
  const routes = {};
  const answer = (path, method) => (request) => {
    if (method === 'GET' && stuck?.(path)) {
      return 'silent';
    }
    const out = dev.answer(path, method, request.body, request.headers);
    return reply(out.status, out.body, { 'content-type': 'application/json' });
  };
  for (const path of [
    '/api/system',
    '/api/boiler',
    '/api/thermostat',
    ...Object.keys(dev.entities),
  ]) {
    routes[`GET ${path}`] = answer(path, 'GET');
  }
  routes[`POST ${DHW_MODE}`] = answer(DHW_MODE, 'POST');
  const srv = await httpServer({ latencyMs: 5, routes });
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({ selector: 'ems-esp-test', config: {} });
  await gladys.connect();
  const app = new EmsApp({
    gladys,
    logger: quiet,
    store: memoryStore(),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  // After connect(): the commands reach the app, the start is the test's.
  registerHandlers(gladys, app, quiet);
  t.after(async () => {
    await app.stop();
    clock.close();
    await srv.close();
  });
  const config = {
    address: `127.0.0.1:${srv.port}`,
    token: TOKEN,
    poll_interval: INTERVAL / 1000,
  };
  return { srv, clock, gladys, app, config, dev };
}

test('real clock x20: a read at once, then every interval (measured), timers bounded', async (t) => {
  const { clock, app, config, gladys } = await boot(t);
  const spy = spyOn(app, 'read', clock);
  await app.connected(async () => config);
  const gaps = await measurePeriod(spy, { count: 4, period: INTERVAL });
  assert.equal(gaps.length, 3);
  assert.ok(clock.timersSet < 60, `${clock.timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('real clock x20: "Off" cuts a stuck read and is sent at once', async (t) => {
  let stuck = false;
  const { srv, clock, app, config, gladys, dev } = await boot(t, {
    stuck: (path) => stuck && path === '/api/thermostat',
  });
  await app.connected(async () => config);
  stuck = true;
  // The next read gets stuck on the values of the thermostat.
  // Waited for, bounded (never a fixed wait before the check): 3 intervals at most.
  await clock.sleep(INTERVAL);
  for (let i = 0; i < 600 && !app.session.client.busy; i += 1) {
    await clock.sleep(100);
  }
  assert.equal(app.session.client.busy, true);
  stuck = false;
  const key = identityKey('boiler', 123, '0x08');
  const started = performance.now();
  const ack = await gladys.fake.setValue(
    { external_id: `ext:ems-esp-test:ems-esp:${key}` },
    { external_id: `ext:ems-esp-test:ems-esp:${key}:dhw1-mode` },
    'off',
  );
  const elapsed = (performance.now() - started) * SPEED;
  assert.equal(srv.count(`POST ${DHW_MODE}`), 1, JSON.stringify(ack));
  assert.ok(elapsed < 4500, `acked after ${Math.round(elapsed)} ms (simulated)`);
  assert.deepEqual(ack, { success: true });
  assert.equal(dev.entities[DHW_MODE].value, false);
  assert.equal(app.session.failures, 0, 'the cut read is no failure');
});
