// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in ems-esp-state.json, readable by the container user only
// (0600):
//   - `pausedUntil`: the end of a pause after an HTTP 429 or 5xx;
//   - `refused`: EMS-ESP refuses the reads (401/403 on /api/system: no API
//     key, or a wrong one): a stop of the reads, no automatic retry. Saving
//     another key or a successful "Test the connection" lifts it;
//   - `fp`: while refused only, 8 bits of a salted scrypt fingerprint of the
//     refused address and key: enough for a restart to tell (almost always)
//     whether another key was typed meanwhile, far too little to test a key
//     with. Erased by the first success;
//   - `lastReadAt`: when the last read began (written before it leaves, at
//     most once a minute, or once an interval when shorter), so that a
//     restart loop never reads faster than the interval;
//   - `stops`: the stops ("off") sent from Gladys, one per circuit (heating,
//     hc1.., dhw1..), until another mode chosen from Gladys (with the option)
//     or another mode read twice in a row after the stop was seen applied
//     (see src/app.js): { key (the installation), circuit, phase ('unsent',
//     'sent', 'confirmed' = off read), tries (4xx answers to the stop while
//     the reads go through), resends, starts }.
// Never a secret in clear. Read back bounded (a clock moved or a file edited
// by hand never gives a pause longer than its maximum; a date in the future
// is invalid), only known keys of the expected shape (never an inherited or
// `__proto__` key). Not a regular file (a FIFO, a device): unreadable, never
// waited on (opened non-blocking).
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';
import { constants as fs } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { TIMINGS, kindOf } from './constants.js';

export const STATE_FILE = '/data/ems-esp-state.json';
const MAX_BYTES = 8192;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/**
 * The file store. `load()` resolves the parsed file, null when there is no
 * file, and rejects when the file exists but cannot be read or parsed (an
 * unreadable /data is never taken for an empty one), or is no regular file.
 */
export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      let handle;
      try {
        handle = await open(path, fs.O_RDONLY | fs.O_NONBLOCK);
      } catch (err) {
        if (err?.code === 'ENOENT') {
          return null;
        }
        throw new Error('unreadable', { cause: err });
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) {
          throw new Error('unreadable');
        }
        const text = await handle.readFile('utf8');
        if (text.length > MAX_BYTES) {
          throw new Error('unreadable');
        }
        return JSON.parse(text);
      } finally {
        await handle.close();
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        const handle = await open(
          temporary,
          fs.O_WRONLY | fs.O_CREAT | fs.O_TRUNC | fs.O_NONBLOCK,
          0o600,
        );
        try {
          if (!(await handle.stat()).isFile()) {
            throw new Error('not a file');
          }
          await handle.writeFile(text);
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/**
 * For the tests: the same JSON round trip as the file; `failing` refuses
 * every save, `unreadable` every load, `frozen` never answers (a stuck
 * volume) until `thaw()`.
 */
export function memoryStore(initial = null, { failing = false, unreadable = false } = {}) {
  const store = {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failing,
    unreadable,
    frozen: false,
    held: [],
    thaw() {
      store.frozen = false;
      for (const fn of store.held.splice(0)) {
        fn();
      }
    },
    gate() {
      return store.frozen ? new Promise((resolve) => store.held.push(resolve)) : undefined;
    },
    async load() {
      await store.gate();
      if (store.unreadable) {
        throw new Error('unreadable');
      }
      return store.data === null ? null : JSON.parse(JSON.stringify(store.data));
    },
    async save(data) {
      const copy = JSON.parse(JSON.stringify(data));
      await store.gate();
      if (store.failing) {
        throw new Error('EROFS');
      }
      store.data = copy;
      store.saves += 1;
    },
  };
  return store;
}

const KEY = /^[0-9a-f]{16}$/;
const PHASES = new Set(['unsent', 'sent', 'confirmed']);
const MAX_STOPS = 8;

/** A count that cannot be read counts as `fallback`. */
const count = (value, max, fallback) =>
  Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : fallback;

/** A past time, else 0: a time ahead of the clock is invalid. */
const readTime = (value, now) => (Number.isFinite(value) && value > 0 && value <= now ? value : 0);

function readStop(raw) {
  const key = own(raw, 'key');
  const circuit = own(raw, 'circuit');
  const phase = own(raw, 'phase');
  if (typeof key !== 'string' || !KEY.test(key) || !kindOf(circuit) || !PHASES.has(phase)) {
    return null;
  }
  return {
    key,
    circuit,
    phase,
    // An unreadable count of refusals is none: a stop never left is never
    // given up on a guess.
    tries: count(own(raw, 'tries'), TIMINGS.stopResends, 0),
    // An unreadable count of resends is spent: never more sends than allowed.
    resends: count(own(raw, 'resends'), TIMINGS.stopResends, TIMINGS.stopResends),
    // An unreadable count of starts is none (one read never lifts the guard).
    starts: own(raw, 'starts') === 1 ? 1 : 0,
  };
}

function readStops(raw) {
  const stops = {};
  if (!Array.isArray(raw)) {
    return stops;
  }
  for (const item of raw.slice(0, MAX_STOPS)) {
    const stop = readStop(item);
    if (stop && !stops[stop.circuit]) {
      stops[stop.circuit] = stop;
    }
  }
  return stops;
}

/** The persisted state, repaired and bounded against `now` (wall clock). */
export function normalizeMemory(raw, now) {
  const pausedUntil = own(raw, 'pausedUntil');
  const salt = own(raw, 'salt');
  const refused = own(raw, 'refused') === true;
  const fp = own(raw, 'fp');
  return {
    pausedUntil:
      Number.isFinite(pausedUntil) && pausedUntil > now
        ? Math.min(pausedUntil, now + TIMINGS.pauseMax)
        : 0,
    salt:
      typeof salt === 'string' && /^[0-9a-f]{32}$/.test(salt)
        ? salt
        : randomBytes(16).toString('hex'),
    refused,
    // A refusal without a readable fingerprint is kept (never lifted by guess).
    fp: refused && typeof fp === 'string' && /^[0-9a-f]{2}$/.test(fp) ? fp : '',
    lastReadAt: readTime(own(raw, 'lastReadAt'), now),
    stops: readStops(own(raw, 'stops')),
  };
}

export const serializeMemory = ({ pausedUntil, salt, refused, fp, lastReadAt, stops }) => ({
  pausedUntil,
  salt,
  refused,
  fp: refused ? fp : '',
  lastReadAt,
  stops: Object.values(stops).map((s) => ({
    key: s.key,
    circuit: s.circuit,
    phase: s.phase,
    tries: s.tries,
    resends: s.resends,
    starts: s.starts,
  })),
});

/**
 * 8 bits of the salted fingerprint of a refused key: one chance in 256
 * that another key looks the same (then the button lifts it), and no way
 * to test a key against it.
 */
export const refusalPrint = (salt, config) =>
  scryptSync(`${config.host}:${config.port}\n${config.token}`, `${salt}:ems-esp`, 16)
    .toString('hex')
    .slice(0, 2);
