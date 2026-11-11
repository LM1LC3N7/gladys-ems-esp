// -----------------------------------------------------------------------------
// "Off", the protective command (the heating of the boiler, a hot water, a
// thermostat circuit that lists an off mode): it leaves whatever holds the
// others, only answers count as tries, its guard is never lifted by time,
// nothing begun before it leaves after it, /data never holds it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { CONFIG, READ_TOKEN } from './fixtures/emsesp.js';
import { DEVICE, F, HOUR, KEY, MINUTE, SECOND, last, setup } from './helpers/app.js';

const ALLOW = { ...CONFIG, allow_commands: true };
const DHW_MODE = '/api/boiler/dhw/activated';
const HC_MODE = '/api/thermostat/hc1/mode';
const HEATING = '/api/boiler/heatingactivated';
const WRONG = 'emsesp_wrong_key_123';
const isStop = (r) => r.method === 'POST' && r.path === DHW_MODE && r.value === 'off';
const other = (t) => {
  t.dev.system.devices[0].productID = 999;
};
const stops = (t) => t.dev.requests.filter(isStop).length;
const statusText = (t) => t.gladys.fake.connectionStatus?.message?.fr ?? '';
const off = (t) => t.command('dhw1-mode', 'off');
const kept = (store) => store.data?.stops?.find((s) => s.circuit === 'dhw1');

test('Off with the option off: sent at once, success once read off, kept in /data', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  const at = t.clock.monotonic();
  const ack = await off(t);
  assert.deepEqual(ack, { success: true });
  assert.ok(t.clock.monotonic() - at < 4_300, 'acked within the budget');
  assert.equal(stops(t), 1);
  // Only the stop and the read that confirms it: nothing read before.
  const tail = t.dev.requests.slice(-2).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(tail, [`POST ${DHW_MODE}`, `GET ${DHW_MODE}`]);
  assert.deepEqual(kept(store), {
    key: KEY,
    circuit: 'dhw1',
    phase: 'confirmed',
    tries: 0,
    resends: 0,
    starts: 0,
  });
  await t.wait(6 * SECOND);
  assert.equal(last(t.gladys, 'dhw1-mode'), 'off');
  assert.equal(last(t.gladys, 'status'), 'Eau chaude 1 arrêté depuis Gladys');
});

test('Off is never held by: a 429 pause, /data unreadable, a device not read yet', async () => {
  // A pause.
  const a = await setup();
  await a.connect();
  await a.create();
  a.dev.route = () => ({ status: 429, body: '' });
  await a.wait(61 * SECOND);
  assert.ok(a.app.pauseLeft() > 0);
  a.dev.route = undefined;
  assert.deepEqual(await off(a), { success: true });
  // /data unreadable.
  const c = await setup({ store: memoryStore(null, { unreadable: true }) });
  await c.connect();
  await c.create();
  assert.deepEqual(await off(c), { success: true });
  // Before the first read (a restart waiting for the interval).
  const store = memoryStore();
  const d0 = await setup({ store });
  await d0.connect();
  await d0.create();
  await d0.app.stop();
  const d = await setup({ store, clock: d0.clock });
  d.gladys.fake.devices = d0.gladys.fake.devices;
  await d.connect();
  assert.equal(d.dev.count('/api/system'), 0, 'no read yet');
  assert.deepEqual(await off(d), { success: true });
  assert.equal(stops(d), 1);
});

test('/data stuck: several stops in a row leave, each acked within the budget', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  store.frozen = true;
  for (const mode of ['off', 'off', 'off']) {
    const at = t.clock.monotonic();
    assert.deepEqual(await t.command('dhw1-mode', mode), { success: true });
    assert.ok(t.clock.monotonic() - at < 4_300);
  }
  assert.equal(stops(t), 3);
  store.thaw();
});

