// -----------------------------------------------------------------------------
// Modes, on and setpoints: behind the option, decided on a fresh read,
// bounded (hot water 65 °C at most, room 5-30 °C), success only on a read
// showing the value.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { CONFIG, READ_TOKEN } from './fixtures/emsesp.js';
import { DEVICE, F, SECOND, last, setup } from './helpers/app.js';

const ALLOW = { ...CONFIG, allow_commands: true };
const DHW_SET = '/api/boiler/dhw/seltemp';
const DHW_ON = '/api/boiler/dhw/activated';
const HEATING = '/api/boiler/heatingactivated';
const HC_SET = '/api/thermostat/hc1/seltemp';
const HC_MODE = '/api/thermostat/hc1/mode';
const posts = (t) => t.dev.posts();

test('the option is off by default: modes, on and setpoints refused, nothing sent nor read', async () => {
  const t = await setup();
  t.dev.entities[DHW_ON].value = false;
  t.dev.entities[HEATING].value = false;
  await t.connect();
  await t.create();
  const before = t.dev.requests.length;
  for (const [role, value] of [
    ['hc1-mode', 'manual'],
    ['dhw1-mode', 'on'],
    ['heating-mode', 'on'],
    ['dhw1-setpoint', 50],
    ['hc1-setpoint', 20],
  ]) {
    const ack = await t.command(role, value);
    assert.equal(ack.success, false);
    assert.match(ack.error, /Les commandes sont désactivées/, role);
  }
  // A value no select lists is refused as such, before the option.
  for (const role of ['dhw1-mode', 'heating-mode', 'hc1-mode']) {
    assert.match((await t.command(role, 'x')).error, /n’est pas un de ceux/, role);
  }
  assert.equal(t.dev.requests.length, before, 'not even a read');
});

test('read-only features and unknown modes refuse any command', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  await t.create();
  for (const role of [
    'outdoor-temperature',
    'hc1-temperature',
    'dhw1-temperature',
    'status',
    'system-pressure',
    'heating-setpoint',
  ]) {
    const ack = await t.command(role, 1);
    assert.match(ack.error, /lecture seule/, role);
  }
  for (const value of ['toggle', 'OFF', 42, 'true', 'aus']) {
    const ack = await t.command('dhw1-mode', value);
    assert.match(ack.error, /n’est pas un de ceux que liste ce circuit/, String(value));
  }
  // hc2 (an RC310) lists no "off".
  assert.match((await t.command('hc2-mode', 'off')).error, /n’est pas un de ceux/);
  assert.equal(posts(t).length, 0);
});

test('a mode with the option: a fresh read, the mode written as EMS-ESP lists it, success once read back', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  await t.create();
  const before = t.dev.requests.length;
  const ack = await t.command('hc1-mode', 'manual');
  assert.deepEqual(ack, { success: true });
  assert.deepEqual(
    t.dev.requests.slice(before).map((r) => `${r.method} ${r.path}`),
    ['GET /api/system', `GET ${HC_MODE}`, `POST ${HC_MODE}`, `GET ${HC_MODE}`],
  );
  assert.equal(posts(t)[0].value, 'manual');
  await t.wait(6 * SECOND);
  assert.equal(last(t.gladys, 'hc1-mode'), 'manual');
});

test('a mode in the language of EMS-ESP is written in it', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.entities[HC_MODE].enum = ['aus', 'manuell', 'auto'];
  await t.connect();
  await t.create();
  assert.deepEqual(await t.command('hc1-mode', 'manuell'), { success: true });
  assert.equal(posts(t)[0].value, 'manuell');
});

test('the heating and the hot water switched on: behind the option, "on" written, read back', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.entities[DHW_ON].value = false;
  t.dev.entities[HEATING].value = false;
  await t.connect();
  await t.create();
  assert.deepEqual(await t.command('dhw1-mode', 'on'), { success: true });
  assert.deepEqual(await t.command('heating-mode', 'on'), { success: true });
  assert.deepEqual(
    posts(t).map((r) => [r.path, r.value]),
    [
      [DHW_ON, 'on'],
      [HEATING, 'on'],
    ],
  );
  await t.wait(6 * SECOND);
  assert.equal(last(t.gladys, 'dhw1-mode'), 'on');
  assert.equal(last(t.gladys, 'heating-mode'), 'on');
});

