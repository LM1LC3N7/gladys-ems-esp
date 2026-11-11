// -----------------------------------------------------------------------------
// Guards of review r1: /data read again on its own timer, no storm of
// follow-up reads around a stop, the refusal and the freshness checks, the
// 429 that never abandons a stop, nothing armed after stop().
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { boolOf, modeValueOf } from '../src/model.js';
import { CONFIG } from './fixtures/emsesp.js';
import { HOUR, MINUTE, SECOND, last, setup } from './helpers/app.js';

const ALLOW = { ...CONFIG, allow_commands: true };
const DHW_MODE = '/api/boiler/dhw/activated';
const isStop = (r) => r.method === 'POST' && r.path === DHW_MODE && r.value === 'off';
const stops = (t) => t.dev.requests.filter(isStop).length;
const reads = (t) => t.dev.count('/api/system');
const kept = (store) => store.data?.stops?.find((s) => s.circuit === 'dhw1');
const WRONG = 'emsesp_wrong_key_123';

test('/data slow at a restart: read again on its own timer, the stop it keeps leaves at once, commands allowed again', async () => {
  const store = memoryStore();
  const a = await setup({ store, config: ALLOW });
  await a.connect();
  await a.create();
  a.dev.route = () => 'refuse';
  await a.command('dhw1-mode', 'off');
  assert.equal(kept(store).phase, 'unsent');
  await a.app.stop();
  // Restart: /data stuck at boot, the gateway back.
  store.frozen = true;
  const t = await setup({ store, clock: a.clock, config: ALLOW });
  t.gladys.fake.devices = a.gladys.fake.devices;
  await t.connect();
  assert.equal(t.app.memoryBroken, true, 'counted unreadable after 1.5 s');
  assert.equal(stops(t), 0, 'the stop it keeps is not known yet');
  const r0 = reads(t);
  store.thaw();
  await t.wait(10_500);
  assert.equal(t.app.memoryBroken, false, 'read again on its timer');
  assert.equal(stops(t), 1, 'the stop kept in /data left at once');
  assert.equal(reads(t), r0, 'before any periodic read');
  await t.wait(5 * SECOND);
  assert.equal(t.dev.entities[DHW_MODE].value, false);
  assert.equal(kept(store).phase, 'confirmed');
  assert.ok(store.saves > 0, 'saved again');
  // Switching on is allowed again (it was refused while /data was unknown).
  assert.deepEqual(await t.command('dhw1-mode', 'on'), { success: true });
  await t.app.stop();
});

test('/data never answering: one read at a time, retried every 10 s, nothing after stop()', async () => {
  let loads = 0;
  let pending = 0;
  let peak = 0;
  const store = {
    load: () => {
      loads += 1;
      pending += 1;
      peak = Math.max(peak, pending);
      return new Promise(() => {});
    },
    save: async () => {},
  };
  const t = await setup({ store });
  await t.connect();
  await t.wait(2 * MINUTE);
  assert.equal(loads, 1, 'the stuck read is waited for again, never doubled');
  assert.equal(peak, 1);
  assert.match(t.gladys.fake.connectionStatus.message.fr, /\/data illisible/);
  await t.app.stop();
  const timers = t.clock.pending;
  await t.wait(MINUTE);
  assert.ok(t.clock.pending <= timers, 'no timer armed after stop()');
});

test('/data unreadable then readable: read again every 10 s until it answers', async () => {
  const store = memoryStore({ lastReadAt: 1 }, { unreadable: true });
  const t = await setup({ store });
  await t.connect();
  assert.equal(t.app.memoryBroken, true);
  store.unreadable = false;
  await t.wait(11 * SECOND);
  assert.equal(t.app.memoryBroken, false);
  assert.doesNotMatch(t.gladys.fake.connectionStatus.message.fr, /\/data illisible/);
});

test('a stop sent without an answer, 10 minutes: resends at the rhythm of the reads, no follow-up loop', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.route = (path, method) => (method === 'POST' ? 'silent' : undefined);
  await t.command('dhw1-mode', 'off');
  const r0 = reads(t);
  const p0 = stops(t);
  for (let i = 0; i < 60; i += 1) {
    await t.wait(10 * SECOND);
  }
  assert.ok(reads(t) - r0 <= 14, `${reads(t) - r0} reads`);
  assert.ok(stops(t) - p0 <= 14, `${stops(t) - p0} stops`);
});

test('a stop taken (200), then refused (400): twice more at most, no loop', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  t.dev.ignoreWrites = true;
  await t.command('dhw1-mode', 'off');
  t.dev.route = (path, method) => (method === 'POST' ? { status: 400, body: '{}' } : undefined);
  const p0 = stops(t);
  for (let i = 0; i < 60; i += 1) {
    await t.wait(10 * SECOND);
  }
  assert.ok(stops(t) - p0 <= 3, `${stops(t) - p0} stops`);
  assert.ok(reads(t) <= 16, `${reads(t)} reads`);
  assert.ok(kept(store).tries <= 3);
});

