// -----------------------------------------------------------------------------
// Constants: the local REST API of an EMS-ESP gateway (the ESP32 firmware that
// reads the EMS bus of Bosch, Buderus, Junkers, Nefit, Worcester boilers and
// heat pumps), feature roles, manifest keys, limits and timings.
//
// The API is documented at docs.emsesp.org (Commands, "REST API"); this
// integration only calls it (EMS-ESP itself is GPL-3.0: none of its code is
// copied here). Plain http on the local network:
//   GET  /api/system                  identity, version, settings, bus status
//   GET  /api/boiler, /api/thermostat the short values of a device (JSON
//                                     object; circuits nested: hc1..hc8, dhw,
//                                     dhw2..dhw10)
//   GET  /api/<device>/<tag>/<entity> one entity: { name, value, type, min,
//                                     max, enum, index, bool, uom, writeable }
//   POST /api/<device>/<tag>/<entity> { "value": ... } with
//                                     `Authorization: Bearer <API key>`
// Answers: 200 (a write: an empty object), 400 bad value, 401 not allowed
// (no key, or a key without the write right), 404 unknown device or entity,
// 429 another GET under way (the gateway serves one at a time). From 3.10 the
// reads need a key too.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const SELECTOR_TYPE = 'ems-esp';

/** The version of the package (the release workflow bumps it there). */
export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/** Our own User-Agent (never one of an app or a browser). */
export const USER_AGENT = `gladys-ems-esp/${VERSION} (+https://github.com/LM1LC3N7/gladys-ems-esp)`;

export const PATHS = {
  system: '/api/system',
  boiler: '/api/boiler',
  thermostat: '/api/thermostat',
};

/**
 * The circuits: `heating` (the heating of the boiler, on or off), hc1..hc8
 * (the heating circuits of the thermostat), dhw1..dhw4 (the hot water of the
 * boiler, called dhw, dhw2.. by EMS-ESP). `max`: how many are kept.
 */
export const KINDS = {
  heating: { device: 'boiler', name: /^heating$/, max: 1 },
  hc: { device: 'thermostat', name: /^hc[1-8]$/, max: 4 },
  dhw: { device: 'boiler', name: /^dhw[1-4]$/, max: 2 },
};

/** A circuit name, its kind, else undefined. */
export function kindOf(circuit) {
  if (typeof circuit !== 'string') {
    return undefined;
  }
  for (const [kind, { name }] of Object.entries(KINDS)) {
    if (name.test(circuit)) {
      return kind;
    }
  }
  return undefined;
}

/** The tag EMS-ESP gives a circuit (none for the boiler itself; the first hot water is "dhw"). */
export function tagOf(circuit) {
  if (circuit === 'heating') {
    return '';
  }
  if (circuit === 'dhw1') {
    return 'dhw';
  }
  return circuit;
}

/**
 * The entities of a circuit (EMS-ESP short names). `mode`: an enum (the
 * operating mode of a thermostat circuit) or a boolean (on/off of the
 * heating or of the hot water), the select of the circuit. `temperatures`:
 * the first one given wins.
 */
export const CIRCUIT_FIELDS = {
  heating: { mode: 'heatingactivated', boolean: true },
  hc: { temperatures: ['currtemp'], setpoint: 'seltemp', mode: 'mode', boolean: false },
  dhw: {
    temperatures: ['curtemp', 'storagetemp1'],
    setpoint: 'seltemp',
    mode: 'activated',
    boolean: true,
  },
};

/** The path of one entity of a circuit. */
export function entityPath(circuit, field) {
  const kind = kindOf(circuit);
  const tag = tagOf(circuit);
  return `/api/${KINDS[kind].device}/${tag ? `${tag}/` : ''}${field}`;
}

/**
 * "Off" as EMS-ESP writes it in each language it speaks (its on/off words):
 * an operating mode reading one of them is the "off" mode of the circuit,
 * kept as `off`. Writing "off" is understood whatever the language.
 */
export const OFF_WORDS = new Set([
  'off',
  'aus',
  'uit',
  'av',
  'wyłączono',
  'wył.',
  'kapalı',
  // "KAPALI" lower cased without a locale.
  'kapali',
  'vyp',
  'ki',
]);
export const ON_WORDS = new Set([
  'on',
  'an',
  'aan',
  'på',
  'włączono',
  'wł.',
  'açık',
  // "AÇIK" lower cased without a locale.
  'açik',
  'zap',
  'be',
]);