test('the mode already set and no stop of ours: nothing sent', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  await t.create();
  assert.deepEqual(await t.command('hc1-mode', 'auto'), { success: true });
  assert.deepEqual(await t.command('dhw1-mode', 'on'), { success: true });
  assert.equal(posts(t).length, 0);
});

test('room setpoint: half degrees, 5-30 °C, read back', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  await t.create();
  assert.deepEqual(await t.command('hc1-setpoint', 21.5), { success: true });
  assert.deepEqual(
    posts(t).map((r) => [r.path, r.value]),
    [[HC_SET, 21.5]],
  );
  assert.match((await t.command('hc1-setpoint', 21.3)).error, /Demi-degrés seulement/);
  assert.match((await t.command('hc1-setpoint', 31)).error, /de 5 à 30 °C/);
  assert.match((await t.command('hc1-setpoint', 4.5)).error, /de 5 à 30 °C/);
  assert.match((await t.command('hc1-setpoint', '')).error, /Ce n’est pas un nombre/);
  assert.match((await t.command('hc1-setpoint', null)).error, /Ce n’est pas un nombre/);
  assert.match((await t.command('hc1-setpoint', true)).error, /Ce n’est pas un nombre/);
  await t.wait(6 * SECOND);
  assert.equal(last(t.gladys, 'hc1-setpoint'), 21.5);
});

test('room setpoint within the bounds EMS-ESP gives (10.2-25.4 here), high bound rounded down', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  Object.assign(t.dev.entities[HC_SET], { min: 10.2, max: 25.4 });
  assert.match((await t.command('hc1-setpoint', 26)).error, /de 10\.5 à 25 °C/);
  assert.match((await t.command('hc1-setpoint', 25.5)).error, /de 10\.5 à 25 °C/);
  assert.match((await t.command('hc1-setpoint', 10)).error, /de 10\.5 à 25 °C/);
  assert.deepEqual(await t.command('hc1-setpoint', 25), { success: true });
});

test('hot water: 65 °C at most whatever EMS-ESP allows (254 here), whole degrees', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  await t.create();
  assert.match((await t.command('dhw1-setpoint', 66)).error, /de 20 à 65 °C/);
  assert.match((await t.command('dhw1-setpoint', 70)).error, /de 20 à 65 °C/);
  assert.match((await t.command('dhw1-setpoint', 64.5)).error, /Degrés entiers seulement/);
  assert.deepEqual(await t.command('dhw1-setpoint', 65), { success: true });
  assert.deepEqual(
    posts(t).map((r) => [r.path, r.value]),
    [[DHW_SET, 65]],
  );
  await t.wait(6 * SECOND);
  assert.equal(last(t.gladys, 'dhw1-setpoint'), 65);
});

test('hot water: the configured ceiling and a lower maximum of EMS-ESP win', async () => {
  const t = await setup({ config: { ...ALLOW, max_dhw: 55 } });
  await t.connect();
  assert.match((await t.command('dhw1-setpoint', 56)).error, /de 20 à 55 °C/);
  Object.assign(t.dev.entities[DHW_SET], { min: 30, max: 50 });
  assert.match((await t.command('dhw1-setpoint', 52)).error, /de 30 à 50 °C/);
  assert.deepEqual(await t.command('dhw1-setpoint', 50), { success: true });
  // A ceiling typed above 65 is 65.
  const u = await setup({ config: { ...ALLOW, max_dhw: 90 } });
  await u.connect();
  assert.match((await u.command('dhw1-setpoint', 70)).error, /de 20 à 65 °C/);
});

test('a setpoint without bounds, without value, or read only: refused, nothing sent', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  delete t.dev.entities[DHW_SET].max;
  delete t.dev.entities[DHW_SET].min;
  assert.match((await t.command('dhw1-setpoint', 50)).error, /ne donne pas cette valeur/);
  Object.assign(t.dev.entities[DHW_SET], { min: 0, max: 80, value: undefined });
  assert.match((await t.command('dhw1-setpoint', 50)).error, /ne donne pas cette valeur/);
  Object.assign(t.dev.entities[DHW_SET], { value: 55, writeable: false });
  assert.match((await t.command('dhw1-setpoint', 50)).error, /en lecture seule : rien envoyé/);
  t.dev.entities[HC_MODE].writeable = false;
  assert.match((await t.command('hc1-mode', 'manual')).error, /en lecture seule : rien envoyé/);
  assert.equal(posts(t).length, 0);
});

