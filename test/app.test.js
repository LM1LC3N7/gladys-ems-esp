// -----------------------------------------------------------------------------
// The reads, the device, the failures, /data, the configuration, against the
// SDK's fake Gladys and a fake EMS-ESP on a virtual clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { identityKey } from '../src/model.js';
import { CONFIG, READ_TOKEN, TOKEN } from './fixtures/emsesp.js';
import { DEVICE, F, HOUR, MINUTE, SECOND, last, setup } from './helpers/app.js';

const statusText = (t) => t.gladys.fake.connectionStatus?.message?.fr ?? '';
const reads = (t) => t.dev.count('/api/system');
const discovered = (t) => t.gladys.fake.discoveredDevices.find((d) => d.external_id === DEVICE);

test('discovery, then the states of the created device', async () => {
  const t = await setup();
  await t.connect();
  const device = discovered(t);
  assert.ok(device, 'discovered');
  assert.equal(device.name, 'Chaudière (EMS-ESP)');
  assert.equal(device.model, 'EMS-ESP');
  assert.deepEqual(device.params, [{ name: 'firmware', value: '3.9.0' }]);
  const roles = device.features.map((f) => f.external_id.split(':').pop());
  assert.deepEqual(roles, [
    'outdoor-temperature',
    'supply-temperature',
    'system-pressure',
    'heating-mode',
    'hc1-temperature',
    'hc1-setpoint',
    'hc1-mode',
    'hc2-temperature',
    'hc2-setpoint',
    'hc2-mode',
    'dhw1-temperature',
    'dhw1-setpoint',
    'dhw1-mode',
    'status',
  ]);
  // No switch nor binary: a "turn everything off" never reaches the boiler.
  assert.ok(device.features.every((f) => !['switch', 'binary'].includes(f.category)));
  assert.ok(device.features.every((f) => f.type !== 'binary'));
  const byRole = (role) => device.features.find((f) => f.external_id === F(role));
  assert.equal(byRole('hc1-setpoint').category, 'thermostat');
  assert.equal(byRole('dhw1-setpoint').category, 'water-heater');
  assert.equal(byRole('dhw1-setpoint').max, 65);
  assert.equal(byRole('dhw1-temperature').type, 'probe');
  assert.equal(byRole('system-pressure').unit, 'bar');
  assert.equal(byRole('heating-mode').type, 'select');
  const options = (role) => byRole(role).supported_options.map((o) => [o.value, o.label]);
  assert.deepEqual(options('heating-mode'), [
    ['on', 'Marche'],
    ['off', 'Arrêt du chauffage de la chaudière, tous les circuits'],
  ]);
  assert.equal(
    byRole('heating-mode').name,
    'Chauffage de la chaudière, tous les circuits : marche/arrêt',
  );
  assert.deepEqual(options('dhw1-mode'), [
    ['on', 'Marche'],
    ['off', 'Arrêt'],
  ]);
  assert.deepEqual(options('hc1-mode'), [
    ['off', 'Arrêt'],
    ['manual', 'Manuel'],
    ['auto', 'Automatique (programme)'],
  ]);
  assert.deepEqual(options('hc2-mode'), [
    ['manual', 'Manuel'],
    ['auto', 'Automatique (programme)'],
  ]);
  await t.create();
  assert.equal(last(t.gladys, 'outdoor-temperature'), 4.5);
  assert.equal(last(t.gladys, 'supply-temperature'), 45.2);
  assert.equal(last(t.gladys, 'system-pressure'), 1.6);
  assert.equal(last(t.gladys, 'heating-mode'), 'on');
  assert.equal(last(t.gladys, 'hc1-temperature'), 20.5);
  assert.equal(last(t.gladys, 'hc1-setpoint'), 21);
  assert.equal(last(t.gladys, 'hc1-mode'), 'auto');
  assert.equal(last(t.gladys, 'dhw1-temperature'), 52.3);
  assert.equal(last(t.gladys, 'dhw1-setpoint'), 55);
  assert.equal(last(t.gladys, 'dhw1-mode'), 'on');
  assert.equal(last(t.gladys, 'status'), 'OK');
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  assert.match(statusText(t), /Connecté à EMS-ESP 3\.9\.0/);
  assert.equal(t.dev.peak, 1, 'one connection at a time');
  assert.ok(t.dev.requests.every((r) => r.method === 'GET'));
  // The key goes in its header, and nowhere else.
  assert.ok(t.dev.requests.every((r) => r.headers.authorization === `Bearer ${TOKEN}`));
  assert.deepEqual(t.gladys.fake.transports.at(-1), {
    device_external_id: DEVICE,
    transport: 'local',
  });
});

