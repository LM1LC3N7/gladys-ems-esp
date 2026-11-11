// -----------------------------------------------------------------------------
// The answers of EMS-ESP checked and reduced: identity hashed, system,
// numbers strict and plausible, booleans in every format, enums in every
// language, lists bounded, °F converted exactly.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boolOf,
  circuitsOf,
  identityKey,
  keyOfDevices,
  modeOf,
  modeValueOf,
  numberIn,
  setpointOf,
  systemOf,
  temperatureOf,
  toCelsius,
  valueAt,
} from '../src/model.js';

const boiler = { type: 'boiler', productID: 123, deviceID: '0x08' };
const thermostat = { type: 'thermostat', productID: 77, deviceID: '0x17' };

test('identity: the heat source hashed, then the heat pump, then the thermostat; unknown when missing', () => {
  assert.equal(keyOfDevices([thermostat, boiler]), identityKey('boiler', 123, '0x08'));
  assert.equal(keyOfDevices([thermostat]), identityKey('thermostat', 77, '0x17'));
  assert.equal(
    keyOfDevices([thermostat, { type: 'heatpump', productID: 200, deviceID: '0x38' }]),
    identityKey('heatpump', 200, '0x38'),
  );
  assert.match(identityKey('boiler', 123, '0x08'), /^[0-9a-f]{16}$/);
  assert.equal(identityKey('boiler', 123, '0x0A'), identityKey('boiler', 123, '0x0a'));
  for (const bad of [
    { ...boiler, productID: '123' },
    { ...boiler, productID: 0 },
    { ...boiler, productID: 1.5 },
    { ...boiler, productID: 70000 },
    { ...boiler, deviceID: '8' },
    { ...boiler, deviceID: '0x0800' },
    { ...boiler, type: 'mixer' },
  ]) {
    assert.equal(keyOfDevices([bad]), undefined, JSON.stringify(bad));
  }
  assert.equal(keyOfDevices('x'), undefined);
  assert.equal(keyOfDevices([JSON.parse('{"__proto__":{"type":"boiler"}}')]), undefined);
});

test('system: the envelope of EMS-ESP checked, settings strict, the bus read', () => {
  const answer = {
    system: { version: '3.9.0' },
    settings: { fahrenheit: false, readonlyMode: false },
    bus: { busStatus: 'connected, tx issues - try a different Tx Mode' },
    devices: [boiler],
  };
  assert.deepEqual(systemOf(answer), {
    key: identityKey('boiler', 123, '0x08'),
    version: '3.9.0',
    fahrenheit: false,
    readonly: false,
    bus: 'connected',
  });
  assert.equal(systemOf({ ...answer, bus: { busStatus: 'disconnected' } }).bus, 'disconnected');
  assert.equal(systemOf({ ...answer, bus: undefined }).bus, 'unknown');
  assert.equal(systemOf({ ...answer, settings: { fahrenheit: 'true' } }).fahrenheit, false);
  assert.equal(systemOf({ ...answer, settings: { fahrenheit: true } }).fahrenheit, true);
  assert.equal(systemOf({ ...answer, system: { version: '<b>' } }).version, undefined);
  for (const bad of [{}, { value: 'x' }, { system: 'x' }, { system: { version: 3 } }, null]) {
    assert.equal(systemOf(bad), undefined, JSON.stringify(bad));
  }
});

test('temperatures and numbers: finite and plausible only, never a text, null or "" as 0', () => {
  const r = { min: -50, max: 60 };
  assert.equal(temperatureOf(4.46, r, false), 4.5);
  assert.equal(temperatureOf(41, r, true), 5);
  assert.equal(temperatureOf(68.9, r, true), 20.5);
  assert.equal(toCelsius(212), 100);
  for (const bad of [-3276.8, 3276.7, '4.5', null, '', true, undefined, Number.NaN]) {
    assert.equal(temperatureOf(bad, r, false), undefined, String(bad));
  }
  assert.equal(temperatureOf(150, r, true), undefined, '150 °F is 65.6 °C: out of range');
  assert.equal(numberIn(1.64, { min: 0, max: 10 }), 1.6);
  assert.equal(numberIn('1.6', { min: 0, max: 10 }), undefined);
  assert.equal(numberIn(25.5, { min: 0, max: 10 }), undefined);
});

test('booleans in every format and language of EMS-ESP', () => {
  for (const on of [true, 1, 'on', 'ON', 'true', '1', 'an', 'AAN', 'açık', 'zap']) {
    assert.equal(boolOf(on), 'on', String(on));
  }
  for (const off of [false, 0, 'off', 'OFF', 'false', '0', 'aus', 'AUS', 'uit', 'av', 'kapalı']) {
    assert.equal(boolOf(off), 'off', String(off));
  }
  for (const bad of [2, 'yes', '', null, undefined, 'x'.repeat(40), {}]) {
    assert.equal(boolOf(bad), undefined, String(bad));
  }
});

