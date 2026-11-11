// -----------------------------------------------------------------------------
// The installation behind EMS-ESP -> one Gladys device and its states (pure).
//
// `ext:<selector>:ems-esp:<key>`: the key is a hash of the type, product id
// and bus address of the heat source (src/model.js identityKey), stable
// across addresses and renames. The feature roles (the last part of their
// external ids) are published forever: never rename them. Gateway roles:
// outdoor-temperature, supply-temperature, system-pressure, status; circuit
// roles: `heating-mode` (the heating of the boiler, on/off),
// `<hcN>-temperature`, `<hcN>-setpoint`, `<hcN>-mode` (the heating circuits
// of the thermostat), `<dhwN>-temperature`, `<dhwN>-setpoint`, `<dhwN>-mode`
// (the hot water of the boiler, on/off).
//
// A feature appears once its value was read; a device published again never
// loses a feature: those of the device already created in Gladys are kept as
// they are, the options of a created mode select included (the core would
// mark it `structure_changed`).
//
// No switch, no writable binary: a "turn everything off" must never reach
// the boiler. The commands are the mode of a circuit (`text/select`: on/off
// for the heating and the hot water, the operating modes of a thermostat
// circuit; "off" is protective), the room setpoint
// (`thermostat/target-temperature`, half degrees) and the hot water setpoint
// (`water-heater/target-temperature`, whole degrees), refused unless the
// configuration allows them, except "off" (src/app.js).
//
// Units are those the core lists (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on
// `temperature-sensor`, `thermostat` and `water-heater`, bar on
// `pressure-sensor`. Water temperatures are `probe` (kept out of the room
// temperature by the core).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  CIRCUIT_ROLES as R,
  DHW,
  FEATURES as F,
  LIMITS,
  MODE_VALUE,
  ROOM,
  SELECTOR_TYPE,
  kindOf,
} from './constants.js';
import {
  FEATURE_NAMES,
  STATUS_TEXTS,
  circuitFeatureName,
  deviceName,
  modeName,
  word,
} from './i18n.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const temperature = (type, min, max) =>
  sensor({ category: C.TEMPERATURE_SENSOR, type, unit: U.CELSIUS, min, max });
const target = (bounds, category, type) => ({
  category,
  type,
  unit: U.CELSIUS,
  // The slider stops at the hard bounds; those of the gateway and the
  // configured ceiling refuse within them.
  min: bounds.min,
  max: bounds.max,
  read_only: false,
  has_feedback: true,
  keep_history: true,
});

const GATEWAY_ROLES = [F.OUTDOOR, F.SUPPLY, F.PRESSURE, F.STATUS];
const SUFFIXES = [R.TEMPERATURE, R.SETPOINT, R.MODE];
const KIND_ORDER = ['heating', 'hc', 'dhw'];

/** A role -> { circuit, kind, suffix } for a circuit role, { gateway: role } else, or undefined. */
export function roleOf(role) {
  if (GATEWAY_ROLES.includes(role)) {
    return { gateway: role };
  }
  const match = /^(heating|hc\d|dhw\d)-([a-z]+)$/.exec(String(role));
  const kind = match ? kindOf(match[1]) : undefined;
  if (!kind || !SUFFIXES.includes(match[2]) || (kind === 'heating' && match[2] !== R.MODE)) {
    return undefined;
  }
  return { circuit: match[1], kind, suffix: match[2] };
}

/** The feature definition of a role. */
export function definitionOf(role) {
  const r = roleOf(role);
  if (!r) {
    throw new Error(`unknown role ${role}`);
  }
  switch (r.gateway) {
    case F.OUTDOOR:
      return temperature(T.SENSOR.DECIMAL, -60, 70);
    case F.SUPPLY:
      return temperature(T.TEMPERATURE_SENSOR.PROBE, -20, 130);
    case F.PRESSURE:
      return sensor({
        category: C.PRESSURE_SENSOR,
        type: T.SENSOR.DECIMAL,
        unit: U.BAR,
        min: 0,
        max: 10,
      });
    case F.STATUS:
      return text;
    default:
  }
  if (r.suffix === R.TEMPERATURE) {
    return r.kind === 'hc'
      ? temperature(T.SENSOR.DECIMAL, -20, 60)
      : temperature(T.TEMPERATURE_SENSOR.PROBE, -20, 130);
  }
  if (r.suffix === R.SETPOINT) {
    return r.kind === 'hc'
      ? target(ROOM, C.THERMOSTAT, T.THERMOSTAT.TARGET_TEMPERATURE)
      : // The core's hot water setpoint, never a room thermostat: "set every
        // thermostat to 21" must not reach the hot water.
        target(DHW, C.WATER_HEATER, T.WATER_HEATER.TARGET_TEMPERATURE);
  }
  return {
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    read_only: false,
    has_feedback: true,
    keep_history: false,
  };
}

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

export const deviceIds = (gladys, key) => gladys.externalIds(SELECTOR_TYPE, key);

const KEY = new RegExp(`:${SELECTOR_TYPE}:([0-9a-f]{16})`);