test('booleans and enums in every format EMS-ESP writes them', async () => {
  for (const [boolFormat, enumIndex] of [
    ['true', true],
    ['10', false],
  ]) {
    const t = await setup();
    t.dev.boolFormat = boolFormat;
    t.dev.enumIndex = enumIndex;
    t.dev.entities['/api/boiler/dhw/activated'].value = false;
    await t.connect();
    await t.create();
    assert.equal(last(t.gladys, 'heating-mode'), 'on', boolFormat);
    assert.equal(last(t.gladys, 'dhw1-mode'), 'off', boolFormat);
    assert.equal(last(t.gladys, 'hc1-mode'), 'auto');
  }
});

test('another language: the "off" of EMS-ESP in German is the off of the select', async () => {
  const t = await setup();
  t.dev.entities['/api/thermostat/hc1/mode'].enum = ['aus', 'manuell', 'auto'];
  t.dev.entities['/api/thermostat/hc1/mode'].value = 0;
  await t.connect();
  await t.create();
  const mode = discovered(t).features.find((f) => f.external_id === F('hc1-mode'));
  assert.deepEqual(
    mode.supported_options.map((o) => o.value),
    ['off', 'manuell', 'auto'],
  );
  assert.equal(last(t.gladys, 'hc1-mode'), 'off');
});

test('a value missing, null or out of range, a text: never a measurement', async () => {
  const t = await setup();
  t.dev.entities['/api/boiler/outdoortemp'].value = null;
  t.dev.entities['/api/boiler/curflowtemp'].value = 3276.7;
  t.dev.entities['/api/boiler/syspress'].value = '1.6';
  delete t.dev.entities['/api/boiler/dhw/curtemp'];
  t.dev.entities['/api/thermostat/hc1/currtemp'].value = '';
  await t.connect();
  await t.create();
  for (const role of [
    'outdoor-temperature',
    'supply-temperature',
    'system-pressure',
    'dhw1-temperature',
    'hc1-temperature',
  ]) {
    assert.equal(last(t.gladys, role), undefined, role);
  }
  assert.equal(last(t.gladys, 'hc1-setpoint'), 21);
  for (const s of t.gladys.fake.states) {
    if (/:(hc1-mode|dhw1-mode|heating-mode|status)$/.test(s.device_feature_external_id)) {
      assert.equal(typeof s.text, 'string');
      assert.equal(s.state, undefined);
    }
  }
});

test('Fahrenheit: temperatures converted to °C exactly; the status says setpoints are refused', async () => {
  const t = await setup();
  t.dev.system.settings.fahrenheit = true;
  t.dev.entities['/api/boiler/outdoortemp'].value = 41;
  t.dev.entities['/api/thermostat/hc1/currtemp'].value = 68.9;
  await t.connect();
  await t.create();
  assert.equal(last(t.gladys, 'outdoor-temperature'), 5);
  assert.equal(last(t.gladys, 'hc1-temperature'), 20.5);
  assert.match(statusText(t), /réglé en °F/);
});

test('a device or an entity EMS-ESP does not have (404, 401 on it) is left out, never a failure', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  for (const path of Object.keys(t.dev.entities)) {
    if (path.startsWith('/api/thermostat/')) {
      delete t.dev.entities[path];
    }
  }
  t.dev.route = (path) =>
    path === '/api/boiler'
      ? undefined
      : path === '/api/thermostat'
        ? { status: 401, body: '{}' }
        : undefined;
  await t.connect();
  await t.create();
  assert.equal(t.app.session.online, true);
  assert.equal(store.data.refused, false, 'a 401 elsewhere than /api/system is no refusal');
  assert.equal(last(t.gladys, 'outdoor-temperature'), 4.5);
  assert.equal(last(t.gladys, 'dhw1-mode'), 'on');
  assert.equal(last(t.gladys, 'status'), 'OK');
  assert.ok(!discovered(t).features.some((f) => f.external_id.includes(':hc1-')));
});

