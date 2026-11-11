// -----------------------------------------------------------------------------
// A fake EMS-ESP behind the transport of src/emsesp/http.js: the paths and the
// shapes of the answers of its REST API as docs.emsesp.org documents them
// and its own API tests show them (3.9): /api/system (system, settings, bus,
// devices), the short values of a device (circuits nested: hc1, dhw...), one
// entity (name, value, type, min, max, enum, index, bool, uom, writeable),
// a POST of { value } with an API key (401 without the right one). A boiler
// with its heating on/off and one hot water; a thermostat (RC20-like) with
// hc1 listing an "off" mode and hc2 (RC310-like) without one. Writes are
// applied within the bounds and modes listed; every request recorded; one
// connection at a time counted. Delays on the clock of the test (`timers`).
// -----------------------------------------------------------------------------

import { CODES, EmsError } from '../../src/emsesp/errors.js';

export const TOKEN = 'emsesp_test_ReadWrite_0123456789';
export const READ_TOKEN = 'emsesp_test_ReadOnly_9876543210';
export const CONFIG = { address: '192.168.1.50', token: TOKEN };

const number = (value, extra = {}) => ({ type: 'number', value, writeable: false, ...extra });
const bool = (value, extra = {}) => ({ type: 'boolean', value, writeable: true, ...extra });
const enumOf = (list, index, extra = {}) => ({
  type: 'enum',
  enum: list,
  value: index,
  writeable: true,
  ...extra,
});

/** The entities of the installation, by path. */
export function initialEntities() {
  return {
    '/api/boiler/outdoortemp': number(4.5, { uom: '°C' }),
    '/api/boiler/curflowtemp': number(45.2, { uom: '°C' }),
    '/api/boiler/syspress': number(1.6, { uom: 'bar' }),
    '/api/boiler/heatingactivated': bool(true),
    '/api/boiler/dhw/curtemp': number(52.3, { uom: '°C' }),
    '/api/boiler/dhw/seltemp': number(55, { uom: '°C', writeable: true, min: 0, max: 254 }),
    '/api/boiler/dhw/activated': bool(true),
    '/api/thermostat/hc1/currtemp': number(20.5, { uom: '°C' }),
    '/api/thermostat/hc1/seltemp': number(21, { uom: '°C', writeable: true, min: 0, max: 30 }),
    '/api/thermostat/hc1/mode': enumOf(['off', 'manual', 'auto'], 2),
    '/api/thermostat/hc2/currtemp': number(19.5, { uom: '°C' }),
    '/api/thermostat/hc2/seltemp': number(20, { uom: '°C', writeable: true, min: 0, max: 30 }),
    '/api/thermostat/hc2/mode': enumOf(['manual', 'auto'], 1),
  };
}

export function initialSystem() {
  return {
    system: { version: '3.9.0', uptimeSec: 3600 },
    network: { network: 'WiFi', hostname: 'ems-esp' },
    bus: { busStatus: 'connected', busProtocol: 'Buderus' },
    settings: { locale: 'en', fahrenheit: false, readonlyMode: false, boolFormat: 1 },
    devices: [
      { type: 'boiler', name: 'GB125', deviceID: '0x08', productID: 123, version: '01.00' },
      { type: 'thermostat', name: 'RC20', deviceID: '0x17', productID: 77, version: '02.00' },
      { type: 'temperaturesensor', name: 'temperaturesensor', entities: 0 },
    ],
  };
}

const OFF_TEXT = new Set(['off', 'false', '0']);
const OFF_WORDS = new Set(['off', 'aus', 'uit', 'av']);
const ON_TEXT = new Set(['on', 'true', '1']);

/**
 * The fake gateway. Options and state may be changed at any time: `latency`
 * (ms per answer), `route(path, method)` to override an answer ('silent',
 * 'refuse', 'drop', or { status, body } sent as is), `ignoreWrites` (writes
 * answered 200 but not applied), `applyDelay` (ms before a write shows),
 * `connectDelay` (ms before the connection is up: beforeSend runs then),
 * `onConnect(path, method)`, `readKey` (reads need a key, as from 3.10),
 * `writeKeys` (the keys allowed to write), `boolFormat` ('onoff', 'true',
 * '10'), `enumIndex` (enums given as their index).
 */
/** More requests than this within one second of the clock: a flood (a test fails at once). */
export const FLOOD = 60;

