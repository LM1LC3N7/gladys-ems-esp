// -----------------------------------------------------------------------------
// The integration: the EMS-ESP gateway typed in the configuration (address,
// optional API key), one read of it every poll interval, one Gladys device
// for the installation behind it (boiler, thermostat circuits, hot water),
// the transport badge, the "Test the connection" button, and the commands:
// the heating of the boiler on/off, the hot water on/off, the operating mode
// and the room setpoint of each thermostat circuit, the hot water setpoint.
// Everything but "off" is refused unless the option allows it; "off" (the
// stop of a circuit) needs nothing. index.js only wires the SDK handlers.
//
// Two clocks: `monotonic` paces the reads, the pauses, the deadlines and the
// guards; `now` (wall) only dates what /data keeps (a restart).
//
// Failures:
//   - EMS-ESP refuses the reads (401/403 on /api/system: from 3.10 every read
//     needs an API key): a stop of the reads persisted in /data, never an
//     automatic retry; another key, or "Test the connection" (one try, never
//     sooner than the interval), tries again, and only a success lifts it. A
//     401/403 anywhere else is a value missing (a read) or a refusal of that
//     command (a write), never a refusal of the key;
//   - HTTP 429/5xx: a pause of 1 min to 6 h persisted in /data, for every
//     path except the stops;
//   - anything else: the next read after 1, 2, 5, 10 min, never sooner than
//     the interval; a value EMS-ESP does not have (4xx) is left out, never a
//     failure;
//   - the time of the last read is kept in /data: a restart never reads
//     sooner than the interval;
//   - a reconnection to Gladys clears none of them; getConfig() failing is
//     tried again without end (5 s, 10 s, 30 s, then every minute);
//   - /data is never waited on for more than 1.5 s (read or write): a stuck
//     volume counts as unreadable, a slow save never holds a stop.
//
// The stop ("off" of a circuit: the heating of the boiler, a hot water, a
// thermostat circuit that lists an off mode), protective, decided on nothing
// read:
//   - no option, no bounds, no pause, no refusal of the key holds it (one
//     try then), nor a read or a command under way (the Gate cuts the
//     request in flight and the stop leaves first), nor a device not read
//     yet, nor /data. Refused only without a usable configuration, when the
//     circuit lists no "off", or when the last read showed positively
//     another installation at the address (the docs list them);
//   - a stop that could not connect is tried again for 250 ms, then kept in
//     /data and sent again first thing by every next read, without limit,
//     until EMS-ESP answers it (at a restart and on a new session too),
//     never to another installation; only answers count: a 4xx answer counts
//     as a refusal (3 at most), a 429/5xx, a timeout or a cut never count;
//   - it cancels the commands not sent yet (an epoch checked right before
//     each one leaves): nothing begun before the stop leaves after it;
//   - its guard (in /data) is never lifted by time: only by another mode
//     chosen from Gladys (with the option, saved first), or by another mode
//     read twice in a row after the stop was read applied. Until then, a
//     read begun after it showing another mode sends it again (3 answered
//     resends at most);
//   - success only when a read begun after it shows "off".
//
// The other commands: those arriving together (50 ms) form a batch that
// shares one fresh read (identity, then the entity each one writes, with
// its bounds, its modes and whether EMS-ESP takes a write), never the
// values in memory; then each leaves in order and is confirmed by reading
// its entity again; 4 waiting at most; the option and the epoch checked on
// arrival, after the read and right before the request leaves; sent by
// 3.5 s after the click or refused unsent; success only when a read before
// 4.3 s shows the value asked (equal to the value before = not applied yet).
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { connectionKey, normalizeConfig, numberOf } from './config.js';
import {
  CIRCUIT_FIELDS,
  CIRCUIT_ROLES as R,
  DHW,
  FEATURES as F,
  LIMITS,
  MINUTE,
  OFF,
  ON,
  PATHS,
  ROOM,
  SECOND,
  TIMINGS,
  entityPath,
  kindOf,
  tagOf,
} from './constants.js';
import {
  buildDevice,
  deviceIds,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
  reportedRoles,
} from './devices.js';
import { ERRORS, STATUS_TEXTS, T, age, notes, word } from './i18n.js';
import {
  boolOf,
  circuitsOf,
  modeOf,
  numberIn,
  setpointOf,
  systemOf,
  temperatureOf,
  valueAt,
} from './model.js';
import { EmsClient } from './emsesp/client.js';
import {
  CODES,
  EmsError,
  isBusy,
  isDenied,
  isKeyRefused,
  isMissing,
  reasonOf,
} from './emsesp/errors.js';
import { PRIORITY } from './emsesp/gate.js';
import { StatePublisher } from './publisher.js';
import { memoryStore, normalizeMemory, refusalPrint, serializeMemory } from './store.js';

const FOLLOW_MAX = 16;

/** The entity that holds the mode (or on/off) of a circuit. */
export const modePath = (circuit) => entityPath(circuit, CIRCUIT_FIELDS[kindOf(circuit)].mode);

/** The plausible ranges of what a read publishes (°C, bar). */
const RANGES = {
  outdoor: { min: -50, max: 60 },
  supply: { min: -20, max: 130 },
  pressure: { min: 0, max: 10 },
  hc: { min: -20, max: 60 },
  dhw: { min: 0, max: 130 },
  setpoint: { min: 0, max: 100 },
};