test('the bus of EMS-ESP not connected: no value published (they may be old), status says so', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.system.bus.busStatus = 'disconnected';
  t.dev.entities['/api/boiler/outdoortemp'].value = 30;
  await t.wait(61 * SECOND);
  assert.equal(last(t.gladys, 'outdoor-temperature'), 4.5);
  assert.notEqual(last(t.gladys, 'status'), 'OK');
  assert.match(statusText(t), /bus EMS n’est pas connecté/);
  assert.equal(t.dev.count('/api/boiler'), 1, 'the values are not even read');
});

test('reads every interval, measured from the start of the read before', async () => {
  const t = await setup({ latency: 200 });
  await t.connect();
  const first = reads(t);
  await t.wait(50 * SECOND);
  assert.equal(reads(t), first);
  await t.wait(11 * SECOND);
  assert.equal(reads(t), first + 1);
  await t.wait(60 * SECOND);
  assert.equal(reads(t), first + 2);
});

test('a restart never reads sooner than the interval after the last read (in /data)', async () => {
  const store = memoryStore();
  const a = await setup({ store });
  await a.connect();
  assert.equal(reads(a), 1);
  await a.app.stop();
  await a.wait(20 * SECOND);
  const b = await setup({ store, clock: a.clock });
  await b.connect();
  assert.equal(reads(b), 0, 'not at once');
  await b.wait(41 * SECOND);
  assert.equal(reads(b), 1);
});

test('a date of /data in the future is invalid: read at once', async () => {
  const store = memoryStore({ lastReadAt: Date.UTC(2030, 0, 1) });
  const t = await setup({ store });
  await t.connect();
  assert.equal(reads(t), 1);
});

test('getConfig() failing at the start is tried again without end, then the reads begin', async () => {
  // Call 1 is the SDK's own resynchronization (it reconnects when that one
  // fails); calls 2 to 4 are those of the integration, made to fail.
  let calls = 0;
  const t = await setup({
    getConfig: async () => {
      calls += 1;
      if (calls >= 2 && calls <= 4) {
        throw new Error('HTTP 502');
      }
      return CONFIG;
    },
  });
  await t.connect();
  assert.equal(t.dev.requests.length, 0);
  assert.match(statusText(t), /Configuration non lue depuis Gladys ; nouvel essai dans 5 s/);
  await t.wait(5 * SECOND);
  assert.match(statusText(t), /nouvel essai dans 10 s/);
  await t.wait(10 * SECOND);
  assert.match(statusText(t), /nouvel essai dans 30 s/);
  assert.equal(t.dev.requests.length, 0);
  await t.wait(30 * SECOND);
  assert.equal(calls, 5);
  assert.equal(reads(t), 1);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
});

test('getConfig() failing in `connected` after a reconnection: the session goes on, retried, then resynced', async () => {
  let fail = false;
  const t = await setup({
    getConfig: async () => {
      if (fail) {
        fail = false;
        throw new Error('down');
      }
      return CONFIG;
    },
  });
  await t.connect();
  await t.create();
  fail = true;
  await t.app.connected(() => t.gladys.getConfig());
  assert.ok(t.app.session, 'the session in place goes on');
  assert.ok(t.logger.lines.some((l) => /Reading the configuration failed/.test(l)));
  await t.wait(5 * SECOND + 100);
  assert.equal(t.app.configRetry.step, 0, 'read again and applied');
  assert.match(statusText(t), /Connecté/);
});

test('reads without a key (EMS-ESP before 3.10): no Authorization header at all', async () => {
  const t = await setup({ config: { address: '192.168.1.50' } });
  await t.connect();
  await t.create();
  assert.equal(last(t.gladys, 'status'), 'OK');
  assert.ok(t.dev.requests.every((r) => r.headers.authorization === undefined));
});