test('/data stuck at the start: a stop clicked meanwhile leaves and is kept once read', async () => {
  const store = memoryStore();
  const a = await setup({ store });
  await a.connect();
  await a.create();
  await a.app.stop();
  store.frozen = true;
  const t = await setup({ store, clock: a.clock });
  t.gladys.fake.devices = a.gladys.fake.devices;
  const connecting = t.during(t.gladys.connect(), 200);
  await connecting;
  const ack = off(t);
  store.thaw();
  assert.deepEqual(await ack, { success: true });
  await t.wait(5 * SECOND);
  assert.equal(stops(t), 1);
  assert.equal(kept(store)?.phase, 'confirmed');
});

test('Off cuts a read stuck in flight and leaves first; the cut read is no failure', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.route = (path) => (path === '/api/thermostat' ? 'silent' : undefined);
  await t.wait(60 * SECOND + 500);
  assert.equal(t.app.session.client.busy, true, 'a read is stuck');
  t.dev.route = undefined;
  const ack = await off(t);
  assert.deepEqual(ack, { success: true });
  assert.equal(t.dev.peak, 1, 'never two connections');
  assert.notEqual(t.app.session.online, false, 'the cut read is no failure');
  assert.equal(t.app.session.failures, 0);
});

test('Off goes ahead of a full queue; the commands waiting are never sent after it', async () => {
  const t = await setup({ config: ALLOW, latency: 400 });
  await t.connect();
  await t.create();
  const device = { external_id: DEVICE };
  // Setpoints of the heating circuit: not held by the stop of the hot water,
  // only by the epoch (nothing begun before a stop leaves after it).
  const sp = (v) => t.gladys.fake.setValue(device, { external_id: F('hc1-setpoint') }, v);
  const waiting = [sp(20), sp(20.5), sp(21.5), sp(22)];
  const full = await t.during(sp(22.5), 100);
  assert.match(full.value.error, /Trop de commandes en attente/);
  await t.wait(100);
  const stop = off(t);
  const results = await t.during(Promise.all([stop, ...waiting]), 10 * SECOND);
  const [stopAck, ...others] = results.value;
  assert.equal(stopAck.success, true);
  for (const ack of others) {
    assert.equal(ack.success, false);
  }
  const at = t.dev.requests.findIndex(isStop);
  assert.ok(!t.dev.requests.slice(at + 1).some((r) => r.method === 'POST'), 'nothing after it');
  assert.equal(t.dev.peak, 1);
});

test('a setpoint whose fresh read is under way is never written after a stop', async () => {
  const t = await setup({ config: ALLOW, latency: 300 });
  await t.connect();
  await t.create();
  const setpoint = t.command('hc1-setpoint', 20);
  await t.wait(350);
  const stop = off(t);
  const [sp, st] = (await t.during(Promise.all([setpoint, stop]))).value;
  assert.equal(st.success, true);
  assert.equal(sp.success, false);
  assert.match(sp.error, /Un arrêt a été envoyé depuis|rien envoyé/);
  assert.equal(t.dev.posts().filter((r) => r.path.endsWith('/seltemp')).length, 0);
});

test('Off unreachable: tried again for 250 ms, kept in /data, sent first by the next read', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  t.dev.route = () => 'refuse';
  const ack = await off(t);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Arrêt non envoyé \(unreachable\) : renvoyé à chaque lecture/);
  assert.ok(t.dev.unsent >= 3, `${t.dev.unsent} tries within 250 ms`);
  assert.ok(t.dev.unsent <= 6);
  assert.equal(kept(store).phase, 'unsent');
  await t.wait(SECOND);
  assert.equal(
    last(t.gladys, 'status'),
    'Arrêt de Eau chaude 1 depuis Gladys pas encore envoyé : renvoyé à chaque lecture',
  );
  // Never left: no follow-up read tries it within the interval, the next read does.
  const tries = t.dev.unsent;
  await t.wait(50 * SECOND);
  assert.equal(t.dev.unsent, tries);
  t.dev.route = undefined;
  const before = t.dev.requests.length;
  await t.wait(61 * SECOND);
  assert.ok(isStop(t.dev.requests[before]), 'the stop first, before the read');
  assert.equal(kept(store).phase, 'confirmed');
});