/** The key and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = new RegExp(`${KEY.source}:([a-z0-9-]{1,40})$`).exec(externalId);
  const r = match ? roleOf(match[2]) : undefined;
  if (!r) {
    return undefined;
  }
  return { key: match[1], role: match[2], ...r };
}

/** The key of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = new RegExp(`${KEY.source}$`).exec(String(externalId ?? ''));
  return match ? match[1] : undefined;
}

/** The roles the values of one read report (a mode only with the modes it lists). */
export function reportedRoles(values) {
  const roles = new Set([F.STATUS]);
  if (!values) {
    return roles;
  }
  for (const [role, value] of [
    [F.OUTDOOR, values.outdoor],
    [F.SUPPLY, values.supply],
    [F.PRESSURE, values.pressure],
  ]) {
    if (value !== undefined) {
      roles.add(role);
    }
  }
  for (const [circuit, c] of values.circuits) {
    if (c.temperature !== undefined) {
      roles.add(`${circuit}-${R.TEMPERATURE}`);
    }
    if (c.setpoint !== undefined) {
      roles.add(`${circuit}-${R.SETPOINT}`);
    }
    if (c.mode && c.mode.allowed.length > 0) {
      roles.add(`${circuit}-${R.MODE}`);
    }
  }
  return roles;
}

/**
 * The options of a mode select: the values the gateway lists, plain labels
 * (the core's rules: a non-empty string without spaces around, unique
 * labels and values, no other key than value, label, sort_order).
 */
export function modeOptions(allowed, language) {
  const values = [];
  for (const value of allowed) {
    if (typeof value === 'string' && MODE_VALUE.test(value) && !values.includes(value)) {
      values.push(value);
    }
  }
  const labels = new Set();
  return values.slice(0, LIMITS.modes).map((value, i) => {
    let label = word(modeName(value), language).trim() || value;
    if (labels.has(label)) {
      label = `${label} (${value})`;
    }
    labels.add(label);
    return { value, label, sort_order: i };
  });
}

/** The roles in display order: gateway values, then each circuit, then the status. */
function ordered(roles) {
  const list = [...roles];
  const rank = (role) => {
    const r = roleOf(role);
    if (r.gateway) {
      return r.gateway === F.STATUS ? [9, '', 0] : [0, '', GATEWAY_ROLES.indexOf(role)];
    }
    return [1 + KIND_ORDER.indexOf(r.kind), r.circuit, SUFFIXES.indexOf(r.suffix)];
  };
  return list.sort((a, b) => {
    const [x1, x2, x3] = rank(a);
    const [y1, y2, y3] = rank(b);
    return x1 - y1 || x2.localeCompare(y2) || x3 - y3;
  });
}

/**
 * The Gladys device of an installation. `roles`: those seen; `values`: the
 * last read (for the modes listed) or undefined; `firmware` (the version of
 * EMS-ESP); `created`: the device already created in Gladys, whose
 * features are kept when the new build lacks them, and whose mode options
 * win over those read.
 */
export function buildDevice(gladys, key, { roles, values, firmware, language, created }) {
  const ids = deviceIds(gladys, key);
  const params = [];
  if (firmware) {
    params.push({ name: 'firmware', value: firmware });
  }
  const createdFeatures = new Map(
    (created?.features ?? [])
      .filter((f) => typeof f?.external_id === 'string')
      .map((f) => [f.external_id, f]),
  );
  const features = [];
  for (const role of ordered([...roles].filter((r) => roleOf(r)))) {
    const r = roleOf(role);
    const externalId = ids.feature(role);
    const name = r.gateway
      ? word(FEATURE_NAMES[role], language)
      : word(circuitFeatureName(r.circuit, r.kind, r.suffix), language);
    const feature = { name, external_id: externalId, ...definitionOf(role) };
    if (r.suffix === R.MODE) {
      const kept = createdFeatures.get(externalId)?.supported_options;
      if (Array.isArray(kept) && kept.length > 0) {
        feature.supported_options = kept;
      } else {
        const allowed = values?.circuits.get(r.circuit)?.mode?.allowed ?? [];
        if (allowed.length === 0) {
          continue;
        }
        feature.supported_options = modeOptions(allowed, language);
      }
    }
    features.push(feature);
  }
  const built = {
    name: created?.name ?? word(deviceName(), language),
    external_id: ids.device,
    model: 'EMS-ESP',
    should_poll: false,
    features,
    params,
  };
  return keepCreatedFeatures(built, created);
}

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  const params = built.params.length > 0 ? built.params : (created.params ?? []);
  return { ...built, features: [...built.features, ...kept], params };
}

/**
 * The current states of a device. `status`: 'online' with `values`;
 * otherwise ('offline', 'foreign', 'unknown') only the status text changes,
 * Gladys keeps the last value of the others. `note`: a text about the stops
 * from Gladys, replacing "OK".
 */
export function deviceStates(ids, { values, status = 'online', note, language }) {
  const statusText =
    status === 'online' && note ? note : (STATUS_TEXTS[status] ?? STATUS_TEXTS.unknown);
  const states = [{ role: F.STATUS, text: word(statusText, language) }];
  if (status === 'online' && values) {
    for (const [role, value] of [
      [F.OUTDOOR, values.outdoor],
      [F.SUPPLY, values.supply],
      [F.PRESSURE, values.pressure],
    ]) {
      if (value !== undefined) {
        states.push({ role, state: value });
      }
    }
    for (const [circuit, c] of values.circuits) {
      if (c.temperature !== undefined) {
        states.push({ role: `${circuit}-${R.TEMPERATURE}`, state: c.temperature });
      }
      if (c.setpoint !== undefined) {
        states.push({ role: `${circuit}-${R.SETPOINT}`, state: c.setpoint });
      }
      if (c.mode) {
        states.push({ role: `${circuit}-${R.MODE}`, text: c.mode.value });
      }
    }
  }
  return states.map(({ role, ...value }) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
