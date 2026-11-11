// -----------------------------------------------------------------------------
// The answers of EMS-ESP, checked and reduced (pure). Untrusted input: own
// keys only (`Object.hasOwn`), strict types, bounded lists; a value EMS-ESP
// does not have is absent or null (unknown, never 0); a value out of its
// plausible range is no measurement; a text is never a number.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { KINDS, LIMITS, MODE_VALUE, OFF, OFF_WORDS, ON, ON_WORDS, tagOf } from './constants.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/** A printable text of at most `max` characters, else undefined. */
export function textOf(value, max = LIMITS.nameLength) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim();
  return clean === '' ? undefined : clean.slice(0, max);
}

/**
 * The stable key of an installation: a hash of the type, product id and bus
 * address of its heat source (the boiler, else the heat pump, else the
 * thermostat), as EMS-ESP lists them. EMS-ESP gives no serial number nor
 * MAC address in its API: two gateways on the same model of boiler look
 * the same (see the docs).
 */
export const identityKey = (type, productId, deviceId) =>
  createHash('sha256')
    .update(`ems-esp:${type}:${productId}:${deviceId.toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);

const IDENTITY_TYPES = ['boiler', 'heatpump', 'thermostat'];
const DEVICE_ID = /^0x[0-9a-fA-F]{2}$/;

/** The key of the installation from the device list of /api/system, else undefined. */
export function keyOfDevices(devices) {
  if (!Array.isArray(devices)) {
    return undefined;
  }
  const list = devices.slice(0, 64);
  for (const type of IDENTITY_TYPES) {
    for (const device of list) {
      const productId = own(device, 'productID');
      const deviceId = own(device, 'deviceID');
      if (
        own(device, 'type') === type &&
        Number.isSafeInteger(productId) &&
        productId > 0 &&
        productId < 65536 &&
        typeof deviceId === 'string' &&
        DEVICE_ID.test(deviceId)
      ) {
        return identityKey(type, productId, deviceId);
      }
    }
  }
  return undefined;
}

/**
 * /api/system -> { key, version, fahrenheit, readonly, bus } or undefined
 * when it is no answer of EMS-ESP (no `system` object with its version).
 * `bus`: 'connected' (tx issues included), 'disconnected' or 'unknown'.
 */
export function systemOf(answer) {
  const system = own(answer, 'system');
  const version = own(system, 'version');
  if (!isObject(system) || typeof version !== 'string') {
    return undefined;
  }
  const settings = own(answer, 'settings');
  const busStatus = own(own(answer, 'bus'), 'busStatus');
  let bus = 'unknown';
  if (typeof busStatus === 'string') {
    if (busStatus.startsWith('connected')) {
      bus = 'connected';
    } else if (busStatus === 'disconnected') {
      bus = 'disconnected';
    }
  }
  return {
    key: keyOfDevices(own(answer, 'devices')),
    version: /^[0-9A-Za-z.+_-]{1,24}$/.test(version) ? version : undefined,
    // Only `true` says Fahrenheit; anything else is taken as Celsius, the
    // default (a setpoint is then written only on a °C entity, see setpointOf).
    fahrenheit: own(settings, 'fahrenheit') === true,
    readonly: own(settings, 'readonlyMode') === true,
    bus,
  };
}

/** A finite number (never a text, a boolean, null or ''). */
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** °F -> °C, exact then rounded to 0.1. */
export const toCelsius = (f) => Math.round((((f - 32) * 5) / 9) * 10) / 10;

/** A temperature (°C or °F given) within [min, max] °C, rounded to 0.1, else undefined. */
export function temperatureOf(value, { min, max }, fahrenheit) {
  const number = finite(value);
  if (number === undefined) {
    return undefined;
  }
  const celsius = fahrenheit ? toCelsius(number) : Math.round(number * 10) / 10;
  return celsius < min || celsius > max ? undefined : celsius;
}

/** A plain number within [min, max], rounded to 0.1, else undefined. */
export function numberIn(value, { min, max }) {
  const number = finite(value);
  return number === undefined || number < min || number > max
    ? undefined
    : Math.round(number * 10) / 10;
}

/**
 * A boolean of EMS-ESP in any of its formats (true/false, 1/0, "on"/"off"
 * in its languages, upper case included) -> 'on', 'off', else undefined.
 */
export function boolOf(value) {
  if (value === true || value === 1) {
    return ON;
  }
  if (value === false || value === 0) {
    return OFF;
  }
  if (typeof value !== 'string' || value.length > 16) {
    return undefined;
  }
  const text = value.trim().toLowerCase();
  if (text === 'true' || text === '1' || ON_WORDS.has(text)) {
    return ON;
  }
  if (text === 'false' || text === '0' || OFF_WORDS.has(text)) {
    return OFF;
  }
  return undefined;
}

/** A mode as listed: the "off" word of any language becomes `off`; else the text, or undefined. */
export function modeValueOf(text) {
  if (typeof text !== 'string') {
    return undefined;
  }
  const trimmed = text.trim();
  if (OFF_WORDS.has(trimmed.toLowerCase())) {
    return OFF;
  }
  return MODE_VALUE.test(trimmed) ? trimmed : undefined;
}

/**
 * One value of the short values of a device: `tag` ('' for the device
 * itself, hc1, dhw...) nested (the default), or "tag.field" flat.
 */
export function valueAt(values, tag, field) {
  if (!tag) {
    return own(values, field);
  }
  const nested = own(own(values, tag), field);
  return nested !== undefined ? nested : own(values, `${tag}.${field}`);
}

/** The circuits of one kind that the short values of their device show, in order, bounded. */
export function circuitsOf(values, kind) {
  if (!isObject(values)) {
    return [];
  }
  if (kind === 'heating') {
    return own(values, 'heatingactivated') !== undefined ? ['heating'] : [];
  }
  const names = [];
  const max = KINDS[kind].max;
  const count = kind === 'hc' ? 8 : 4;
  for (let n = 1; n <= count && names.length < max; n += 1) {
    const circuit = `${kind}${n}`;
    const tag = tagOf(circuit);
    if (isObject(own(values, tag)) || Object.keys(values).some((k) => k.startsWith(`${tag}.`))) {
      names.push(circuit);
    }
  }
  return names;
}

/**
 * One entity (GET /api/<device>/<tag>/<entity>) used as a mode -> { value,
 * allowed, index (value -> the text to write), writable }, or undefined.
 * A boolean: on/off; an enum: the texts it lists (the "off" of any language
 * as `off`), its current one by `index`.
 */
export function modeOf(detail) {
  const type = own(detail, 'type');
  const writable = own(detail, 'writeable') === true;
  if (type === 'boolean') {
    const raw = own(detail, 'bool');
    const value = typeof raw === 'boolean' ? (raw ? ON : OFF) : boolOf(own(detail, 'value'));
    return value === undefined
      ? undefined
      : {
          value,
          allowed: [ON, OFF],
          index: new Map([
            [ON, ON],
            [OFF, OFF],
          ]),
          writable,
        };
  }
  if (type !== 'enum') {
    return undefined;
  }
  const list = own(detail, 'enum');
  if (!Array.isArray(list) || list.length === 0 || list.length > 32) {
    return undefined;
  }
  const texts = list.map(modeValueOf);
  const allowed = [];
  const index = new Map();
  texts.forEach((text, i) => {
    if (text !== undefined && !index.has(text) && allowed.length < LIMITS.modes) {
      allowed.push(text);
      // Written back as EMS-ESP lists it (its language), "off" as "off".
      index.set(text, text === OFF ? OFF : list[i].trim());
    }
  });
  const at = own(detail, 'index');
  let value;
  if (Number.isSafeInteger(at) && at >= 0 && at < texts.length) {
    value = texts[at];
  } else {
    const raw = own(detail, 'value');
    value =
      Number.isSafeInteger(raw) && raw >= 0 && raw < texts.length ? texts[raw] : modeValueOf(raw);
  }
  if (value === undefined || !allowed.includes(value)) {
    return undefined;
  }
  return { value, allowed, index, writable };
}

const CELSIUS_UNITS = new Set(['°C', 'C']);

/**
 * One entity used as a setpoint -> { value, min, max, writable, celsius }
 * (value within its own bounds), or undefined when any is missing or
 * implausible. `celsius`: the entity says °C and EMS-ESP is not set to
 * Fahrenheit (a write is refused otherwise).
 */
export function setpointOf(detail, fahrenheit = false) {
  if (own(detail, 'type') !== 'number') {
    return undefined;
  }
  const uom = own(detail, 'uom');
  const value = finite(own(detail, 'value'));
  const min = finite(own(detail, 'min'));
  const max = finite(own(detail, 'max'));
  if (value === undefined || min === undefined || max === undefined || min > max) {
    return undefined;
  }
  const celsius = !fahrenheit && (uom === undefined || CELSIUS_UNITS.has(uom));
  if (celsius && (value < -50 || value > 150)) {
    return undefined;
  }
  return { value, min, max, writable: own(detail, 'writeable') === true, celsius };
}