test('values: nested by circuit or flat, own keys only', () => {
  const values = { outdoortemp: 4, hc1: { seltemp: 21 }, 'dhw.seltemp': 55 };
  assert.equal(valueAt(values, '', 'outdoortemp'), 4);
  assert.equal(valueAt(values, 'hc1', 'seltemp'), 21);
  assert.equal(valueAt(values, 'dhw', 'seltemp'), 55);
  assert.equal(valueAt(values, 'hc2', 'seltemp'), undefined);
  assert.equal(valueAt(JSON.parse('{"__proto__":{"x":1}}'), '', 'x'), undefined);
  assert.equal(valueAt({}, '', 'toString'), undefined);
});

test('circuits: hc1..hc8 (4 kept), dhw, dhw2 (2 kept), the heating if listed', () => {
  const t = Object.fromEntries(
    ['hc1', 'hc3', 'hc4', 'hc5', 'hc6', 'hc9'].map((h) => [h, { seltemp: 20 }]),
  );
  assert.deepEqual(circuitsOf(t, 'hc'), ['hc1', 'hc3', 'hc4', 'hc5']);
  assert.deepEqual(circuitsOf({ dhw: {}, dhw2: {}, dhw3: {} }, 'dhw'), ['dhw1', 'dhw2']);
  assert.deepEqual(circuitsOf({ 'dhw.seltemp': 50 }, 'dhw'), ['dhw1']);
  assert.deepEqual(circuitsOf({ heatingactivated: 'on' }, 'heating'), ['heating']);
  assert.deepEqual(circuitsOf({ dhw: 'x' }, 'dhw'), []);
  assert.deepEqual(circuitsOf(undefined, 'hc'), []);
});

test('modes: an enum by its index, any language, "off" found, bounded; a boolean on/off', () => {
  const m = modeOf({ type: 'enum', enum: ['off', 'manual', 'auto'], index: 2, writeable: true });
  assert.equal(m.value, 'auto');
  assert.deepEqual(m.allowed, ['off', 'manual', 'auto']);
  assert.equal(m.index.get('manual'), 'manual');
  assert.equal(m.writable, true);
  const de = modeOf({ type: 'enum', enum: ['Aus', 'manuell', 'auto'], value: 'Aus' });
  assert.equal(de.value, 'off');
  assert.equal(de.index.get('off'), 'off');
  assert.equal(de.writable, false, 'writeable missing: not writable');
  assert.equal(modeOf({ type: 'enum', enum: ['a', 'b'], value: 1 }).value, 'b');
  assert.equal(modeOf({ type: 'enum', enum: ['a', 'b'], index: 7 }), undefined);
  assert.equal(modeOf({ type: 'enum', enum: 'a' }), undefined);
  const many = modeOf({
    type: 'enum',
    enum: Array.from({ length: 20 }, (_, i) => `m${i}`),
    index: 0,
  });
  assert.equal(many.allowed.length, 12);
  const b = modeOf({ type: 'boolean', bool: false, value: 'aus', writeable: true });
  assert.equal(b.value, 'off');
  assert.deepEqual(b.allowed, ['on', 'off']);
  assert.equal(modeOf({ type: 'boolean', value: 'on' }).value, 'on');
  assert.equal(modeOf({ type: 'boolean' }), undefined, 'no value: unknown');
  assert.equal(modeOf({ type: 'number', value: 1 }), undefined);
  assert.equal(modeValueOf('a\u0007b'), undefined);
  assert.equal(modeValueOf('x'.repeat(33)), undefined);
});

test('setpoints: value and bounds required, °C only for a write, writeable strict', () => {
  const s = (extra) => ({
    type: 'number',
    value: 21,
    min: 0,
    max: 30,
    uom: '°C',
    writeable: true,
    ...extra,
  });
  assert.deepEqual(setpointOf(s()), { value: 21, min: 0, max: 30, writable: true, celsius: true });
  assert.equal(setpointOf(s({ writeable: 'true' })).writable, false);
  assert.equal(setpointOf(s({ uom: '°F' })).celsius, false);
  assert.equal(setpointOf(s(), true).celsius, false, 'EMS-ESP set to Fahrenheit');
  for (const bad of [
    s({ min: undefined }),
    s({ max: '30' }),
    s({ min: 40 }),
    s({ value: null }),
    s({ value: undefined }),
    s({ value: 3276.7 }),
    s({ type: 'enum' }),
  ]) {
    assert.equal(setpointOf(bad), undefined, JSON.stringify(bad));
  }
});