test('a stop never answered is never given up: a long outage, then sent at the first read', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  t.dev.route = () => 'refuse';
  await off(t);
  await t.wait(25 * MINUTE);
  assert.ok(t.dev.unsent >= 8, `${t.dev.unsent} tries`);
  assert.equal(kept(store).phase, 'unsent');
  assert.equal(kept(store).tries, 0, 'never counted');
  const before = t.dev.requests.length;
  t.dev.route = undefined;
  await t.wait(11 * MINUTE);
  assert.ok(isStop(t.dev.requests[before]));
  assert.equal(kept(store).phase, 'confirmed');
});

test('a stop sent but never answered (silent, cut): not counted, sent again by the reads', async () => {
  for (const route of ['silent', 'drop']) {
    const store = memoryStore();
    const t = await setup({ store });
    await t.connect();
    await t.create();
    t.dev.route = (path, method) => (method === 'POST' ? route : undefined);
    const ack = await off(t);
    assert.match(ack.error, /Arrêt envoyé, sans confirmation/, route);
    assert.equal(kept(store).phase, 'unsent', route);
    for (let i = 0; i < 5; i += 1) {
      await t.wait(61 * SECOND);
    }
    assert.ok(stops(t) >= 5, `${route}: sent again at each read (${stops(t)})`);
    assert.equal(kept(store).tries, 0);
    t.dev.route = undefined;
    await t.wait(61 * SECOND);
    assert.equal(kept(store).phase, 'confirmed', route);
  }
});

test('a stop answered 429/5xx: not counted, sent again first by the next read (the pause never holds it)', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  t.dev.route = (path, method) => (method === 'POST' ? { status: 503, body: '' } : undefined);
  const ack = await off(t);
  assert.match(ack.error, /Arrêt non envoyé \(HTTP 503\)/);
  assert.equal(kept(store).phase, 'unsent');
  assert.equal(kept(store).tries, 0);
  t.dev.route = undefined;
  await t.wait(10 * MINUTE);
  assert.equal(kept(store).phase, 'confirmed');
});

test('a stop the gateway refuses (4xx) is sent again twice at most, the reads go on, no refusal', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  t.dev.route = (path, method) => (method === 'POST' ? { status: 400, body: '' } : undefined);
  const ack = await off(t);
  assert.match(ack.error, /Arrêt refusé par la passerelle \(HTTP 400\)/);
  for (let i = 0; i < 5; i += 1) {
    await t.wait(61 * SECOND);
  }
  assert.equal(stops(t), 3);
  assert.equal(store.data.refused, false);
  assert.ok(t.dev.count('/api/system') >= 6, 'the reads go on');
  assert.match(statusText(t), /refusé 3 fois par la passerelle : plus renvoyé/);
});

test('a stop kept never answered is never sent to another gateway at the address', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  // The stop cannot connect; the reads go on and find another gateway.
  t.dev.route = (path, method) => (method === 'POST' ? 'refuse' : undefined);
  await off(t);
  other(t);
  await t.wait(61 * SECOND);
  t.dev.route = undefined;
  const sent = stops(t);
  assert.equal(sent, 0);
  await t.wait(5 * MINUTE);
  assert.equal(stops(t), sent, 'never to the other gateway once read');
  assert.equal(kept(store).phase, 'unsent');
  // Clicked again: refused, another gateway answers.
  assert.match((await off(t)).error, /Une autre installation/);
});

test('a stop kept in /data never answered goes first at a restart, before any read', async () => {
  const store = memoryStore();
  const a = await setup({ store });
  await a.connect();
  await a.create();
  a.dev.route = () => 'refuse';
  await off(a);
  await a.app.stop();
  const t = await setup({ store, clock: a.clock });
  await t.connect();
  assert.ok(isStop(t.dev.requests[0]), 'the stop is the first request');
  await t.wait(5 * SECOND);
  assert.equal(kept(store).phase, 'confirmed');
});