/** The value of the "off" mode of every select: the protective stop of that circuit. */
export const OFF = 'off';
export const ON = 'on';

/** A mode value as EMS-ESP lists them: printable, no control character, 32 characters at most. */
// eslint-disable-next-line no-control-regex
export const MODE_VALUE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]{1,32}$/u;

/** Feature roles of the gateway (the last part of their external ids): frozen. */
export const FEATURES = {
  OUTDOOR: 'outdoor-temperature',
  SUPPLY: 'supply-temperature',
  PRESSURE: 'system-pressure',
  STATUS: 'status',
};

/** The roles of a circuit: `<circuit>-<suffix>` (hc1-setpoint, dhw1-mode, heating-mode): frozen. */
export const CIRCUIT_ROLES = {
  TEMPERATURE: 'temperature',
  SETPOINT: 'setpoint',
  MODE: 'mode',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 30,
  max: 900,
  default: 60,
};

/**
 * Room setpoints, in °C, half degrees: never outside the bounds EMS-ESP
 * gives for the entity (read before each write), nor outside 5 to 30 °C.
 */
export const ROOM = {
  min: 5,
  max: 30,
  step: 0.5,
};

/**
 * Hot water setpoints, in °C, whole degrees: from 20 °C to the configured
 * ceiling (65 °C by default, 40 to 65 °C, never above 65 °C whatever is
 * typed: scalding), and within the bounds EMS-ESP gives (the lower wins).
 */
export const DHW = {
  min: 20,
  max: 65,
  ceilingMin: 40,
  ceilingDefault: 65,
};

export const LIMITS = {
  /** Gladys: 300 states per minute; a margin is kept. */
  statesPerMinute: 250,
  statesPerRequest: 100,
  /** An answer is read up to this size, then dropped (the values of a heat pump: ~20 KB). */
  responseBytes: 128 * 1024,
  /** Entries of a JSON object looked at, items of a list. */
  keys: 600,
  /** Modes of a circuit kept. */
  modes: 12,
  /** Names (model, version, mode labels) are cut to this length. */
  nameLength: 60,
  /** Non-protective commands waiting for their turn (at least the commandable features): more are refused. */
  queue: 16,
  /** The API key: printable ASCII, no space. */
  tokenMin: 8,
  tokenMax: 1024,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request of the polling. */
  requestTimeout: 8 * SECOND,
  /** Failed polls: 1, 2, 5, then 10 minutes, never shorter than the interval. */
  backoff: [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE],
  /** An HTTP 429 or 5xx: a pause of 1 min to 6 h, persisted in /data. */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button reads at most this often. */
  testCooldown: 10 * SECOND,
  /** The button waits 30 s in Gladys: it answers by 25 s. */
  testBudget: 25 * SECOND,
  /** getConfig() failed: tried again after 5, 10, 30 s, then every minute, without end. */
  configRetry: [5 * SECOND, 10 * SECOND, 30 * SECOND, MINUTE],
  /** /data: a read or a write never waited for longer (a stuck volume). */
  dataTimeout: 1_500,
  /** /data unreadable or stuck: read again this often, until it answers. */
  dataRetry: 10 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack, its timer armed when it sends):
   * the request must leave by 3.5 s after the click, or the command is
   * refused unsent; its answer and the read that confirms it are awaited
   * until 4.3 s ("sent, without confirmation" after that).
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** At least 0.3 s left to send after the fresh read. */
  commandMinSend: 300,
  /** Commands arriving within this window share one batch (one fresh read). */
  batchWindow: 50,
  /** A stop that could not connect is tried again within this budget. */
  stopRetryBudget: 250,
  stopRetryStep: 50,
  /** A stop refused by the gateway (4xx) or contradicted by a read is sent again 3 times at most. */
  stopResends: 3,
  /** A stop is judged contradicted only by a read begun this long after it left. */
  applyWindow: 3 * SECOND,
  /** A write read back every 600 ms until it shows (EMS-ESP applies it in 0.5-2 s). */
  confirmStep: 600,
  /** A read back is not tried with less time than this left. */
  confirmMin: 100,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
};