test('EMS-ESP in °F: setpoints refused (nothing sent), on/off and modes still written', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.system.settings.fahrenheit = true;
  t.dev.entities[DHW_SET].value = 131;
  t.dev.entities[DHW_SET].uom = '°F';
  t.dev.entities[DHW_ON].value = false;
  await t.connect();
  await t.create();
  assert.match((await t.command('dhw1-setpoint', 50)).error, /réglé en °F/);
  assert.match((await t.command('hc1-setpoint', 20)).error, /réglé en °F/);
  assert.deepEqual(await t.command('dhw1-mode', 'on'), { success: true });
  assert.deepEqual(
    posts(t).map((r) => r.path),
    [DHW_ON],
  );
  // The setpoint read in °F is shown in °C.
  assert.equal(last(t.gladys, 'dhw1-setpoint'), 55);
});

test('the same value: nothing sent', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  assert.deepEqual(await t.command('dhw1-setpoint', 55), { success: true });
  assert.equal(posts(t).length, 0);
});

test('applied late: "not applied yet", then the follow-up reads publish it', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  await t.create();
  t.dev.applyDelay = 3 * SECOND;
  const ack = await t.command('dhw1-setpoint', 50);
  assert.match(ack.error, /Envoyée et acceptée, pas encore appliquée/);
  await t.wait(6 * SECOND);
  assert.equal(last(t.gladys, 'dhw1-setpoint'), 50);
});

test('a write answered but never applied: "not applied yet", never success', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.entities[DHW_ON].value = false;
  await t.connect();
  t.dev.ignoreWrites = true;
  assert.match((await t.command('hc1-mode', 'manual')).error, /pas encore appliquée/);
  assert.match((await t.command('dhw1-setpoint', 50)).error, /pas encore appliquée/);
  assert.match((await t.command('dhw1-mode', 'on')).error, /pas encore appliquée/);
});

test('the option turned off while the command waits: nothing sent', async () => {
  const t = await setup({ config: ALLOW, latency: 200 });
  await t.connect();
  const ack = t.command('dhw1-setpoint', 50);
  await t.wait(300);
  void t.gladys.fake.configUpdated({ ...CONFIG, allow_commands: false });
  assert.match((await ack).error, /désactivées/);
  assert.equal(posts(t).length, 0);
});

test('the option turned off while the write connects: checked right before it leaves', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  t.dev.connectDelay = 300;
  t.dev.onConnect = (path, method) => {
    if (method === 'POST') {
      void t.gladys.fake.configUpdated({ ...CONFIG, allow_commands: false });
    }
  };
  const ack = await t.command('dhw1-setpoint', 50);
  assert.match(ack.error, /désactivées/);
  assert.equal(posts(t).length, 0);
});

test('the ceiling lowered while the write connects: checked right before it leaves', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  t.dev.connectDelay = 300;
  t.dev.onConnect = (path, method) => {
    if (method === 'POST') {
      void t.gladys.fake.configUpdated({ ...ALLOW, max_dhw: 45 });
    }
  };
  const ack = await t.command('dhw1-setpoint', 50);
  assert.match(ack.error, /de 20 à 45 °C/);
  assert.equal(posts(t).length, 0);
});

test('a scene: modes, on and setpoints at once (150 ms per request), all set', async () => {
  const t = await setup({ config: ALLOW, latency: 150 });
  t.dev.entities[HEATING].value = false;
  await t.connect();
  const device = { external_id: DEVICE };
  const send = (role, value) => t.gladys.fake.setValue(device, { external_id: F(role) }, value);
  const all = Promise.all([
    send('hc1-mode', 'manual'),
    send('hc1-setpoint', 20),
    send('heating-mode', 'on'),
    send('dhw1-setpoint', 50),
  ]);
  const outcome = await t.during(all, 6 * SECOND, 10);
  assert.deepEqual(outcome.value, [
    { success: true },
    { success: true },
    { success: true },
    { success: true },
  ]);
  assert.equal(t.dev.peak, 1);
});