test('Off contradicted by the reads (answered, not applied): sent again 3 times, then said', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  t.dev.ignoreWrites = true;
  const ack = await off(t);
  assert.match(ack.error, /Arrêt envoyé et accepté ; la passerelle ne l’indique pas encore/);
  for (let i = 0; i < 8; i += 1) {
    await t.wait(61 * SECOND);
  }
  assert.equal(stops(t), 4, 'the click and 3 resends');
  assert.equal(kept(store).resends, 3);
  assert.match(statusText(t), /envoyé 3 fois, non appliqué/);
});

test('the guard of a stop is never lifted by time; another mode read twice lifts it', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  await off(t);
  await t.wait(6 * HOUR);
  assert.equal(kept(store).phase, 'confirmed');
  // Changed on the panel: once is not enough, twice in a row lifts it.
  t.dev.entities[DHW_MODE].value = true;
  await t.wait(61 * SECOND);
  assert.equal(kept(store).starts, 1);
  assert.equal(stops(t), 1, 'never sent again once applied');
  await t.wait(61 * SECOND);
  assert.equal(kept(store), undefined);
});

test('an "off" read between two other modes restarts the count; an unreadable count is none', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  await off(t);
  // Past the follow-up reads of the stop (5 s, 20 s): one read a minute from now.
  await t.wait(25 * SECOND);
  t.dev.entities[DHW_MODE].value = true;
  await t.wait(61 * SECOND);
  assert.equal(kept(store).starts, 1);
  t.dev.entities[DHW_MODE].value = false;
  await t.wait(61 * SECOND);
  assert.equal(kept(store).starts, 0);
  t.dev.entities[DHW_MODE].value = true;
  await t.wait(61 * SECOND);
  assert.ok(kept(store), 'one read only');
  const { normalizeMemory } = await import('../src/store.js');
  const read = normalizeMemory({ stops: [{ ...kept(store), starts: 'x' }] }, Date.now());
  assert.equal(read.stops.dhw1.starts, 0);
});

test('another mode with the option lifts the stop on disk before it leaves; refused when /data cannot be written', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: ALLOW });
  await t.connect();
  await t.create();
  await off(t);
  store.failing = true;
  const refused = await t.command('dhw1-mode', 'on');
  assert.match(refused.error, /\/data ne peut être lu ou écrit/);
  assert.ok(t.app.memory.stops.dhw1, 'the stop holds');
  assert.equal(t.dev.posts().filter((r) => r.value === 'on').length, 0);
  store.failing = false;
  assert.deepEqual(await t.command('dhw1-mode', 'on'), { success: true });
  assert.equal(kept(store), undefined);
});

test('a setpoint while the stop holds: refused, another mode first', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  await t.create();
  await off(t);
  await t.wait(25 * SECOND);
  const before = t.dev.requests.length;
  const ack = await t.command('dhw1-setpoint', 50);
  assert.match(ack.error, /remettez-le en marche/);
  assert.equal(t.dev.requests.length, before, 'refused before any read');
  // The heating circuit is not stopped: its setpoint goes.
  assert.deepEqual(await t.command('hc1-setpoint', 20), { success: true });
});

test('a mode that did not leave keeps the stop (and its resends)', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: ALLOW });
  await t.connect();
  await t.create();
  await off(t);
  t.dev.route = (path, method) => (method === 'POST' ? { status: 429, body: '' } : undefined);
  const ack = await t.command('dhw1-mode', 'on');
  assert.equal(ack.success, false);
  assert.ok(kept(store), 'the stop is back');
  assert.ok(t.app.memory.stops.dhw1);
});

test('a mode that left cancels the resends of the stop', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: ALLOW });
  await t.connect();
  await t.create();
  t.dev.ignoreWrites = true;
  await off(t);
  t.dev.ignoreWrites = false;
  assert.deepEqual(await t.command('dhw1-mode', 'on'), { success: true });
  const sent = stops(t);
  await t.wait(5 * MINUTE);
  assert.equal(stops(t), sent);
});