export class EmsApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'ems-esp' }),
    store = memoryStore(),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    transport,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    /** The HTTP transport (tests); node:http otherwise. */
    this.transport = transport;
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.config = normalizeConfig();
    this.configRead = false;
    this.configChain = Promise.resolve();
    this.configRetry = { timer: undefined, step: 0, generation: 0 };
    this.memory = normalizeMemory(null, now());
    this.memoryLoaded = false;
    /** /data exists but cannot be read (or is stuck): never written over, modes refused. */
    this.memoryBroken = false;
    this.saveWarned = false;
    /** The end of a 429/5xx pause, on the monotonic clock (0: none). */
    this.pauseUntil = 0;
    /** key -> the roles seen during this run (a feature never disappears). */
    this.seen = new Map();
    this.generation = 0;
    this.started = false;
    this.session = undefined;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** Counts the stops: a command begun before one is not sent. */
    this.stopEpoch = 0;
    /** circuit -> when its last stop left (monotonic): only reads begun after it decide on it. */
    this.stopSentAt = new Map();
    /** circuit -> stops of it under way (a resend never doubles one). */
    this.stopping = new Map();
    /** The non-protective commands waiting (in order), the batch under way, their count. */
    this.pending = [];
    this.working = undefined;
    this.queued = 0;
    /** Increases at every write that may have left: a read begun before it is dropped. */
    this.writes = 0;
  }

  // --- /data -------------------------------------------------------------------

  /** A promise of the store, never waited on for longer than `dataTimeout`. */
  bounded(promise) {
    return new Promise((resolve, reject) => {
      const handle = this.timers.setTimeout(() => reject(new Error('stuck')), TIMINGS.dataTimeout);
      promise.then(
        (value) => {
          this.timers.clearTimeout(handle);
          resolve(value);
        },
        (err) => {
          this.timers.clearTimeout(handle);
          reject(err);
        },
      );
    });
  }

  async loadMemory() {
    if (this.memoryLoaded && !this.memoryBroken) {
      return;
    }
    let raw = null;
    try {
      raw = await this.bounded(Promise.resolve().then(() => this.store.load()));
      this.memoryBroken = false;
    } catch {
      // Unreadable (or stuck) is not empty: nothing is written over it.
      this.memoryBroken = true;
      if (!this.memoryLoaded) {
        this.logger.warn('/data/ems-esp-state.json cannot be read: nothing will be saved');
      }
    }
    if (this.memoryBroken) {
      this.memoryLoaded = true;
      return;
    }
    const now = this.now();
    // Stops clicked while /data was being read are kept over those of the file.
    const live = Object.values(this.memory.stops).filter((s) => s.live);
    this.memory = normalizeMemory(raw, now);
    for (const stop of live) {
      this.memory.stops[stop.circuit] = stop;
    }
    this.memoryLoaded = true;
    const mono = this.monotonic();
    this.pauseUntil =
      this.memory.pausedUntil > now
        ? mono + Math.min(TIMINGS.pauseMax, this.memory.pausedUntil - now)
        : 0;
    if (live.length > 0) {
      void this.saveMemory();
    }
  }

  /** The state as /data keeps it (the pause back on the wall clock). */
  serialized() {
    const mono = this.monotonic();
    const left = this.pauseLeft(mono);
    this.memory.pausedUntil = left > 0 ? this.now() + left : 0;
    return serializeMemory(this.memory);
  }

  /** Saves, never throws, never waits more than 1.5 s; never over an unread or unreadable file. */
  saveMemory() {
    if (this.memoryBroken || !this.memoryLoaded) {
      return Promise.resolve(false);
    }
    let data;
    try {
      data = this.serialized();
    } catch {
      return Promise.resolve(false);
    }
    return this.bounded(Promise.resolve().then(() => this.store.save(data))).then(
      () => true,
      (err) => {
        if (!this.saveWarned) {
          this.saveWarned = true;
          this.logger.warn(`The state could not be saved in /data: ${err?.code ?? 'error'}`);
        }
        return false;
      },
    );
  }

  /** Saves, or throws: what must be on disk before a command leaves. */
  async saveStrict() {
    if (this.memoryBroken || !(await this.saveMemory())) {
      throw this.refusal(ERRORS.unreadableData);
    }
  }

  /** The rest of the pause (ms), capped at its maximum at every use. */
  pauseLeft(mono = this.monotonic()) {
    return Math.max(0, Math.min(this.pauseUntil - mono, TIMINGS.pauseMax));
  }

  // --- Lifecycle -------------------------------------------------------------------

  freshSession(config) {
    return {
      client: new EmsClient({
        host: config.host,
        port: config.port,
        token: config.token,
        monotonic: this.monotonic,
        timers: this.timers,
        ...(this.transport ? { transport: this.transport } : {}),
      }),
      online: undefined,
      failures: 0,
      wait: undefined,
      /** 'auth', 'busy', or a short reason. */
      error: undefined,
      timer: undefined,
      running: undefined,
      firmware: undefined,
      /** What /api/system said last: { fahrenheit, readonly, bus }. */
      system: undefined,
      /** When the last read of the polling began (monotonic). */
      lastAttemptAt: -Infinity,
      /** The follow-up reads after commands: one timer, the due times. */
      follow: { timer: undefined, due: [] },
      following: undefined,
      /** What the last read gave: { key, values, at (monotonic) }. */
      data: undefined,
    };
  }

  /**
   * Connected to Gladys (also after every reconnection). The configuration
   * is read; when getConfig() fails it is tried again without end, the
   * session in place (if any) going on meanwhile.
   */
  async connected(getConfig) {
    const retry = this.configRetry;
    retry.generation += 1;
    if (retry.timer) {
      this.timers.clearTimeout(retry.timer);
      retry.timer = undefined;
    }
    const generation = retry.generation;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (generation !== retry.generation) {
        return;
      }
      const wait = TIMINGS.configRetry[Math.min(retry.step, TIMINGS.configRetry.length - 1)];
      retry.step += 1;
      this.logger.warn(
        `Reading the configuration failed (${err?.message ?? 'error'}): next try in ${wait / SECOND} s`,
      );
      if (!this.configRead) {
        const fallback = this.gladys.config;
        if (fallback && typeof fallback === 'object' && Object.keys(fallback).length > 0) {
          // The SDK read the configuration just before `connected`: used
          // meanwhile (a stop is never refused for want of it); ours is read
          // again below and applied when it comes.
          await this.applyConfig(fallback, { reconnected: false });
        } else {
          await this.loadMemory();
          this.lastStatus = undefined;
          await this.setStatus(false, T.configWait(age(wait)));
        }
      }
      retry.timer = this.timers.setTimeout(() => {
        retry.timer = undefined;
        if (generation === retry.generation) {
          void this.connected(getConfig);
        }
      }, wait);
      return;
    }
    if (generation !== retry.generation) {
      return;
    }
    retry.step = 0;
    await this.applyConfig(raw, { reconnected: true });
  }

  /** Saved by the user. */
  configUpdated(raw = {}) {
    return this.applyConfig(raw, { reconnected: false });
  }

  /** Configurations applied one at a time, in order: the last one wins. */
  applyConfig(raw, options) {
    const run = this.configChain.then(() => this.apply(raw, options));
    this.configChain = run.catch((err) => this.logger.error('Configuration failed', err));
    return this.configChain;
  }

  async apply(raw, { reconnected }) {
    const next = normalizeConfig(raw);
    if (!this.started || !this.configRead) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (connectionKey(next) !== connectionKey(this.config)) {
      // Other credentials or another address lift a refusal (never a pause).
      if (this.memory.refused && !reconnected) {
        this.liftRefusal();
        await this.saveMemory();
      }
      await this.start(raw, { changed: !reconnected });
      return;
    }
    const previous = this.config;
    this.config = next;
    if (next.pollInterval !== previous.pollInterval && this.session && !this.session.running) {
      // Only the interval: the session stays; the next read follows the new interval.
      this.schedule();
    }
    if (next.allowCommands !== previous.allowCommands) {
      this.logger.info(`EMS-ESP commands ${next.allowCommands ? 'allowed' : 'off'}`);
    }
    if (reconnected || next.language !== previous.language) {
      // Gladys restarted (or another language): what it keeps in memory again.
      this.published = undefined;
      this.badge = undefined;
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
      await this.publishAll();
    }
  }

  async start(raw = {}, { changed = false } = {}) {
    const previous = this.session;
    this.stopSession();
    // The old connection is closed before the new one opens.
    await previous?.client.gate.idle();
    await previous?.running?.catch(() => {});
    this.config = normalizeConfig(raw);
    this.configRead = true;
    // The session exists before /data is read: a stop clicked meanwhile leaves.
    this.session = this.config.problem ? undefined : this.freshSession(this.config);
    const session = this.session;
    await this.loadMemory();
    if (session !== this.session) {
      return;
    }
    const lifted = await this.checkRefusal();
    if (changed || lifted) {
      // Other credentials: a stop refused with the old ones is tried again.
      this.resetStopTries();
    }
    this.seen.clear();
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!session) {
      await this.publishAll();
      return;
    }
    await this.setStatus(false, T.connecting);
    // Stops kept in /data that the gateway never answered go first, without waiting for a read.
    for (const stop of Object.values(this.memory.stops)) {
      if (this.stopToResend(session, stop)) {
        void this.resendStop(session, stop, 'restart');
      }
    }
    // A restart never reads sooner than the interval after the last read
    // (other credentials are tried at once).
    const since = Math.max(0, this.now() - this.memory.lastReadAt);
    if (!changed && !lifted && this.memory.lastReadAt > 0 && since < this.interval) {
      session.lastAttemptAt = this.monotonic() - since;
      this.schedule();
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  stopSession() {
    this.generation += 1;
    const session = this.session;
    if (session) {
      if (session.timer) {
        this.timers.clearTimeout(session.timer);
        session.timer = undefined;
      }
      if (session.follow.timer) {
        this.timers.clearTimeout(session.follow.timer);
        session.follow.timer = undefined;
      }
      session.client.close();
    }
    this.publisher.stop();
  }

  /** Clean shutdown: timers cleared, /data written. */
  async stop() {
    this.stopSession();
    const retry = this.configRetry;
    retry.generation += 1;
    if (retry.timer) {
      this.timers.clearTimeout(retry.timer);
      retry.timer = undefined;
    }
    await this.saveMemory();
  }

  /** For the tests: everything under way has ended. */
  async idle() {
    for (let i = 0; i < 20; i += 1) {
      const session = this.session;
      await this.configChain;
      await session?.running?.catch(() => {});
      await session?.following?.catch(() => {});
      await this.working;
      await session?.client.gate.idle();
      if (!session?.running && !session?.following && !session?.client.busy) {
        return;
      }
    }
  }

  /** The refusal of the credentials, lifted only for other ones. Returns true when lifted. */
  async checkRefusal() {
    if (!this.memory.refused || this.config.problem) {
      return false;
    }
    if (this.memory.fp !== '' && this.memory.fp !== refusalPrint(this.memory.salt, this.config)) {
      this.liftRefusal();
      await this.saveMemory();
      return true;
    }
    return false;
  }

  liftRefusal() {
    this.memory.refused = false;
    this.memory.fp = '';
    this.resetStopTries();
  }

  /**
   * The 4xx answers the stops got are forgotten: they may have come from
   * the credentials (other ones now, or the reads refused them too).
   */
  resetStopTries() {
    for (const stop of Object.values(this.memory.stops)) {
      stop.tries = 0;
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    this.lastMessage = message;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = undefined;
      this.logger.warn(`setConnectionStatus failed: ${err.message}`);
    });
  }

  /** The last status text, in the language of the configuration. */
  lastText() {
    return this.lastMessage ? word(this.lastMessage, this.config.language) : undefined;
  }

  // --- Polling ---------------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The monotonic time from which the next read may start, from the caller's instant `mono`. */
  dueAt(mono) {
    const session = this.session;
    const base =
      session.online === false ? Math.max(this.interval, session.wait ?? 0) : this.interval;
    return Math.max(session.lastAttemptAt + base, mono + this.pauseLeft(mono));
  }

  /** The next read; never while refused (only the user tries again). */
  schedule() {
    const session = this.session;
    if (!session) {
      return;
    }
    if (session.timer) {
      this.timers.clearTimeout(session.timer);
      session.timer = undefined;
    }
    if (this.memory.refused) {
      return;
    }
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    const generation = this.generation;
    session.timer = this.timers.setTimeout(() => {
      session.timer = undefined;
      if (generation === this.generation) {
        this.tick().catch(() => this.logger.error('EMS-ESP refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. `force`: the user asked. */
  tick({ force = false } = {}) {
    const session = this.session;
    if (!session) {
      return Promise.resolve();
    }
    if (!session.running) {
      session.running = this.run(session, { force }).finally(() => {
        session.running = undefined;
      });
    }
    return session.running;
  }

  async run(session, { force }) {
    while (session.following) {
      await session.following.catch(() => {});
    }
    const generation = this.generation;
    // Stops never answered go first, whatever holds the reads.
    for (const stop of Object.values(this.memory.stops)) {
      if (this.stopToResend(session, stop)) {
        await this.resendStop(session, stop, 'read');
      }
    }
    if (generation !== this.generation) {
      return;
    }
    const mono = this.monotonic();
    if (this.pauseLeft(mono) > 0) {
      this.halted(session, 'busy', this.pauseLeft(mono));
    } else if (this.memory.refused && !force) {
      this.halted(session, 'auth', undefined);
    } else {
      session.lastAttemptAt = mono;
      const now = this.now();
      if (
        now - this.memory.lastReadAt >= Math.min(MINUTE, this.interval) ||
        this.memory.lastReadAt > now
      ) {
        // On disk before the read leaves (at most once a minute, or once an interval).
        this.memory.lastReadAt = now;
        await this.saveMemory();
      }
      try {
        await this.read(session, generation);
      } catch (err) {
        if (generation !== this.generation) {
          return;
        }
        // Cut by a stop: not a failure (the next read comes at the interval).
        if (err?.code !== CODES.ABORTED) {
          this.failed(session, err);
        }
      }
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule();
    }
  }

  halted(session, error, wait) {
    session.online = false;
    session.error = error;
    session.wait = wait;
  }

  /**
   * A value EMS-ESP may not have: a 4xx (401/403 included: only /api/system
   * decides on the key) or a bad answer leaves it out; the rest throws.
   */
  async optional(client, path, options) {
    try {
      return await client.get(path, options);
    } catch (err) {
      if (isMissing(err) || err?.code === CODES.BAD_ANSWER) {
        return undefined;
      }
      throw err;
    }
  }

  /**
   * /api/system: the identity, the version, the settings, the bus. 401/403
   * here (and only here) is a refusal of the key; an answer that is not one
   * of EMS-ESP is a bad answer (a failed read, never a refusal).
   */
  async readSystem(client, options) {
    let answer;
    try {
      answer = await client.get(PATHS.system, options);
    } catch (err) {
      if (isDenied(err)) {
        throw new EmsError(CODES.AUTH, { sent: true, status: err.status });
      }
      throw err;
    }
    const system = systemOf(answer);
    if (!system) {
      throw new EmsError(CODES.BAD_ANSWER, { sent: true });
    }
    return system;
  }

  /**
   * The circuits from the short values of the boiler and the thermostat: the
   * heating of the boiler (on/off), each hot water (temperature, setpoint,
   * on/off), each thermostat circuit (room temperature, setpoint, and its
   * operating mode read as an entity, for the modes it lists).
   */
  async readCircuits(client, boiler, thermostat, fahrenheit, circuits, generation) {
    for (const circuit of circuitsOf(boiler, 'heating')) {
      const value = boolOf(valueAt(boiler, '', CIRCUIT_FIELDS.heating.mode));
      if (value !== undefined) {
        circuits.set(circuit, { kind: 'heating', mode: { value, allowed: [ON, OFF] } });
      }
    }
    for (const circuit of circuitsOf(boiler, 'dhw')) {
      const tag = tagOf(circuit);
      const fields = CIRCUIT_FIELDS.dhw;
      const temperature = fields.temperatures
        .map((field) => temperatureOf(valueAt(boiler, tag, field), RANGES.dhw, fahrenheit))
        .find((t) => t !== undefined);
      const setpoint = temperatureOf(
        valueAt(boiler, tag, fields.setpoint),
        RANGES.setpoint,
        fahrenheit,
      );
      const on = boolOf(valueAt(boiler, tag, fields.mode));
      const mode = on === undefined ? undefined : { value: on, allowed: [ON, OFF] };
      if (temperature !== undefined || setpoint !== undefined || mode) {
        circuits.set(circuit, { kind: 'dhw', temperature, setpoint, mode });
      }
    }
    for (const circuit of circuitsOf(thermostat, 'hc')) {
      if (generation !== this.generation) {
        return;
      }
      const tag = tagOf(circuit);
      const fields = CIRCUIT_FIELDS.hc;
      const temperature = temperatureOf(
        valueAt(thermostat, tag, fields.temperatures[0]),
        RANGES.hc,
        fahrenheit,
      );
      const setpoint = temperatureOf(
        valueAt(thermostat, tag, fields.setpoint),
        RANGES.setpoint,
        fahrenheit,
      );
      const mode =
        valueAt(thermostat, tag, fields.mode) === undefined
          ? undefined
          : modeOf(await this.optional(client, modePath(circuit)));
      if (temperature !== undefined || setpoint !== undefined || mode) {
        circuits.set(circuit, { kind: 'hc', temperature, setpoint, mode });
      }
    }
  }

  /**
   * One read: /api/system (identity, bus: a failure fails the read), then,
   * with an identity and the bus connected, the values of the boiler and of
   * the thermostat (a device missing is left out). A read during which a
   * write left is dropped (its values may predate the write).
   */
  async read(session, generation) {
    const { client } = session;
    const writes = this.writes;
    const startedAt = this.monotonic();
    const system = await this.readSystem(client);
    if (generation !== this.generation) {
      return;
    }
    session.firmware = system.version ?? null;
    session.system = system;
    const key = system.key;
    const live = Boolean(key) && system.bus === 'connected';
    const values = { circuits: new Map() };
    if (live) {
      const boiler = await this.optional(client, PATHS.boiler);
      const thermostat = await this.optional(client, PATHS.thermostat);
      const f = system.fahrenheit;
      values.outdoor = temperatureOf(valueAt(boiler, '', 'outdoortemp'), RANGES.outdoor, f);
      values.supply = temperatureOf(valueAt(boiler, '', 'curflowtemp'), RANGES.supply, f);
      values.pressure = numberIn(valueAt(boiler, '', 'syspress'), RANGES.pressure);
      await this.readCircuits(client, boiler, thermostat, f, values.circuits, generation);
    }
    if (generation !== this.generation) {
      return;
    }
    session.online = true;
    session.failures = 0;
    session.wait = undefined;
    session.error = undefined;
    if (this.memory.refused) {
      // The button tried and it went through: the refusal is lifted, and the
      // stops kept since leave at once.
      this.liftRefusal();
      void this.saveMemory();
      for (const stop of Object.values(this.memory.stops)) {
        if (this.stopToResend(session, stop)) {
          void this.resendStop(session, stop, 'key accepted');
        }
      }
    }
    if (this.writes !== writes) {
      // A command wrote meanwhile: these values may predate it; the follow-ups read again.
      return;
    }
    session.data = { key, values: live ? values : undefined, bus: system.bus, at: startedAt };
    if (live) {
      this.observe(session, startedAt);
    }
  }

  /** A read failed: the refusal (key), the pause (429/5xx), or a backoff. */
  failed(session, err) {
    session.online = false;
    const blocked = this.block(err);
    if (blocked) {
      session.error = blocked.kind;
      session.wait = blocked.wait;
      session.failures += 1;
      return;
    }
    const reason = reasonOf(err);
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(session.failures, TIMINGS.backoff.length - 1)],
    );
    session.failures += 1;
    session.wait = wait;
    session.error = reason;
    this.logger.warn(`EMS-ESP: ${reason}; next try in ${Math.round(wait / 1000)} s`);
  }

  /** A key refused or a 429/5xx: the refusal or the pause, persisted. */
  block(err) {
    if (isKeyRefused(err)) {
      this.memory.refused = true;
      this.memory.fp = refusalPrint(this.memory.salt, this.config);
      // The reads refused too: the 4xx a stop got may have come from the key.
      this.resetStopTries();
      void this.saveMemory();
      this.logger.warn(
        'EMS-ESP refuses the reads with this API key (401/403): stopped, no automatic retry',
      );
      return { kind: 'auth', wait: undefined };
    }
    if (isBusy(err)) {
      const step =
        TIMINGS.backoff[Math.min(this.session?.failures ?? 0, TIMINGS.backoff.length - 1)];
      const wait = Math.min(TIMINGS.pauseMax, Math.max(TIMINGS.pauseMin, this.interval, step));
      const mono = this.monotonic();
      this.pauseUntil = Math.max(this.pauseUntil, mono + wait);
      void this.saveMemory();
      this.logger.warn(
        `EMS-ESP busy (HTTP ${err.status}): paused for ${Math.round(wait / 1000)} s`,
      );
      return { kind: 'busy', wait };
    }
    return undefined;
  }

  // --- Gladys ------------------------------------------------------------------------

  createdDevice(key) {
    const id = deviceIds(this.gladys, key).device;
    return (this.gladys.devices ?? []).find((d) => d?.external_id === id);
  }

  /** The keys of our created devices. */
  createdKeys() {
    const keys = [];
    for (const device of this.gladys.devices ?? []) {
      const key = parseDeviceId(device?.external_id);
      if (key !== undefined && deviceIds(this.gladys, key).device === device.external_id) {
        keys.push(key);
      }
    }
    return keys;
  }

  /** The last read, when it is recent enough to be shown (never a stale value as new). */
  freshData() {
    const data = this.session?.data;
    if (!data || this.session.online !== true) {
      return undefined;
    }
    const elapsed = this.monotonic() - data.at;
    return elapsed <= 2 * this.interval + 30 * SECOND ? data : undefined;
  }

  /**
   * How a device stands: 'online', 'foreign' (another gateway answers at
   * the address), 'unknown' (identity or values not read), 'offline';
   * undefined while the first read is under way.
   */
  standing(key) {
    const session = this.session;
    if (!session || session.online === false) {
      return 'offline';
    }
    const data = session.data;
    if (!data) {
      return undefined;
    }
    if (!data.key) {
      return 'unknown';
    }
    if (data.key !== key) {
      return 'foreign';
    }
    return data.values && this.freshData() ? 'online' : 'unknown';
  }

  rolesFor(key) {
    const seen = this.seen.get(key) ?? new Set();
    const data = this.session?.data;
    if (data?.key === key) {
      for (const role of reportedRoles(data.values)) {
        seen.add(role);
      }
    }
    seen.add(F.STATUS);
    this.seen.set(key, seen);
    return seen;
  }

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The Discovery list: the gateway read now (with its identity), and the devices already created. */
  async publishDevices() {
    const keys = new Set(this.createdKeys());
    const data = this.session?.data;
    if (data?.key && data.values) {
      keys.add(data.key);
    }
    const devices = [...keys].map((key) =>
      buildDevice(this.gladys, key, {
        roles: this.rolesFor(key),
        values: data?.key === key ? data.values : undefined,
        firmware: data?.key === key ? (this.session?.firmware ?? undefined) : undefined,
        language: this.config.language,
        created: this.createdDevice(key),
      }),
    );
    if (devices.length === 0) {
      return;
    }
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /** The texts about the stops from Gladys on this device, if any. */
  stopNote(key) {
    const list = [];
    for (const stop of Object.values(this.memory.stops)) {
      if (stop.key !== key) {
        continue;
      }
      if (stop.phase === 'unsent') {
        list.push(
          stop.tries >= TIMINGS.stopResends
            ? STATUS_TEXTS.stopRefused(stop.circuit)
            : STATUS_TEXTS.stopUnsent(stop.circuit),
        );
      } else if (stop.phase === 'confirmed') {
        list.push(STATUS_TEXTS.stopped(stop.circuit));
      } else {
        const mode = this.session?.data?.values?.circuits.get(stop.circuit)?.mode?.value;
        list.push(
          mode !== undefined && mode !== OFF && stop.resends >= TIMINGS.stopResends
            ? STATUS_TEXTS.stopUnapplied(stop.circuit)
            : STATUS_TEXTS.stopPending(stop.circuit),
        );
      }
    }
    return list.length > 0 ? notes(list) : undefined;
  }

  queueStates(created = this.createdFeatures()) {
    const fresh = this.freshData();
    for (const key of this.createdKeys()) {
      const status = this.standing(key);
      if (status === undefined) {
        continue;
      }
      const states = deviceStates(deviceIds(this.gladys, key), {
        values: status === 'online' ? fresh.values : undefined,
        status,
        note: this.stopNote(key),
        language: this.config.language,
      });
      for (const { device_feature_external_id: id, ...value } of states) {
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    }
  }

  async publishBadge() {
    const entries = [];
    for (const key of this.createdKeys()) {
      const status = this.standing(key);
      if (status === undefined) {
        continue;
      }
      entries.push({
        external_id: deviceIds(this.gladys, key).device,
        transport: status === 'online' ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  async updateStatus() {
    const [connected, message] = this.status();
    await this.setStatus(connected, message);
  }

  status() {
    const [connected, message] = this.baseStatus();
    return this.memoryBroken
      ? [connected, T.withNote(message, T.unreadable)]
      : [connected, message];
  }

  baseStatus() {
    const session = this.session;
    if (!session) {
      return [false, T.problem(this.config.problem)];
    }
    if (this.memory.refused) {
      const waiting = Object.values(this.memory.stops).some((s) => s.phase === 'unsent');
      return [
        false,
        waiting ? T.withNote(T.refused, STATUS_TEXTS.stopWaitsCredentials) : T.refused,
      ];
    }
    if (session.online === false) {
      const wait = age(session.wait ?? this.interval);
      return session.error === 'busy'
        ? [false, T.busy(wait)]
        : [false, T.unreachable(session.error ?? 'error', wait)];
    }
    const data = session.data;
    if (!data) {
      const mono = this.monotonic();
      const next = this.dueAt(mono) - mono;
      return [false, next > SECOND ? T.nextRead(age(next)) : T.connecting];
    }
    if (data.bus !== 'connected') {
      return [false, T.busDown];
    }
    if (!data.key) {
      return [false, T.noIdentity];
    }
    const created = this.createdKeys();
    if (created.length > 0 && !created.includes(data.key)) {
      // Not ours: the device created in Gladys gets none of its values.
      return [false, T.foreign];
    }
    let text = T.connected(session.firmware ?? undefined);
    if (session.system?.readonly) {
      text = T.withNote(text, T.readonly);
    }
    if (session.system?.fahrenheit) {
      text = T.withNote(text, T.fahrenheit);
    }
    const note = this.stopNote(data.key);
    return [true, note ? T.withNote(text, note) : text];
  }

  /** A device was created (or updated): its last values, if recent, at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the list again (never a read sooner than the interval). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------------

  /**
   * Reads now (even after a refusal of the credentials: the user asked, one
   * try), but never sooner than the interval (10 s at least) after the last
   * read; else the current state and when the next read may come.
   */
  async testConnection() {
    if (!this.session) {
      return word(this.status()[1], this.config.language);
    }
    const floor = Math.max(TIMINGS.testCooldown, this.interval);
    const since = this.monotonic() - this.session.lastAttemptAt;
    if (since < floor) {
      const next = word(T.test.next(age(floor - since)), this.config.language);
      const last = this.lastText();
      return last ? `${next} ${last}` : next;
    }
    let handle;
    const limit = new Promise((resolve) => {
      handle = this.timers.setTimeout(resolve, TIMINGS.testBudget);
    });
    await Promise.race([this.tick({ force: true }), limit]);
    this.timers.clearTimeout(handle);
    return this.lastText() ?? word(T.connecting, this.config.language);
  }

  // --- The commands ------------------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /** The hard bounds of a setpoint (before those of the gateway), in °C. */
  hardBounds(kind) {
    return kind === 'hc'
      ? { low: ROOM.min, high: ROOM.max }
      : { low: DHW.min, high: Math.min(DHW.max, this.config.dhwCeiling) };
  }

  /** The bounds of the gateway intersected with ours (high rounded down to the step). */
  rangeOf(kind, setpoint) {
    const { low, high } = this.hardBounds(kind);
    const step = kind === 'hc' ? ROOM.step : 1;
    return {
      low: Math.ceil(Math.max(low, setpoint.min) / step) * step,
      high: Math.floor(Math.min(high, setpoint.max) / step) * step,
    };
  }

  /** The value of a setpoint command, checked strictly within the hard bounds. */
  parseSetpoint(kind, value) {
    const number = numberOf(value);
    if (number === undefined) {
      throw this.refusal(ERRORS.badNumber);
    }
    if (kind === 'hc' ? !Number.isInteger(number * 2) : !Number.isInteger(number)) {
      throw this.refusal(kind === 'hc' ? ERRORS.badHalf : ERRORS.badWhole);
    }
    const { low, high } = this.hardBounds(kind);
    if (number < low || number > high) {
      throw this.refusal(ERRORS.outOfRange(low, high));
    }
    return number;
  }

  /**
   * The mode values a circuit lists: on/off for the heating and the hot
   * water; for a thermostat circuit those of the created select and of the
   * last read.
   */
  listedModes(key, circuit) {
    const listed = new Set();
    if (CIRCUIT_FIELDS[kindOf(circuit)].boolean) {
      listed.add(ON);
      listed.add(OFF);
      return listed;
    }
    const id = deviceIds(this.gladys, key).feature(`${circuit}-${R.MODE}`);
    for (const device of this.gladys.devices ?? []) {
      for (const f of device?.features ?? []) {
        if (f?.external_id === id && Array.isArray(f.supported_options)) {
          for (const o of f.supported_options) {
            if (typeof o?.value === 'string') {
              listed.add(o.value);
            }
          }
        }
      }
    }
    const data = this.session?.data;
    if (data?.key === key) {
      for (const m of data.values?.circuits.get(circuit)?.mode?.allowed ?? []) {
        listed.add(m);
      }
    }
    return listed;
  }

  async setValue(device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !target.circuit || target.suffix === R.TEMPERATURE) {
      throw this.refusal(ERRORS.readOnly);
    }
    let wanted;
    if (target.suffix === R.MODE) {
      if (typeof value !== 'string' || !this.listedModes(target.key, target.circuit).has(value)) {
        throw this.refusal(ERRORS.badMode);
      }
      if (value === OFF) {
        return this.protect(target, received);
      }
      wanted = value;
    } else {
      wanted = this.parseSetpoint(target.kind, value);
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (this.queued >= LIMITS.queue) {
      throw this.refusal(ERRORS.queueFull);
    }
    this.queued += 1;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.push({ target, wanted, received, epoch: this.stopEpoch, resolve, reject });
        this.pump();
      });
    } finally {
      this.queued -= 1;
    }
  }

  /**
   * The commands, one batch at a time: those waiting together share one
   * fresh read (a scene setting several circuits at once fits in the ack
   * budget of each), then leave one by one, in order.
   */
  pump() {
    if (this.working) {
      return;
    }
    this.working = (async () => {
      // Commands arriving together (a scene: one WebSocket frame each) are
      // gathered first, so that they share one fresh read.
      await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.batchWindow));
      while (this.pending.length > 0) {
        const batch = this.pending.splice(0);
        try {
          await this.runBatch(batch);
        } catch (err) {
          for (const item of batch) {
            item.reject(err);
          }
        }
      }
    })().finally(() => {
      this.working = undefined;
    });
  }

  /** The checks of a non-protective command, on the latest configuration and state. */
  check({ generation, session, epoch }) {
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (epoch !== this.stopEpoch) {
      throw this.refusal(ERRORS.stopped);
    }
    if (this.memory.refused) {
      throw this.refusal(ERRORS.refusedAccount);
    }
    if (this.pauseLeft() > 0) {
      throw this.refusal(ERRORS.paused);
    }
    if (!session || generation !== this.generation || this.session !== session) {
      throw this.refusal(ERRORS.noConfig);
    }
    if (this.memoryBroken || !this.memoryLoaded) {
      // A stop of Gladys kept there is unknown: unreadable is not empty.
      throw this.refusal(ERRORS.unreadableData);
    }
  }

  /** The refusal of a command after a failed fresh read (nothing written). */
  readRefusal(err) {
    if (!(err instanceof EmsError)) {
      return err;
    }
    if (err.code === CODES.LATE || err.code === CODES.TIMEOUT) {
      return this.refusal(ERRORS.tooSlow);
    }
    if (err.code === CODES.ABORTED) {
      return this.refusal(ERRORS.stopped);
    }
    if (isKeyRefused(err)) {
      this.block(err);
      return this.refusal(ERRORS.refusedAccount);
    }
    this.block(err);
    return this.refusal(ERRORS.notRead(reasonOf(err)));
  }

  /** The entity a command writes. */
  targetPath(target) {
    const fields = CIRCUIT_FIELDS[target.kind];
    return entityPath(target.circuit, target.suffix === R.MODE ? fields.mode : fields.setpoint);
  }

  /**
   * One batch: the fresh read (identity, then the entity of each command),
   * then each command decided on it and written, then confirmed, within the
   * ack budget of each.
   */
  async runBatch(batch) {
    const session = this.session;
    const generation = this.generation;
    const live = [];
    for (const item of batch) {
      item.ctx = {
        generation,
        session,
        epoch: item.epoch,
        circuit: item.target.circuit,
        key: item.target.key,
      };
      item.sendBy = item.received + TIMINGS.commandSendBy;
      item.answerBy = item.received + TIMINGS.commandAnswerBy;
      try {
        this.check(item.ctx);
        if (item.target.suffix === R.SETPOINT && this.memory.stops[item.target.circuit]) {
          // A setpoint may restart a circuit stopped from Gladys: on (or another mode) first.
          throw this.refusal(ERRORS.stopHolds);
        }
        if (item.sendBy - TIMINGS.commandMinSend <= this.monotonic()) {
          // Its budget went on the commands before it.
          throw this.refusal(ERRORS.queueLate);
        }
        live.push(item);
      } catch (err) {
        item.reject(err);
      }
    }
    if (live.length === 0) {
      return;
    }
    const earliest = Math.min(...live.map((item) => item.sendBy));
    // The read must end with time left for the first one to leave.
    const readBy = earliest - TIMINGS.commandMinSend;
    const { client } = session;
    const options = { priority: PRIORITY.COMMAND, sendBy: readBy, answerBy: readBy };
    let system;
    const details = new Map();
    try {
      system = await this.readSystem(client, options);
      if (system.key) {
        for (const item of live) {
          const path = this.targetPath(item.target);
          if (!details.has(path)) {
            details.set(path, await this.optional(client, path, options));
          }
        }
      }
    } catch (err) {
      const refusal = this.readRefusal(err);
      for (const item of live) {
        item.reject(refusal);
      }
      return;
    }
    const written = [];
    for (const item of live) {
      try {
        if (!system.key) {
          throw this.refusal(ERRORS.noIdentity);
        }
        if (system.key !== item.target.key) {
          throw this.refusal(ERRORS.foreign);
        }
        const path = this.targetPath(item.target);
        const detail = details.get(path);
        const test =
          item.target.suffix === R.MODE
            ? await this.writeMode(item, modeOf(detail), path)
            : await this.writeSetpoint(item, setpointOf(detail, system.fahrenheit), path);
        if (test === undefined) {
          // Already so: nothing sent.
          item.resolve();
        } else {
          written.push({ item, test });
        }
      } catch (err) {
        item.reject(err);
      }
    }
    // Every write leaves first, then each is confirmed by reading its entity again.
    for (const { item, test } of written) {
      await this.confirm(item, test);
    }
  }

  /**
   * Another mode than "off" (on, or an operating mode): lifts the guard of a
   * stop of this circuit from Gladys (saved first), then the mode. Resolves
   * the test of the confirming read, or undefined when already so (nothing
   * sent).
   */
  async writeMode(item, mode, path) {
    const { ctx, sendBy, answerBy, wanted } = item;
    const { circuit } = item.target;
    if (!mode) {
      throw this.refusal(ERRORS.missingValue);
    }
    if (!mode.allowed.includes(wanted) || !mode.index.has(wanted)) {
      throw this.refusal(ERRORS.badMode);
    }
    if (!mode.writable) {
      throw this.refusal(ERRORS.notWritable);
    }
    const held = this.memory.stops[circuit] ?? null;
    if (mode.value === wanted && !held) {
      return undefined;
    }
    this.check(ctx);
    // The guard of the stop is lifted on disk before the mode may leave.
    if (held) {
      delete this.memory.stops[circuit];
      try {
        await this.saveStrict();
      } catch (err) {
        this.restoreStop(held);
        throw err;
      }
    }
    this.logger.info(`EMS-ESP: ${circuit} mode ${wanted}`);
    try {
      await ctx.session.client.post(path, mode.index.get(wanted), {
        priority: PRIORITY.COMMAND,
        sendBy,
        answerBy,
        // The very last check, once the connection is up, right before the request leaves.
        beforeSend: () => {
          this.check(ctx);
          this.writes += 1;
        },
      });
    } catch (err) {
      if (err.sent) {
        this.followUp(ctx.session);
      }
      // Not answered 200 (not sent, refused, 429, silence, 5xx): in doubt the
      // stop holds again, and its resends go on.
      this.restoreStop(held);
      void this.saveMemory();
      throw this.writeRefusal(err);
    }
    this.followUp(ctx.session);
    return { path, ok: (answer) => modeOf(answer)?.value === wanted };
  }

  /** A stop of ours put back after a mode that did not leave (unless a newer stop came). */
  restoreStop(held) {
    if (held && !this.memory.stops[held.circuit]) {
      this.memory.stops[held.circuit] = held;
    }
  }

  /**
   * A setpoint within the bounds EMS-ESP gives for the entity (read now) and
   * ours, in °C only. Resolves the test of the confirming read, or undefined
   * when already so.
   */
  async writeSetpoint(item, current, path) {
    const { ctx, sendBy, answerBy, wanted } = item;
    const { kind } = item.target;
    if (!current) {
      throw this.refusal(ERRORS.missingValue);
    }
    if (!current.celsius) {
      throw this.refusal(ERRORS.fahrenheit);
    }
    if (!current.writable) {
      throw this.refusal(ERRORS.notWritable);
    }
    const checkRange = () => {
      const range = this.rangeOf(kind, current);
      if (range.low > range.high || wanted < range.low || wanted > range.high) {
        throw this.refusal(ERRORS.outOfRange(range.low, range.high));
      }
      // The final guard, whatever the bounds read: never above 65 °C of hot water.
      if (kind === 'dhw' && wanted > DHW.max) {
        throw this.refusal(ERRORS.outOfRange(range.low, DHW.max));
      }
    };
    checkRange();
    if (current.value === wanted) {
      return undefined;
    }
    this.check(ctx);
    this.logger.info(`EMS-ESP: ${item.target.circuit} setpoint ${wanted} °C`);
    try {
      await ctx.session.client.post(path, wanted, {
        priority: PRIORITY.COMMAND,
        sendBy,
        answerBy,
        beforeSend: () => {
          this.check(ctx);
          if (this.memory.stops[item.target.circuit]) {
            throw this.refusal(ERRORS.stopHolds);
          }
          // The ceiling may have been lowered since the command arrived.
          checkRange();
          this.writes += 1;
        },
      });
    } catch (err) {
      if (err.sent) {
        this.followUp(ctx.session);
      }
      throw this.writeRefusal(err);
    }
    this.followUp(ctx.session);
    // Equal to the value before: not applied yet.
    return {
      path,
      ok: (answer) => setpointOf(answer)?.value === wanted && wanted !== current.value,
    };
  }

  /** The refusal of a write that failed. */
  writeRefusal(err) {
    if (err.beforeSend || !(err instanceof EmsError)) {
      return err;
    }
    const reason = reasonOf(err);
    this.logger.warn(`EMS-ESP: write failed (${reason})`);
    if (!err.sent) {
      // LATE here: the fresh read went through, the commands before it took the time.
      return err.code === CODES.LATE
        ? this.refusal(ERRORS.queueLate)
        : this.refusal(ERRORS.notSent(reason));
    }
    if (err.code === CODES.ABORTED) {
      return this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    if (isDenied(err)) {
      return this.refusal(ERRORS.denied);
    }
    if (isMissing(err)) {
      return this.refusal(ERRORS.rejected(reason));
    }
    this.block(err);
    return this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  /** The read that confirms a write, within its ack budget. */
  async confirm(item, test) {
    const answer = await this.readAfter(item.ctx.session, test.path, item.answerBy);
    if (answer && test.ok(answer) === true) {
      item.resolve();
    } else {
      item.reject(this.refusal(ERRORS.notYetApplied));
    }
  }

  /** One path read now (a read leaving after the writes), or undefined. */
  async readAfter(session, path, answerBy) {
    if (answerBy - this.monotonic() <= 50) {
      return undefined;
    }
    try {
      return await session.client.get(path, {
        priority: PRIORITY.COMMAND,
        sendBy: answerBy,
        answerBy,
      });
    } catch {
      return undefined;
    }
  }

  // --- The stop --------------------------------------------------------------------------

  /**
   * "Off": the protective command. No option, no bounds, no pause, no
   * refusal, no read nor command under way holds it. Refused only without
   * a usable configuration, or when the last read showed another
   * installation (the value was checked against the modes the circuit
   * lists).
   */
  async protect(target, received) {
    // Cancels the commands not sent yet (checked right before each leaves).
    this.stopEpoch += 1;
    const session = this.session;
    if (!session || !this.configRead || this.config.problem) {
      throw this.refusal(ERRORS.noConfig);
    }
    const known = session.data?.key;
    if (known && known !== target.key) {
      throw this.refusal(ERRORS.foreign);
    }
    const stop = {
      key: target.key,
      circuit: target.circuit,
      phase: 'unsent',
      tries: 0,
      resends: 0,
      starts: 0,
      // Clicked during this run: kept over the file if /data is read after it.
      live: true,
    };
    this.memory.stops[target.circuit] = stop;
    // Never waited for: the stop does not depend on /data.
    void this.saveMemory();
    this.logger.info(`EMS-ESP: ${target.circuit} off (stop from Gladys)`);
    const answerBy = received + TIMINGS.commandAnswerBy;
    const outcome = await this.sendStop(session, stop, {
      sendBy: received + TIMINGS.commandSendBy,
      answerBy,
    });
    // The status and the states say it (never waited for: the ack first).
    void this.publishAll();
    if (!outcome.ok) {
      throw this.refusal(outcome.error);
    }
    const after = modeOf(await this.readAfter(session, modePath(target.circuit), answerBy))?.value;
    const off = after === OFF;
    if (off && this.memory.stops[target.circuit] === stop && stop.phase === 'sent') {
      // A read that left after the stop shows it applied: no resend from now on.
      stop.phase = 'confirmed';
      void this.saveMemory();
    }
    if (!off) {
      throw this.refusal(ERRORS.stopNotYet);
    }
  }

  /**
   * One stop, cut-through (the Gate takes the connection), tried again for
   * 250 ms when it could not connect. Updates the stop kept in /data (never
   * waited for) and arms the follow-up reads. Resolves { ok } or { error }
   * (never throws).
   */
  async sendStop(session, stop, options) {
    const circuit = stop.circuit;
    this.stopping.set(circuit, (this.stopping.get(circuit) ?? 0) + 1);
    let outcome;
    try {
      outcome = await this.sendStopOnce(session, stop, options);
      return outcome;
    } finally {
      this.stopping.set(circuit, this.stopping.get(circuit) - 1);
      if (!outcome?.ok && this.session && this.session !== session) {
        // The session changed meanwhile (other credentials saved): a stop
        // never answered goes on the new one at once.
        const current = this.memory.stops[circuit];
        if (current) {
          void this.resendStop(this.session, current, 'new session');
        }
      }
    }
  }

  async sendStopOnce(session, stop, { sendBy, answerBy, resend = false }) {
    const path = modePath(stop.circuit);
    const retryEnd = this.monotonic() + TIMINGS.stopRetryBudget;
    // Sent while the reads are refused: EMS-ESP may refuse it too.
    const blind = this.memory.refused;
    let err;
    for (;;) {
      err = undefined;
      try {
        // "off" is understood by EMS-ESP whatever its language (booleans and modes alike).
        await session.client.stop(path, OFF, {
          sendBy,
          answerBy,
          beforeSend: () => {
            this.stopSentAt.set(stop.circuit, this.monotonic());
            this.writes += 1;
          },
        });
      } catch (failure) {
        err = failure;
      }
      const retry =
        err &&
        !err.sent &&
        err.code === CODES.UNREACHABLE &&
        this.monotonic() + TIMINGS.stopRetryStep < Math.min(retryEnd, sendBy);
      if (!retry) {
        break;
      }
      await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.stopRetryStep));
    }
    // Only the stop still kept for this circuit is updated (a newer one or a mode replaced it).
    const current = this.memory.stops[stop.circuit] === stop ? stop : undefined;
    // The next check is armed before any save (a stop that never left is
    // sent again by the next periodic read instead).
    if (!err || err.sent) {
      this.followUp(session);
    }
    if (blind && err) {
      // The reads are refused: a refusal of the stop may come from the key
      // too. Kept as it was, never counted; sent again first once another
      // key is saved or the button gets through. (A 200 is EMS-ESP taking
      // it: it goes on below.)
      void this.saveMemory();
      return { error: ERRORS.stopAfterCredentials(err ? reasonOf(err) : 'key') };
    }
    if (!err) {
      if (current) {
        if (current.phase === 'unsent') {
          current.phase = 'sent';
        }
        if (resend) {
          current.resends += 1;
        }
      }
      void this.saveMemory();
      return { ok: true };
    }
    const reason = reasonOf(err);
    this.logger.warn(`EMS-ESP: stop failed (${reason})`);
    if (isMissing(err)) {
      // An answer refusing it (a 401/403: a key without the write right):
      // counted only when the reads go through.
      if (current && !this.memory.refused && session.online === true) {
        current.tries += 1;
      }
      void this.saveMemory();
      return { error: isDenied(err) ? ERRORS.stopDenied : ERRORS.stopRejected(reason) };
    }
    if (isBusy(err)) {
      // An answer, but no try: kept as it was, sent again (the pause never holds it).
      this.block(err);
      void this.saveMemory();
      return { error: ERRORS.stopUnsent(reason) };
    }
    void this.saveMemory();
    // Never answered (not sent, timeout, cut): it stays as it was and leaves again.
    return { error: err.sent ? ERRORS.stopUnconfirmed(reason) : ERRORS.stopUnsent(reason) };
  }

  /** Whether a stop kept in /data that the gateway never answered is to be sent again now. */
  stopToResend(session, stop) {
    const known = session.data?.key;
    return Boolean(
      stop &&
      this.memory.stops[stop.circuit] === stop &&
      stop.phase === 'unsent' &&
      // Only answers refusing it count; a stop never answered is sent again
      // at each read, without end.
      stop.tries < TIMINGS.stopResends &&
      !this.stopping.get(stop.circuit) &&
      // Never to another installation read at the address (as a click).
      !(known && known !== stop.key),
    );
  }

  /** A stop kept in /data never answered: sent again, not waited for by a click. */
  async resendStop(session, stop, why) {
    if (!this.stopToResend(session, stop)) {
      return;
    }
    this.logger.warn(`EMS-ESP: stop of ${stop.circuit} sent again (${why})`);
    const mono = this.monotonic();
    await this.sendStop(session, stop, {
      sendBy: mono + TIMINGS.commandSendBy,
      answerBy: mono + TIMINGS.commandAnswerBy,
    });
  }

  /**
   * A read through the stops of Gladys (reads begun after the stop left
   * only): an "off" mode = applied; once applied, another mode read twice
   * in a row = changed elsewhere, the guard lifted; answered but not applied
   * and another mode read = sent again, 3 answered resends at most.
   */
  observe(session, startedAt) {
    const { key, values } = session.data;
    for (const stop of Object.values(this.memory.stops)) {
      if (stop.key !== key || startedAt <= (this.stopSentAt.get(stop.circuit) ?? -Infinity)) {
        continue;
      }
      const mode = values.circuits.get(stop.circuit)?.mode?.value;
      if (mode === undefined) {
        continue;
      }
      if (mode === OFF) {
        if (stop.phase !== 'confirmed' || stop.starts !== 0) {
          stop.phase = 'confirmed';
          stop.starts = 0;
          void this.saveMemory();
        }
      } else if (stop.phase === 'confirmed') {
        stop.starts += 1;
        if (stop.starts >= 2) {
          this.logger.info(`EMS-ESP: ${stop.circuit} mode changed elsewhere after the stop`);
          delete this.memory.stops[stop.circuit];
        }
        void this.saveMemory();
      } else if (
        stop.phase === 'sent' &&
        stop.resends < TIMINGS.stopResends &&
        !this.stopping.get(stop.circuit)
      ) {
        this.logger.warn(
          `EMS-ESP: ${stop.circuit} still not off after the stop: sent again (${stop.resends + 1}/${TIMINGS.stopResends})`,
        );
        const mono = this.monotonic();
        void this.sendStop(session, stop, {
          sendBy: mono + TIMINGS.commandSendBy,
          answerBy: mono + TIMINGS.commandAnswerBy,
          resend: true,
        });
      }
    }
  }

  /** After a write: follow-up reads 5 s and 20 s later (one timer, grouped). */
  followUp(session) {
    this.writes += 1;
    const mono = this.monotonic();
    const { follow } = session;
    for (const delay of TIMINGS.followUps) {
      follow.due.push(mono + delay);
    }
    follow.due = follow.due.sort((a, b) => a - b).slice(-FOLLOW_MAX);
    this.armFollow(session);
  }

  armFollow(session) {
    const { follow } = session;
    if (follow.timer || follow.due.length === 0) {
      return;
    }
    const generation = this.generation;
    const mono = this.monotonic();
    follow.timer = this.timers.setTimeout(
      () => {
        follow.timer = undefined;
        if (generation !== this.generation) {
          return;
        }
        const at = this.monotonic();
        follow.due = follow.due.filter((d) => d > at + 100);
        this.followRead(session).finally(() => this.armFollow(session));
      },
      Math.max(0, follow.due[0] - mono),
    );
  }

  /** A follow-up read: never during a pause or a refusal; a periodic read under way first. */
  async followRead(session) {
    while (session.running || session.following) {
      await (session.running ?? session.following).catch(() => {});
    }
    if (session !== this.session) {
      return;
    }
    const generation = this.generation;
    session.following = (async () => {
      // Stops never answered go first, as at every read (never blind: a
      // refused key waits for other credentials or the button).
      for (const stop of Object.values(this.memory.stops)) {
        if (!this.memory.refused && this.stopToResend(session, stop)) {
          await this.resendStop(session, stop, 'follow-up');
        }
      }
      if (generation !== this.generation || this.memory.refused || this.pauseLeft() > 0) {
        return;
      }
      try {
        await this.read(session, generation);
      } catch (err) {
        if (generation === this.generation) {
          // Only a pause or a refusal is kept: the next poll tells the rest.
          this.block(err);
        }
        return;
      }
      if (generation === this.generation) {
        await this.publishAll();
      }
    })().finally(() => {
      session.following = undefined;
    });
    await session.following;
  }
}