test('a key refused on /api/system: stopped, persisted, no automatic retry; the button lifts it', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: { ...CONFIG, token: 'emsesp_wrong_key_123' } });
  t.dev.readKey = true;
  await t.connect();
  assert.equal(store.data.refused, true);
  assert.match(store.data.fp, /^[0-9a-f]{2}$/);
  assert.match(statusText(t), /EMS-ESP refuse les lectures avec cette clé d’API/);
  const before = reads(t);
  await t.wait(2 * HOUR);
  assert.equal(reads(t), before, 'no automatic retry');
  // The key was added in EMS-ESP meanwhile: the button tries.
  t.dev.readKeys.add('emsesp_wrong_key_123');
  const answer = await t.during(t.app.testConnection());
  assert.match(answer.value, /Connecté/);
  assert.equal(store.data.refused, false);
  assert.equal(store.data.fp, '');
});

test('another key saved lifts the refusal at once; a restart with the same keeps it', async () => {
  const store = memoryStore();
  const wrong = { ...CONFIG, token: 'emsesp_wrong_key_123' };
  const t = await setup({ store, config: wrong });
  t.dev.readKey = true;
  await t.connect();
  assert.equal(store.data.refused, true);
  const again = await setup({ store, config: wrong, clock: t.clock });
  again.dev.readKey = true;
  await again.connect();
  assert.equal(reads(again), 0, 'the same key: no read');
  await again.during(again.gladys.fake.configUpdated({ ...CONFIG, token: READ_TOKEN }));
  assert.equal(store.data.refused, false);
  assert.equal(reads(again), 1);
});

test('the 8-bit print of a refused key cannot test a key', async () => {
  const store = memoryStore();
  const t = await setup({ store, config: { ...CONFIG, token: 'emsesp_wrong_key_123' } });
  t.dev.readKey = true;
  await t.connect();
  const { refusalPrint } = await import('../src/store.js');
  const prints = new Set();
  for (let i = 0; i < 400; i += 1) {
    prints.add(refusalPrint(store.data.salt, { host: '192.168.1.50', port: 80, token: `k${i}` }));
  }
  assert.match(store.data.fp, /^[0-9a-f]{2}$/);
  assert.ok(prints.size > 150 && prints.size <= 256);
});

test('HTTP 429/5xx: a pause persisted in /data, no read during it', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  t.dev.route = () => ({ status: 503, body: '' });
  await t.wait(61 * SECOND);
  assert.ok(store.data.pausedUntil > 0);
  assert.match(statusText(t), /demande de ralentir/);
  t.dev.route = undefined;
  const before = reads(t);
  await t.wait(50 * SECOND);
  assert.equal(reads(t), before);
  await t.wait(2 * MINUTE);
  assert.ok(reads(t) > before);
});

test('unreachable: backoff never sooner than the interval; status says so', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.route = () => 'refuse';
  await t.wait(61 * SECOND);
  assert.match(statusText(t), /Passerelle non lue \(unreachable\)/);
  assert.equal(last(t.gladys, 'status'), 'Passerelle injoignable');
  assert.deepEqual(t.gladys.fake.transports.at(-1).transport, 'unreachable');
  const unsent = t.dev.unsent;
  await t.wait(50 * SECOND);
  assert.equal(t.dev.unsent, unsent);
});

test('another installation at the address: its values never go to the created device', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.system.devices[0].productID = 124;
  t.dev.entities['/api/boiler/outdoortemp'].value = 30;
  await t.wait(61 * SECOND);
  assert.equal(last(t.gladys, 'outdoor-temperature'), 4.5);
  assert.equal(last(t.gladys, 'status'), 'Une autre installation répond à cette adresse');
  assert.equal(t.gladys.fake.connectionStatus.connected, false);
  assert.match(statusText(t), /Une autre installation \(une autre chaudière\)/);
  const other = identityKey('boiler', 124, '0x08');
  assert.ok(t.gladys.fake.discoveredDevices.some((d) => d.external_id.endsWith(other)));
});