export function fakeEmsEsp({ timers, latency = 0, elapsed } = {}) {
  const dev = {
    entities: initialEntities(),
    system: initialSystem(),
    latency,
    // EMS-ESP shows a write after its round trip on the bus (0.5 to 2 s).
    applyDelay: 1000,
    connectDelay: 0,
    onConnect: undefined,
    ignoreWrites: false,
    route: undefined,
    readKey: false,
    writeKeys: new Set([TOKEN]),
    readKeys: new Set([TOKEN, READ_TOKEN]),
    boolFormat: 'onoff',
    enumIndex: false,
    /** { path, method, value, headers } of every request that reached the gateway. */
    requests: [],
    /** Set when the app floods the gateway (see FLOOD): the helpers fail the test. */
    flooded: false,
    second: { at: -1, count: 0 },
    /** Requests refused unsent (beforeSend, late, refused port). */
    unsent: 0,
    open: 0,
    peak: 0,
    count: (path, method = 'GET') =>
      dev.requests.filter((r) => r.path === path && r.method === method).length,
    posts: () => dev.requests.filter((r) => r.method === 'POST'),
    later(fn) {
      if (dev.applyDelay > 0) {
        timers.setTimeout(fn, dev.applyDelay);
      } else {
        fn();
      }
    },
    json: (status, value) => ({ status, body: JSON.stringify(value) }),
    shortValue(entity) {
      if (entity.value === undefined || entity.value === null) {
        return undefined;
      }
      if (entity.type === 'boolean') {
        if (dev.boolFormat === 'true') {
          return entity.value;
        }
        if (dev.boolFormat === '10') {
          return entity.value ? 1 : 0;
        }
        return entity.value ? 'on' : 'off';
      }
      if (entity.type === 'enum') {
        return dev.enumIndex ? entity.value : entity.enum[entity.value];
      }
      return entity.value;
    },
    /** GET /api/<device>: the short values, circuits nested. */
    values(device) {
      const prefix = `/api/${device}/`;
      const out = {};
      let found = false;
      for (const [path, entity] of Object.entries(dev.entities)) {
        if (!path.startsWith(prefix)) {
          continue;
        }
        found = true;
        const parts = path.slice(prefix.length).split('/');
        const value = dev.shortValue(entity);
        if (value === undefined) {
          continue;
        }
        if (parts.length === 1) {
          out[parts[0]] = value;
        } else {
          out[parts[0]] ??= {};
          out[parts[0]][parts[1]] = value;
        }
      }
      return found ? out : undefined;
    },
    /** GET /api/<device>/<tag>/<entity>: the entity in full. */
    detail(path) {
      const entity = dev.entities[path];
      const name = path.split('/').pop();
      const out = { name, fullname: name };
      if (entity.type === 'enum') {
        if (entity.value !== undefined) {
          out.index = entity.value;
          out.value = dev.enumIndex ? entity.value : entity.enum[entity.value];
        }
        out.type = 'enum';
        out.enum = [...entity.enum];
      } else if (entity.type === 'boolean') {
        if (entity.value !== undefined) {
          out.bool = entity.value;
          out.index = entity.value ? 1 : 0;
          out.value = dev.shortValue(entity);
        }
        out.type = 'boolean';
      } else {
        if (entity.value !== undefined) {
          out.value = entity.value;
        }
        out.type = 'number';
      }
      if (entity.min !== undefined) {
        out.min = entity.min;
        out.max = entity.max;
      }
      if (entity.uom) {
        out.uom = entity.uom;
      }
      out.readable = true;
      out.writeable = entity.writeable;
      out.visible = true;
      return out;
    },
    write(path, raw) {
      const entity = dev.entities[path];
      if (!entity) {
        return dev.json(404, { message: 'no entity' });
      }
      if (!entity.writeable) {
        return dev.json(400, { message: 'read only' });
      }
      const text = String(raw).toLowerCase();
      let value;
      if (entity.type === 'boolean') {
        value = ON_TEXT.has(text) ? true : OFF_TEXT.has(text) ? false : undefined;
      } else if (entity.type === 'enum') {
        // "off" in English is understood whatever the language of EMS-ESP.
        const at = entity.enum.findIndex(
          (e) => e.toLowerCase() === text || (text === 'off' && OFF_WORDS.has(e.toLowerCase())),
        );
        value =
          at >= 0
            ? at
            : /^\d$/.test(text) && Number(text) < entity.enum.length
              ? Number(text)
              : undefined;
      } else if (typeof raw === 'number' && raw >= entity.min && raw <= entity.max) {
        value = raw;
      }
      if (value === undefined) {
        return dev.json(400, { message: 'bad value' });
      }
      if (!dev.ignoreWrites) {
        dev.later(() => {
          entity.value = value;
        });
      }
      return dev.json(200, {});
    },
    answer(path, method, body, headers) {
      const auth = headers?.authorization;
      const key =
        typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
      if (method === 'POST') {
        if (!dev.writeKeys.has(key)) {
          return dev.json(401, { message: 'unauthorized' });
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return dev.json(400, { message: 'bad request' });
        }
        return dev.write(path, parsed?.value);
      }
      if (dev.readKey && !dev.readKeys.has(key)) {
        return dev.json(401, { message: 'unauthorized' });
      }
      if (path === '/api/system') {
        return dev.json(200, dev.system);
      }
      const device = /^\/api\/([a-z]+)$/.exec(path);
      if (device) {
        const values = dev.values(device[1]);
        return values
          ? dev.json(200, values)
          : dev.json(404, { message: `unknown device ${device[1]}` });
      }
      if (dev.entities[path]) {
        return dev.json(200, dev.detail(path));
      }
      return dev.json(404, { message: 'no entity' });
    },
  };

  dev.transport = ({
    path,
    method = 'GET',
    body,
    authorization,
    timeout,
    sendWithin,
    beforeSend,
    signal,
    maxBytes,
  }) =>
    new Promise((resolve, reject) => {
      // A runaway (a mutant without its interval) fails fast instead of
      // filling the memory: requests counted per second of the clock.
      const second = Math.floor((elapsed?.() ?? 0) / 1000);
      if (dev.second.at !== second) {
        dev.second = { at: second, count: 0 };
      }
      dev.second.count += 1;
      if (dev.second.count > FLOOD || dev.requests.length > 20_000) {
        dev.flooded = true;
        reject(new Error('flood'));
        return;
      }
      const route = dev.route?.(path, method);
      let settled = false;
      let written = false;
      const handles = [];
      const finish = (err, value) => {
        if (settled) {
          return;
        }
        settled = true;
        for (const h of handles) {
          timers.clearTimeout(h);
        }
        signal?.removeEventListener('abort', onAbort);
        dev.open -= 1;
        if (err) {
          if (!written) {
            dev.unsent += 1;
          }
          reject(err);
        } else {
          resolve(value);
        }
      };
      const onAbort = () => finish(new EmsError(CODES.ABORTED, { sent: written }));
      dev.open += 1;
      dev.peak = Math.max(dev.peak, dev.open);
      if (signal?.aborted) {
        finish(new EmsError(CODES.ABORTED));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (route === 'refuse') {
        // ECONNREFUSED: nothing sent.
        queueMicrotask(() => finish(new EmsError(CODES.UNREACHABLE)));
        return;
      }
      if (sendWithin !== undefined && sendWithin <= 0) {
        finish(new EmsError(CODES.LATE));
        return;
      }
      handles.push(
        timers.setTimeout(
          () => finish(new EmsError(CODES.TIMEOUT, { sent: written })),
          Math.max(1, timeout),
        ),
      );
      const headers = authorization ? { authorization } : {};
      const reply = () => {
        if (settled || route === 'silent') {
          return;
        }
        if (route === 'drop') {
          finish(new EmsError(CODES.UNREACHABLE, { sent: true }));
          return;
        }
        const answer =
          route && typeof route === 'object' ? route : dev.answer(path, method, body, headers);
        if (Buffer.byteLength(answer.body) > maxBytes) {
          finish(new EmsError(CODES.TOO_LARGE, { sent: true }));
          return;
        }
        finish(null, answer);
      };
      const connected = () => {
        if (settled) {
          return;
        }
        if (beforeSend) {
          try {
            beforeSend();
          } catch (err) {
            err.beforeSend = true;
            err.sent = false;
            finish(err);
            return;
          }
        }
        written = true;
        let value;
        if (method === 'POST') {
          try {
            value = JSON.parse(body)?.value;
          } catch {
            value = undefined;
          }
        }
        dev.requests.push({ path, method, value, headers });
        if (dev.latency > 0) {
          handles.push(timers.setTimeout(reply, dev.latency));
        } else {
          queueMicrotask(reply);
        }
      };
      dev.onConnect?.(path, method);
      if (dev.connectDelay > 0) {
        handles.push(timers.setTimeout(connected, dev.connectDelay));
      } else {
        connected();
      }
    });
  return dev;
}