test('a scene on five targets answering in 500 ms each: each acked within 4.3 s, none lost', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.entities[HEATING].value = false;
  t.dev.entities[DHW_ON].value = false;
  await t.connect();
  await t.create();
  t.dev.latency = 500;
  const device = { external_id: DEVICE };
  const send = (role, value) => t.gladys.fake.setValue(device, { external_id: F(role) }, value);
  const at = t.clock.monotonic();
  const outcome = await t.during(
    Promise.all([
      send('hc1-mode', 'manual'),
      send('hc2-mode', 'manual'),
      send('heating-mode', 'on'),
      send('dhw1-mode', 'on'),
      send('dhw1-setpoint', 50),
    ]),
    6 * SECOND,
    10,
  );
  assert.ok(t.clock.monotonic() - at < 4_400, 'acked within 4.3 s');
  for (const ack of outcome.value) {
    if (!ack.success) {
      assert.match(ack.error, /rien envoyé|sans confirmation|pas encore appliquée/);
    }
  }
  // Every one that was not confirmed in time is checked by the follow-up reads.
  await t.wait(25 * SECOND);
  assert.equal(t.dev.peak, 1);
});

test('a setpoint alone on a gateway answering in 700 ms: set and confirmed', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  t.dev.latency = 700;
  assert.deepEqual(await t.command('dhw1-setpoint', 50), { success: true });
});

test('a 5xx on a write: sent, without confirmation; the pause holds the next ones', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  t.dev.route = (path, method) => (method === 'POST' ? { status: 500, body: '' } : undefined);
  const ack = await t.command('dhw1-setpoint', 50);
  assert.match(ack.error, /Envoyée, sans confirmation \(HTTP 500\)/);
  t.dev.route = undefined;
  assert.match((await t.command('dhw1-setpoint', 51)).error, /rien envoyé pendant la pause/);
});

test('a write EMS-ESP refuses (400): said, the reads go on, no refusal', async () => {
  const store = memoryStore();
  const t = await setup({ config: ALLOW, store });
  await t.connect();
  t.dev.route = (path, method) => (method === 'POST' ? { status: 400, body: '{}' } : undefined);
  const ack = await t.command('dhw1-setpoint', 50);
  assert.match(ack.error, /La passerelle a refusé la commande \(HTTP 400\)/);
  assert.equal(store.data.refused, false);
  t.dev.route = undefined;
  await t.wait(61 * SECOND);
  assert.equal(t.app.session.online, true);
});

test('a key with the read right only: the write refused (401), said, the reads go on', async () => {
  const store = memoryStore();
  const t = await setup({ config: { ...ALLOW, token: READ_TOKEN }, store });
  t.dev.readKey = true;
  await t.connect();
  await t.create();
  const ack = await t.command('dhw1-setpoint', 50);
  assert.match(ack.error, /droit « Lecture et écriture »/);
  assert.equal(store.data.refused, false);
  await t.wait(61 * SECOND);
  assert.equal(t.app.session.online, true);
  assert.equal(last(t.gladys, 'status'), 'OK');
});

test('a silent gateway: "nothing sent" when the fresh read does not answer, ack within 5 s', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  t.dev.route = () => 'silent';
  const at = t.clock.monotonic();
  const ack = await t.command('dhw1-setpoint', 50);
  assert.ok(t.clock.monotonic() - at < 4_500);
  assert.match(ack.error, /n’a pas répondu à temps : rien envoyé/);
  assert.equal(posts(t).length, 0);
});

test('another installation answers at the address: refused, nothing written', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  await t.create();
  t.dev.system.devices[0].deviceID = '0x09';
  const ack = await t.command('dhw1-setpoint', 50);
  assert.match(ack.error, /Une autre installation répond à cette adresse/);
  t.dev.system.devices = [];
  assert.match(
    (await t.command('dhw1-setpoint', 50)).error,
    /identité de l’installation n’a pas pu être lue/,
  );
  assert.equal(posts(t).length, 0);
});

test('reads refused with this key: commands refused at once, nothing read', async () => {
  const t = await setup({ config: { ...ALLOW, token: 'emsesp_bad_key_000' } });
  t.dev.readKey = true;
  await t.connect();
  const before = t.dev.requests.length;
  const ack = await t.command('dhw1-setpoint', 50);
  assert.match(ack.error, /EMS-ESP refuse les lectures avec cette clé d’API/);
  assert.equal(t.dev.requests.length, before);
});