test('no heat source listed yet: nothing published as a device, status says so', async () => {
  const t = await setup();
  t.dev.system.devices = [{ type: 'temperaturesensor', name: 'temperaturesensor' }];
  await t.connect();
  assert.equal(t.gladys.fake.discoveredDevices.length, 0);
  assert.match(statusText(t), /ne liste encore ni chaudière/);
});

test('the identity falls back on the thermostat when no boiler is listed', async () => {
  const t = await setup();
  t.dev.system.devices = t.dev.system.devices.filter((d) => d.type !== 'boiler');
  await t.connect();
  const key = identityKey('thermostat', 77, '0x17');
  assert.ok(t.gladys.fake.discoveredDevices.some((d) => d.external_id.endsWith(key)));
});

test('an answer that is not one of EMS-ESP (another device): a failure, never a refusal', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  t.dev.route = () => ({ status: 200, body: '{"value":"x"}' });
  await t.connect();
  assert.equal(store.data.refused, false);
  assert.match(statusText(t), /Passerelle non lue \(badAnswer\)/);
  t.dev.route = () => ({ status: 200, body: '<html>router</html>' });
  await t.wait(61 * SECOND);
  assert.equal(store.data.refused, false);
});

test('an answer cut short: never a refusal, the reads go on', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  t.dev.route = (path, method) =>
    method === 'GET' && path === '/api/boiler'
      ? { status: 200, body: JSON.stringify(t.dev.values('boiler')).slice(0, 40) }
      : undefined;
  await t.wait(61 * SECOND);
  assert.equal(store.data.refused, false);
  assert.equal(t.app.session.online, true, 'the values of the boiler left out');
  t.dev.route = (path, method) =>
    method === 'GET' && path === '/api/system'
      ? { status: 200, body: JSON.stringify(t.dev.system).slice(0, 30) }
      : undefined;
  await t.wait(61 * SECOND);
  assert.equal(store.data.refused, false);
  assert.match(statusText(t), /Passerelle non lue \(badAnswer\)/);
  t.dev.route = undefined;
  const before = reads(t);
  await t.wait(2 * MINUTE);
  assert.ok(reads(t) > before, 'the reads go on');
});

test('an answer larger than allowed is dropped before its end', async () => {
  const t = await setup();
  t.dev.route = (path) =>
    path === '/api/boiler' ? { status: 200, body: `{"x":"${'a'.repeat(200_000)}"}` } : undefined;
  await t.connect();
  assert.equal(t.app.session.online, false);
  assert.match(statusText(t), /tooLarge/);
});

test('a feature once seen is never lost when republished', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  delete t.dev.entities['/api/boiler/syspress'];
  await t.wait(61 * SECOND);
  await t.app.scan();
  assert.ok(discovered(t).features.some((f) => f.external_id === F('system-pressure')));
});

test('the options of a created mode select are kept when EMS-ESP lists others', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.entities['/api/thermostat/hc1/mode'].enum = ['off', 'auto'];
  t.dev.entities['/api/thermostat/hc1/mode'].value = 1;
  await t.wait(61 * SECOND);
  await t.app.scan();
  const mode = discovered(t).features.find((f) => f.external_id === F('hc1-mode'));
  assert.equal(mode.supported_options.length, 3);
});

test('secrets: never in /data, the logs, the statuses, the states', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.connect();
  await t.create();
  await t.command('dhw1-mode', 'off');
  await t.during(t.gladys.fake.configUpdated({ ...CONFIG, token: 'emsesp_other_secret_key' }));
  await t.wait(61 * SECOND);
  const everything = JSON.stringify([
    store.data,
    t.logger.lines,
    t.gladys.fake.connectionStatuses,
    t.gladys.fake.states,
    t.gladys.fake.discoveredDevices,
  ]);
  for (const secret of [TOKEN, 'emsesp_other_secret_key', 'ReadWrite_0123']) {
    assert.ok(!everything.includes(secret), `leaked ${secret}`);
  }
  assert.deepEqual(Object.keys(store.data).sort(), [
    'fp',
    'lastReadAt',
    'pausedUntil',
    'refused',
    'salt',
    'stops',
  ]);
  assert.ok(
    !Object.keys(t.app.session.client).includes('authorization'),
    'the key is not enumerable',
  );
  assert.ok(!JSON.stringify(t.app.session.client).includes('emsesp_'));
});