test('a stop answered 503 or 429: no send during the pause, none lost', async () => {
  for (const status of [503, 429]) {
    const store = memoryStore();
    const t = await setup({ store });
    await t.connect();
    await t.create();
    t.dev.route = (path, method) => (method === 'POST' ? { status, body: '' } : undefined);
    await t.command('dhw1-mode', 'off');
    for (let i = 0; i < 60; i += 1) {
      await t.wait(10 * SECOND);
    }
    // A pause of 1, 2, 5, 10 min: a handful of resends in 10 minutes, never a storm.
    assert.ok(stops(t) <= 6, `${status}: ${stops(t)} stops`);
    assert.equal(kept(store).phase, 'unsent', `${status}: never given up`);
    assert.equal(kept(store).tries, 0, `${status}: never counted`);
    t.dev.route = undefined;
    await t.wait(15 * MINUTE);
    assert.equal(kept(store).phase, 'confirmed', `${status}: sent once the gateway takes it`);
  }
});

test('a gateway that answers nothing: the reads follow their backoff, the stop no loop', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.route = () => 'silent';
  await t.command('dhw1-mode', 'off', { ms: 10 * SECOND });
  const r0 = reads(t);
  for (let i = 0; i < 60; i += 1) {
    await t.wait(10 * SECOND);
  }
  // Backoff 1, 2, 5, 10 min (plus the follow-ups of the click): a few reads.
  assert.ok(reads(t) - r0 <= 8, `${reads(t) - r0} reads`);
});

// Salts checked by hand: with SALT_APART the 8-bit prints of WRONG and of
// CONFIG.token differ, with SALT_SAME they are equal (one chance in 256).
const SALT_APART = '0'.repeat(32);
const SALT_SAME = `${'0'.repeat(30)}62`;

test('the two salts of these tests give the prints they say', async () => {
  const { refusalPrint } = await import('../src/store.js');
  const print = (salt, token) => refusalPrint(salt, { host: '192.168.1.50', port: 80, token });
  assert.notEqual(print(SALT_APART, WRONG), print(SALT_APART, CONFIG.token));
  assert.equal(print(SALT_SAME, WRONG), print(SALT_SAME, CONFIG.token));
});

test('a restart with another key lifts a refusal kept in /data at once', async () => {
  const store = memoryStore({ salt: SALT_APART });
  const a = await setup({ store, config: { ...CONFIG, token: WRONG } });
  a.dev.readKey = true;
  await a.connect();
  assert.equal(store.data.refused, true);
  await a.app.stop();
  const t = await setup({ store, clock: a.clock });
  t.dev.readKey = true;
  await t.connect();
  assert.equal(reads(t), 1, 'read at once with the other key');
  assert.equal(store.data.refused, false);
});

test('another key whose print collides: the refusal holds at a restart, the button lifts it', async () => {
  const store = memoryStore({ salt: SALT_SAME });
  const a = await setup({ store, config: { ...CONFIG, token: WRONG } });
  a.dev.readKey = true;
  await a.connect();
  assert.equal(store.data.refused, true);
  await a.app.stop();
  const t = await setup({ store, clock: a.clock });
  t.dev.readKey = true;
  await t.connect();
  assert.equal(reads(t), 0, 'the same print: taken for the same key');
  // The button, past the interval after the last read.
  await t.wait(61 * SECOND);
  assert.equal(reads(t), 0, 'still no automatic try');
  const answer = await t.during(t.app.testConnection());
  assert.match(answer.value, /Connecté/);
  assert.equal(store.data.refused, false);
});

test('a key refused while /data is stuck is kept once /data answers: no automatic try', async () => {
  const store = memoryStore();
  store.frozen = true;
  const t = await setup({ store, config: { ...CONFIG, token: WRONG } });
  t.dev.readKey = true;
  await t.connect();
  await t.wait(3 * SECOND);
  assert.equal(t.app.memory.refused, true);
  const r0 = reads(t);
  store.thaw();
  await t.wait(30 * MINUTE);
  assert.equal(reads(t), r0, 'no read by itself');
  assert.equal(store.data.refused, true, 'saved once /data answers');
});

test('switching on answered with a redirection: the stop holds and is sent again', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: ALLOW });
  await t.connect();
  await t.create();
  t.dev.route = (path, method) => (method === 'POST' ? 'silent' : undefined);
  await t.command('dhw1-mode', 'off');
  t.dev.route = (path, method) => (method === 'POST' ? { status: 302, body: '' } : undefined);
  const ack = await t.command('dhw1-mode', 'on');
  assert.equal(ack.success, false);
  assert.ok(kept(store), 'the stop holds');
  t.dev.route = undefined;
  await t.wait(2 * MINUTE);
  assert.equal(t.dev.entities[DHW_MODE].value, false, 'the stop sent again');
});