test('/data unreadable: modes and setpoints refused, nothing written', async () => {
  const t = await setup({ config: ALLOW, store: memoryStore(null, { unreadable: true }) });
  await t.connect();
  for (const [role, value] of [
    ['dhw1-setpoint', 50],
    ['hc1-mode', 'manual'],
  ]) {
    const ack = await t.command(role, value);
    assert.match(ack.error, /\/data ne peut être lu ou écrit/, role);
  }
  assert.equal(posts(t).length, 0);
});

test('more than 4 commands waiting: refused at once', async () => {
  const t = await setup({ config: ALLOW, latency: 400 });
  await t.connect();
  const device = { external_id: DEVICE };
  const send = (v) => t.gladys.fake.setValue(device, { external_id: F('dhw1-setpoint') }, v);
  const waiting = [send(50), send(51), send(52), send(53)];
  const full = await t.during(send(54), 100);
  assert.match(full.value.error, /Trop de commandes en attente/);
  await t.during(Promise.all(waiting), 10 * SECOND);
});

test('a read begun before a write is never applied after it', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  await t.create();
  assert.equal(last(t.gladys, 'dhw1-mode'), 'on');
  // Switched off on the boiler: the next periodic read sees "off".
  t.dev.entities[DHW_ON].value = false;
  t.dev.latency = 100;
  const device = { external_id: DEVICE };
  let ack;
  let mark;
  // The periodic read gets the values of the boiler (hot water "off"), then
  // the command writes "on" before that read ends.
  t.dev.onConnect = (path, method) => {
    if (!ack && path === '/api/boiler' && method === 'GET' && t.app.session.running) {
      mark = t.gladys.fake.states.length;
      ack = t.gladys.fake.setValue(device, { external_id: F('dhw1-mode') }, 'on');
    }
  };
  await t.wait(61 * SECOND);
  assert.ok(ack, 'the command came during the read');
  assert.deepEqual((await t.during(ack, 6 * SECOND)).value, { success: true });
  await t.wait(2 * SECOND);
  assert.equal(t.app.session.running, undefined, 'the read has ended');
  // Its values ("off", read before the write) were dropped, never published.
  const stale = t.gladys.fake.states
    .slice(mark)
    .filter((s) => s.device_feature_external_id === F('dhw1-mode') && s.text === 'off');
  assert.deepEqual(stale, []);
  // The follow-up read, begun after the write, shows it.
  await t.wait(5 * SECOND);
  assert.equal(last(t.gladys, 'dhw1-mode'), 'on');
});

test('the option off: every command of a burst refused as such, none queued', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  const device = { external_id: DEVICE };
  const send = (v) => t.gladys.fake.setValue(device, { external_id: F('dhw1-setpoint') }, v);
  const acks = await t.during(Promise.all([50, 51, 52, 53, 54, 55].map(send)), 6 * SECOND);
  for (const ack of acks.value) {
    assert.match(ack.error, /Les commandes sont désactivées/);
  }
});

test('hot water: a ceiling above 65 in memory still gives 65 at most (both guards)', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  // A normalization gone wrong: the hard bounds still stop at 65 °C.
  t.app.config.dhwCeiling = 70;
  const before = t.dev.requests.length;
  assert.match((await t.command('dhw1-setpoint', 66)).error, /de 20 à 65 °C/);
  assert.equal(t.dev.requests.length, before, 'refused on arrival, not even read');
  // Hard bounds gone wrong too: the final guard right before sending.
  t.app.hardBounds = () => ({ low: 20, high: 90 });
  assert.match((await t.command('dhw1-setpoint', 70)).error, /de 20 à 65 °C/);
  assert.equal(posts(t).length, 0);
});

test('a value out of the bounds is refused even when EMS-ESP already shows it', async () => {
  const t = await setup({ config: ALLOW });
  await t.connect();
  // The setpoint is at 60 (set elsewhere), above the maximum EMS-ESP gives now.
  Object.assign(t.dev.entities[DHW_SET], { value: 60, min: 30, max: 50 });
  const ack = await t.command('dhw1-setpoint', 60);
  assert.match(ack.error, /de 30 à 50 °C/);
});
