import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionKey,
  dhwCeilingOf,
  normalizeConfig,
  numberOf,
  parseAddress,
  tokenOf,
} from '../src/config.js';

const OK = { address: '192.168.1.50', token: 'emsesp_Ab12Cd34Ef56' };

test('addresses: host or host:port, http only, no special address', () => {
  assert.deepEqual(parseAddress('192.168.1.50'), { host: '192.168.1.50', port: 80 });
  assert.deepEqual(parseAddress(' http://192.168.1.50:8080/ '), {
    host: '192.168.1.50',
    port: 8080,
  });
  assert.deepEqual(parseAddress('EMS-ESP.local'), { host: 'ems-esp.local', port: 80 });
  for (const [raw, problem] of [
    ['', 'noAddress'],
    [undefined, 'noAddress'],
    ['https://192.168.1.50', 'https'],
    ['192.168.1.50:0', 'badAddress'],
    ['192.168.1.50:70000', 'badAddress'],
    ['192.168.001.50', 'badAddress'],
    ['192.168.1', 'badAddress'],
    ['[::1]', 'badAddress'],
    ['a b', 'badAddress'],
    ['host/path', 'badAddress'],
    ['u:p@host', 'badAddress'],
    ['0.0.0.0', 'specialAddress'],
    ['255.255.255.255', 'specialAddress'],
    ['192.168.1.255', 'specialAddress'],
    ['192.168.1.0', 'specialAddress'],
    ['224.0.0.1', 'specialAddress'],
    ['host\r\nx', 'badAddress'],
  ]) {
    assert.equal(parseAddress(raw).problem, problem, String(raw));
  }
});

test('the API key: printable ASCII without space, 8 to 1024 characters, trimmed', () => {
  assert.equal(tokenOf(' emsesp_Ab12Cd34 '), 'emsesp_Ab12Cd34');
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VybmFtZSI6ImFkbWluIn0.2bHpWya2C7Q12WjNUBD6_7N3RCD7CMl-E';
  assert.equal(tokenOf(jwt), jwt);
  for (const bad of [
    '',
    'abc',
    'emsesp key',
    'emsesp_é12345678',
    'a\r\nb12345678',
    'x'.repeat(1025),
    42,
  ]) {
    assert.equal(tokenOf(bad), undefined, String(bad));
  }
});

test('numbers are strict; the hot water ceiling never above 65 °C', () => {
  assert.equal(numberOf(''), undefined);
  assert.equal(numberOf(null), undefined);
  assert.equal(numberOf('12abc'), undefined);
  assert.equal(numberOf(Number.NaN), undefined);
  assert.equal(numberOf(' 55 '), 55);
  assert.equal(dhwCeilingOf(90), 65);
  assert.equal(dhwCeilingOf('70'), 65);
  assert.equal(dhwCeilingOf(10), 40);
  assert.equal(dhwCeilingOf(55.9), 55);
  assert.equal(dhwCeilingOf(''), 65);
});

test('the configuration: defaults, options off unless strictly true, credentials checked', () => {
  const c = normalizeConfig({ ...OK, allow_commands: 'yes' });
  assert.equal(c.problem, undefined);
  assert.equal(c.token, 'emsesp_Ab12Cd34Ef56');
  assert.equal(c.allowCommands, false);
  assert.equal(c.pollInterval, 60);
  assert.equal(c.dhwCeiling, 65);
  assert.equal(c.language, 'fr');
  assert.equal(normalizeConfig({ ...OK, allow_commands: true }).allowCommands, true);
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ poll_interval: 99999 }).pollInterval, 900);
  assert.equal(normalizeConfig({ ...OK, token: '' }).problem, undefined, 'a key is optional');
  assert.equal(normalizeConfig({ ...OK, token: '' }).token, '');
  assert.equal(normalizeConfig({ ...OK, token: 'x' }).problem, 'badToken');
  assert.equal(normalizeConfig({ ...OK, token: 'emsesp_a\nb_cdefgh' }).problem, 'badToken');
  assert.equal(normalizeConfig({ ...OK, gladys_token: 'x', token: '' }).token, '');
  const bad = normalizeConfig({ ...OK, address: 'x y' });
  assert.equal(bad.token, '', 'never kept when unusable');
  assert.notEqual(
    connectionKey(normalizeConfig(OK)),
    connectionKey(normalizeConfig({ ...OK, token: 'emsesp_Zz12Cd34Ef56' })),
  );
  assert.notEqual(
    connectionKey(normalizeConfig(OK)),
    connectionKey(normalizeConfig({ ...OK, address: '192.168.1.51' })),
  );
});