test('Off refused only without a usable configuration, another installation, or a circuit listing no off', async () => {
  const t = await setup({ config: { ...CONFIG, token: 'abc' } });
  await t.connect();
  assert.match((await off(t)).error, /configuration/);
  const u = await setup();
  await u.connect();
  await u.create();
  other(u);
  await u.wait(61 * SECOND);
  assert.match((await off(u)).error, /Une autre installation/);
  assert.equal(stops(u), 0);
  // hc2 (an RC310) lists no off mode: nothing to send.
  const v = await setup();
  await v.connect();
  await v.create();
  assert.match((await v.command('hc2-mode', 'off')).error, /n’est pas un de ceux/);
  assert.equal(v.dev.posts().length, 0);
});

test('the heating of the boiler and a thermostat circuit stopped with the option off', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  assert.deepEqual(await t.command('heating-mode', 'off'), { success: true });
  assert.deepEqual(await t.command('hc1-mode', 'off'), { success: true });
  assert.deepEqual(
    t.dev.posts().map((r) => [r.path, r.value]),
    [
      [HEATING, 'off'],
      [HC_MODE, 'off'],
    ],
  );
  assert.equal(t.dev.entities[HEATING].value, false);
  assert.equal(t.dev.entities[HC_MODE].value, 0);
  assert.deepEqual(store.data.stops.map((s) => [s.circuit, s.phase]).sort(), [
    ['hc1', 'confirmed'],
    ['heating', 'confirmed'],
  ]);
  await t.wait(6 * SECOND);
  assert.equal(last(t.gladys, 'heating-mode'), 'off');
  assert.equal(last(t.gladys, 'hc1-mode'), 'off');
});

test('Off in German: "off" is written, EMS-ESP shows "aus", the stop is confirmed', async () => {
  const t = await setup();
  t.dev.entities[HC_MODE].enum = ['aus', 'manuell', 'auto'];
  await t.connect();
  await t.create();
  assert.deepEqual(await t.command('hc1-mode', 'off'), { success: true });
  assert.equal(t.dev.posts()[0].value, 'off');
});

test('a stop refused 401 (a key with the read right only): said, counted, the reads go on', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: { ...CONFIG, token: READ_TOKEN } });
  await t.connect();
  await t.create();
  const ack = await off(t);
  assert.match(ack.error, /Arrêt refusé par EMS-ESP \(HTTP 401\/403\)/);
  assert.equal(kept(store).tries, 1);
  assert.equal(store.data.refused, false);
  for (let i = 0; i < 4; i += 1) {
    await t.wait(61 * SECOND);
  }
  assert.equal(t.dev.posts().length, 3, 'sent again twice at most');
  assert.equal(last(t.gladys, 'dhw1-mode'), 'on');
});

test('Off acks within the budget even when the gateway stays silent', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.route = () => 'silent';
  const at = t.clock.monotonic();
  const ack = await off(t);
  assert.ok(t.clock.monotonic() - at < 4_400);
  assert.match(ack.error, /Arrêt envoyé, sans confirmation \(timeout\)/);
});

test('Off with getConfig() failing after a reconnection: the session in place sends it', async () => {
  let fail = false;
  const t = await setup({
    getConfig: async () => {
      if (fail) {
        throw new Error('down');
      }
      return CONFIG;
    },
  });
  await t.connect();
  await t.create();
  fail = true;
  await t.app.connected(() => t.gladys.getConfig());
  assert.deepEqual(await off(t), { success: true });
});

test('"Off" while other credentials are saved: never lost, sent on the new session', async () => {
  const store = memoryStore();
  const t = await setup({ store, latency: 300 });
  await t.connect();
  await t.create();
  t.dev.route = () => 'refuse';
  const ack = off(t);
  await t.wait(100);
  t.dev.route = undefined;
  void t.gladys.fake.configUpdated({ ...CONFIG, address: '192.168.1.51' });
  await t.during(ack, 6 * SECOND);
  await t.wait(21 * SECOND);
  assert.ok(stops(t) >= 1);
  assert.equal(kept(store).phase, 'confirmed');
});