test('values read longer ago than two intervals are never published', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  assert.ok(t.app.freshData());
  t.app.session.data.at -= 3 * MINUTE;
  assert.equal(t.app.session.online, true);
  assert.equal(t.app.freshData(), undefined);
  assert.equal(t.app.standing(t.app.session.data.key), 'unknown');
});

test('a stop answered 429 three times is never given up', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  let refusals = 0;
  t.dev.route = (path, method) => {
    if (method === 'POST' && refusals < 3) {
      refusals += 1;
      return { status: 429, body: '' };
    }
    return undefined;
  };
  await t.command('dhw1-mode', 'off');
  await t.wait(30 * MINUTE);
  assert.equal(refusals, 3);
  assert.equal(kept(store).phase, 'confirmed');
  assert.equal(t.dev.entities[DHW_MODE].value, false);
});

test('a stop refused while the reads fail is not counted', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  t.dev.route = (path, method) => (method === 'GET' ? 'refuse' : { status: 400, body: '{}' });
  await t.wait(61 * SECOND);
  assert.equal(t.app.session.online, false);
  await t.command('dhw1-mode', 'off');
  assert.equal(kept(store).tries, 0);
});

test('400 or 404 on /api/system is never a refusal of the key', async () => {
  for (const status of [400, 404]) {
    const store = memoryStore();
    const t = await setup({ store });
    t.dev.route = (path) => (path === '/api/system' ? { status, body: '{}' } : undefined);
    await t.connect();
    assert.equal(store.data.refused, false, String(status));
    assert.match(t.gladys.fake.connectionStatus.message.fr, new RegExp(`HTTP ${status}`));
  }
});

test('switching on sent without an answer: the old stop is not sent again', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: ALLOW });
  await t.connect();
  await t.create();
  await t.command('dhw1-mode', 'off');
  await t.wait(25 * SECOND);
  t.dev.route = (path, method) => (method === 'POST' ? 'drop' : undefined);
  const ack = await t.command('dhw1-mode', 'on');
  assert.match(ack.error, /sans confirmation/);
  t.dev.route = undefined;
  const p0 = stops(t);
  await t.wait(5 * MINUTE);
  assert.equal(stops(t), p0, 'the newer command left: no resend of the stop');
  assert.equal(kept(store), undefined);
});

test('nothing armed nor sent after stop(), a follow-up read in flight', async () => {
  const t = await setup({ latency: 3 * SECOND });
  await t.connect();
  await t.create();
  t.dev.latency = 0;
  t.dev.route = (path, method) => (method === 'POST' ? 'silent' : undefined);
  await t.command('dhw1-mode', 'off');
  t.dev.latency = 3 * SECOND;
  for (let i = 0; i < 100 && !t.app.session.following; i += 1) {
    await t.wait(100);
  }
  assert.ok(t.app.session.following, 'a follow-up read in flight');
  await t.app.stop();
  // A stop in flight ends within its own deadline (4.3 s); nothing else is armed.
  await t.wait(5 * SECOND);
  assert.equal(t.clock.pending, 0, 'no timer armed by the read cut at stop()');
  const r0 = t.dev.requests.length;
  await t.wait(HOUR);
  assert.equal(t.dev.requests.length, r0, 'no request after stop()');
  assert.equal(t.clock.pending, 0, 'no timer left');
});

test('Turkish upper case without a locale: KAPALI and AÇIK read as off and on', () => {
  assert.equal(boolOf('KAPALI'), 'off');
  assert.equal(boolOf('AÇIK'), 'on');
  assert.equal(modeValueOf('KAPALI'), 'off');
});

test('the status after a stop confirmed late says it is stopped', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  assert.deepEqual(await t.command('dhw1-mode', 'off'), { success: true });
  await t.wait(SECOND);
  assert.equal(last(t.gladys, 'status'), 'Eau chaude 1 arrêté depuis Gladys');
});

test('no follow-up read while the reads fail (their backoff holds)', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.route = (path, method) => (method === 'GET' ? 'refuse' : undefined);
  await t.wait(61 * SECOND);
  assert.equal(t.app.session.online, false);
  await t.command('dhw1-mode', 'off');
  const unsent = t.dev.unsent;
  await t.wait(25 * SECOND);
  assert.equal(t.dev.unsent, unsent, 'no read tried by the follow-ups');
});

test('no resend of a kept stop by a follow-up read during a pause', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  // The hot water stop answered 503 (kept, a pause), the heating stop taken (follow-ups armed).
  t.dev.route = (path, method) =>
    method === 'POST' && path === DHW_MODE ? { status: 503, body: '' } : undefined;
  await t.command('dhw1-mode', 'off');
  assert.ok(t.app.pauseLeft() > 0);
  assert.deepEqual(await t.command('heating-mode', 'off'), { success: true });
  t.dev.route = undefined;
  await t.wait(25 * SECOND);
  assert.equal(stops(t), 1, 'the hot water stop waits for the end of the pause');
});