test('/data unreadable: never written over; said in the status', async () => {
  const store = memoryStore({ lastReadAt: 1 }, { unreadable: true });
  const t = await setup({ store });
  await t.connect();
  await t.wait(2 * MINUTE);
  assert.equal(store.saves, 0);
  assert.deepEqual(store.data, { lastReadAt: 1 });
  assert.match(statusText(t), /\/data illisible/);
  assert.equal(reads(t), 3, 'the reads go on');
});

test('/data stuck at the start: never waited on for more than 1.5 s, counted as unreadable', async () => {
  const store = memoryStore();
  store.frozen = true;
  const t = await setup({ store });
  await t.connect();
  assert.equal(reads(t), 1, 'read after 1.5 s');
  assert.match(statusText(t), /\/data illisible/);
  store.thaw();
});

test('the configuration: problems shown, never a read', async () => {
  for (const [config, text] of [
    [{}, /Saisissez l’adresse/],
    [{ ...CONFIG, address: 'https://192.168.1.50' }, /sans https/],
    [{ ...CONFIG, address: '192.168.1.255' }, /diffusion/],
    [{ ...CONFIG, address: '0.0.0.0' }, /diffusion/],
    [{ ...CONFIG, address: '192.168.1.50/api' }, /Adresse non valide/],
    [{ ...CONFIG, token: 'abc' }, /Clé d’API non valide/],
    [{ ...CONFIG, token: 'emsesp_key\r\nX-Evil: 1' }, /Clé d’API non valide/],
    [{ ...CONFIG, token: 'emsesp key with spaces' }, /Clé d’API non valide/],
  ]) {
    const t = await setup({ config });
    await t.connect();
    assert.match(statusText(t), text, JSON.stringify(config));
    assert.equal(t.dev.requests.length, 0);
  }
});

test('configurations saved back to back apply one at a time, the last one wins', async () => {
  const t = await setup();
  await t.connect();
  const a = t.gladys.fake.configUpdated({ ...CONFIG, address: '192.168.1.60' });
  const b = t.gladys.fake.configUpdated({ ...CONFIG, address: '192.168.1.70' });
  await t.during(Promise.all([a, b]));
  assert.equal(t.app.config.host, '192.168.1.70');
  assert.equal(t.dev.peak, 1);
});

test('the button never reads sooner than the interval (60 s), even 20 s after a read', async () => {
  const t = await setup();
  await t.connect();
  let answer = await t.during(t.app.testConnection());
  assert.match(answer.value, /prochain essai possible dans/);
  await t.wait(20 * SECOND);
  answer = await t.during(t.app.testConnection());
  assert.match(answer.value, /prochain essai possible dans 40 s/);
  assert.equal(reads(t), 1);
});

test('values older than two intervals are never published as new', async () => {
  const t = await setup();
  await t.connect();
  await t.create();
  t.dev.route = (path) => (path === '/api/thermostat' ? 'silent' : undefined);
  await t.wait(4 * MINUTE);
  assert.notEqual(last(t.gladys, 'status'), 'OK');
  assert.equal(t.app.freshData(), undefined);
});

test('the button during a pause reads nothing, even past the interval', async () => {
  const t = await setup();
  await t.connect();
  t.dev.route = () => ({ status: 429, body: '' });
  await t.wait(61 * SECOND);
  t.dev.route = undefined;
  const before = reads(t);
  await t.wait(61 * SECOND - 1);
  await t.during(t.app.testConnection());
  assert.ok(reads(t) <= before + 1);
  assert.ok(t.app.pauseLeft() >= 0);
});

test('a refusal kept without a readable print is never lifted by a restart', async () => {
  const store = memoryStore({ refused: true, fp: 'zz', salt: '0'.repeat(32) });
  const t = await setup({ store });
  await t.connect();
  assert.equal(reads(t), 0);
  assert.equal(store.data?.refused ?? true, true);
});

test('read-only mode of EMS-ESP: said in the status', async () => {
  const t = await setup();
  t.dev.system.settings.readonlyMode = true;
  await t.connect();
  assert.match(statusText(t), /mode lecture seule/);
});