test('a click while the key is refused: sent blind, kept, sent again first with another key', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: { ...CONFIG, token: WRONG } });
  t.dev.readKey = true;
  await t.connect();
  const ack = await off(t);
  assert.match(ack.error, /alors qu’EMS-ESP refuse les lectures avec cette clé/);
  assert.equal(kept(store).phase, 'unsent');
  assert.equal(kept(store).tries, 0);
  assert.match(statusText(t), /Un arrêt depuis Gladys attend/);
  // EMS-ESP refused it (another key): nothing changed there.
  assert.equal(t.dev.entities[DHW_MODE].value, true);
  const before = t.dev.requests.length;
  await t.during(t.gladys.fake.configUpdated(CONFIG));
  assert.ok(isStop(t.dev.requests[before]), 'the stop first with the new key');
  await t.wait(6 * SECOND);
  assert.equal(kept(store).phase, 'confirmed');
});

test('a stop being sent is never doubled by a read', async () => {
  const t = await setup({ latency: 1_500 });
  await t.connect();
  await t.create();
  const ack = off(t);
  await t.during(ack, 10 * SECOND);
  await t.wait(2 * MINUTE);
  assert.equal(stops(t), 1);
});

test('a scene stopping every circuit that lists an "off": each stop leaves', async () => {
  const t = await setup({ latency: 150 });
  await t.connect();
  await t.create();
  const device = { external_id: DEVICE };
  const send = (role, value) => t.gladys.fake.setValue(device, { external_id: F(role) }, value);
  const outcome = await t.during(
    Promise.all([send('hc1-mode', 'off'), send('dhw1-mode', 'off'), send('heating-mode', 'off')]),
    6 * SECOND,
    10,
  );
  assert.deepEqual(outcome.value, [{ success: true }, { success: true }, { success: true }]);
  assert.equal(t.dev.entities[HC_MODE].value, 0);
  assert.equal(t.dev.entities[DHW_MODE].value, false);
  assert.equal(t.dev.entities[HEATING].value, false);
  assert.equal(t.dev.peak, 1);
});

test('the status with stops: notes joined, one space only', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  await off(t);
  await t.wait(SECOND);
  assert.doesNotMatch(statusText(t), / {2}/);
  assert.match(statusText(t), /Eau chaude 1 arrêté depuis Gladys\.$/);
});

test('a stop kept while the key is refused: no blind resend loop; the button that gets through sends it', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: { ...CONFIG, token: WRONG } });
  t.dev.readKey = true;
  await t.connect();
  await off(t);
  const attempts = t.dev.posts().length;
  await t.wait(2 * HOUR);
  assert.equal(t.dev.posts().length, attempts, 'no automatic resend while refused');
  assert.equal(kept(store).phase, 'unsent');
  // The key was added in EMS-ESP meanwhile: the button gets through.
  t.dev.readKeys.add(WRONG);
  t.dev.writeKeys.add(WRONG);
  await t.during(t.app.testConnection());
  await t.wait(2 * SECOND);
  assert.equal(stops(t) - attempts, 1, 'sent once the button got through');
  assert.equal(t.dev.entities[DHW_MODE].value, false);
  await t.wait(6 * SECOND);
  assert.equal(kept(store).phase, 'confirmed');
});

test('a stop clicked while /data is being read: nothing saved before the file is read', async () => {
  const base = memoryStore({ refused: false, lastReadAt: 1, stops: [] });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const savesBefore = [];
  let loaded = false;
  const store = {
    ...base,
    data: base.data,
    async load() {
      await gate;
      loaded = true;
      return base.load();
    },
    async save(data) {
      if (!loaded) {
        savesBefore.push(data);
      }
      return base.save(data);
    },
  };
  const a = await setup();
  await a.connect();
  await a.create();
  const t = await setup({ store, clock: a.clock });
  t.gladys.fake.devices = a.gladys.fake.devices;
  await t.during(t.gladys.connect(), 200);
  const ack = off(t);
  await t.wait(300);
  assert.deepEqual(savesBefore, [], 'never written over before it is read');
  release();
  assert.deepEqual(await ack, { success: true });
  await t.wait(SECOND);
  assert.equal(base.data.stops[0]?.circuit, 'dhw1');
});

