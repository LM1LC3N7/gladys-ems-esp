// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The API key is
// kept here and in the client only (its Authorization header): never
// logged, never in /data, never in a status or an error.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DHW, LIMITS, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  address: '',
  allow_commands: false,
  max_dhw: DHW.ceilingDefault,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/** The hot water ceiling: whole degrees within 40..65, else 65. Never above 65 °C. */
export function dhwCeilingOf(value) {
  const number = numberOf(value);
  if (number === undefined) {
    return DHW.ceilingDefault;
  }
  return Math.min(DHW.max, Math.max(DHW.ceilingMin, Math.floor(number)));
}

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * The address typed: `host` or `host:port` (an IPv4 address or a host
 * name), an optional `http://` and trailing `/` tolerated. Never a path, a
 * user, an IPv6 or a special address (0.0.0.0, broadcast, multicast,
 * loopback aside for the tests). Returns { host, port } or a problem.
 */
export function parseAddress(raw) {
  if (typeof raw !== 'string') {
    return { problem: 'noAddress' };
  }
  let text = raw.trim();
  if (text === '') {
    return { problem: 'noAddress' };
  }
  if (/^https:\/\//i.test(text)) {
    return { problem: 'https' };
  }
  text = text.replace(/^http:\/\//i, '').replace(/\/$/, '');
  const match = /^([^:/?#@\s]{1,253})(?::(\d{1,5}))?$/.exec(text);
  if (!match) {
    return { problem: 'badAddress' };
  }
  const host = match[1].toLowerCase();
  const port = match[2] === undefined ? 80 : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { problem: 'badAddress' };
  }
  if (isIP(host) === 4) {
    const parts = host.split('.').map(Number);
    if (parts.some((p, i) => String(p) !== host.split('.')[i])) {
      // Leading zeros ("010"): read as octal by some tools, refused.
      return { problem: 'badAddress' };
    }
    const [a, , , d] = parts;
    if (a === 0 || a >= 224 || d === 0 || d === 255) {
      return { problem: 'specialAddress' };
    }
    return { host, port };
  }
  if (/^\d+(\.\d+)*$/.test(host) || !HOSTNAME.test(host)) {
    return { problem: 'badAddress' };
  }
  return { host, port };
}

/**
 * The API key of EMS-ESP (Settings, Security, API keys; or the access token
 * of the older versions): printable ASCII without space, 8 to 1024
 * characters; empty is allowed (EMS-ESP before 3.10 reads without one).
 */
export function tokenOf(text) {
  if (typeof text !== 'string') {
    return undefined;
  }
  const trimmed = text.trim();
  const pattern = new RegExp(`^[\\x21-\\x7e]{${LIMITS.tokenMin},${LIMITS.tokenMax}}$`);
  return pattern.test(trimmed) ? trimmed : undefined;
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG, token: '' };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value != null) {
      c[key] = value;
    }
  }
  const address = parseAddress(c.address);
  const rawToken = typeof c.token === 'string' ? c.token.trim() : '';
  const token = rawToken === '' ? '' : tokenOf(rawToken);
  let problem = address.problem;
  if (!problem && token === undefined) {
    problem = 'badToken';
  }
  const interval = numberOf(c.poll_interval);
  return {
    /** Why the configuration cannot be used (shown in the status), else undefined. */
    problem,
    host: problem ? '' : address.host,
    port: problem ? 0 : address.port,
    token: problem ? '' : token,
    allowCommands: strictTrue(c.allow_commands),
    dhwCeiling: dhwCeilingOf(c.max_dhw),
    pollInterval:
      interval === undefined
        ? POLL_INTERVAL.default
        : Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval))),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** What a new session depends on (compared in memory only, never stored). */
export const connectionKey = (config) =>
  JSON.stringify([config.problem ?? null, config.host, config.port, config.token]);