test('a command waiting behind a batch when a stop comes is never sent after it', async () => {
  const t = await setup({ config: ALLOW, latency: 400 });
  await t.connect();
  await t.create();
  const device = { external_id: DEVICE };
  const sp = (v) => t.gladys.fake.setValue(device, { external_id: F('hc1-setpoint') }, v);
  const first = sp(20);
  await t.wait(200);
  // The first batch reads; this one waits for the next batch.
  const second = sp(22);
  await t.wait(100);
  const stop = off(t);
  const results = await t.during(Promise.all([first, second, stop]), 10 * SECOND);
  const [a, b, s] = results.value;
  assert.equal(s.success, true);
  assert.equal(a.success, false);
  assert.match(b.error, /Un arrêt a été envoyé depuis/);
  const at = t.dev.requests.findIndex(isStop);
  assert.ok(!t.dev.requests.slice(at + 1).some((r) => r.method === 'POST'), 'nothing after it');
});

test('a mode lifting the guard of a stop (slow /data), then "Off": the mode never leaves after the stop', async () => {
  const base = memoryStore();
  let slow = false;
  const store = {
    ...base,
    load: () => base.load(),
    save: async (data) => {
      if (slow) {
        // A slow volume, within the 1.5 s bound.
        await new Promise((resolve) => clock.timers.setTimeout(resolve, 1000));
      }
      return base.save(data);
    },
  };
  const { testClock } = await import('./kit/index.mjs');
  const clock = testClock({ start: Date.UTC(2026, 10, 6, 10, 0, 0) });
  const t = await setup({ store, clock, config: ALLOW });
  await t.connect();
  await t.create();
  assert.deepEqual(await off(t), { success: true });
  slow = true;
  const mode = t.command('dhw1-mode', 'on');
  await t.wait(400);
  const stop = off(t);
  const [m, s] = (await t.during(Promise.all([mode, stop]), 8 * SECOND)).value;
  assert.equal(s.success, true);
  assert.equal(m.success, false);
  assert.match(m.error, /Un arrêt a été envoyé depuis/);
  const values = t.dev.posts().map((r) => r.value);
  assert.ok(!values.includes('on'), `posts: ${values.join(', ')}`);
  assert.equal(t.dev.entities[DHW_MODE].value, false);
});

test('a mode the created select lists but EMS-ESP no longer does: refused, nothing sent', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  await t.create();
  t.dev.entities[HC_MODE].enum = ['off', 'auto'];
  t.dev.entities[HC_MODE].value = 1;
  const ack = await t.command('hc1-mode', 'manual');
  assert.match(ack.error, /n’est pas un de ceux que liste ce circuit/);
  assert.equal(t.dev.posts().length, 0);
});

test('a stop sent without an answer: a quick read checks it (follow-up), and sends it again', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.route = (path, method) => (method === 'POST' ? 'silent' : undefined);
  await off(t);
  t.dev.route = undefined;
  const reads = t.dev.count('/api/system');
  await t.wait(10 * SECOND);
  assert.ok(t.dev.count('/api/system') > reads, 'a follow-up read within 10 s');
  assert.equal(stops(t), 2, 'sent again by it');
  assert.equal(t.dev.entities[DHW_MODE].value, false);
});

test('a stop answered 503: the follow-up read sends it again first, before the interval', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  t.dev.route = (path, method) => (method === 'POST' ? { status: 503, body: '' } : undefined);
  await off(t);
  t.dev.route = undefined;
  await t.wait(25 * SECOND);
  assert.equal(stops(t), 2, 'sent again by a follow-up read');
  assert.equal(t.dev.entities[DHW_MODE].value, false);
});

test('/data stuck: a stop is acked at once, never waiting for the save', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  store.frozen = true;
  const at = t.clock.monotonic();
  assert.deepEqual(await off(t), { success: true });
  assert.ok(t.clock.monotonic() - at < 200, `${Math.round(t.clock.monotonic() - at)} ms`);
  store.thaw();
});
