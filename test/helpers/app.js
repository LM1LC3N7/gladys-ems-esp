// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys (the exact handlers of index.js), a
// fake EMS-ESP and a virtual clock that moves at every read.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EmsApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { identityKey } from '../../src/model.js';
import { CONFIG, fakeEmsEsp } from '../fixtures/emsesp.js';
import { settle, testClock } from '../kit/index.mjs';

export const SELECTOR = 'ems-esp-test';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const KEY = identityKey('boiler', 123, '0x08');
export const DEVICE = `ext:${SELECTOR}:ems-esp:${KEY}`;
export const F = (role, key = KEY) => `ext:${SELECTOR}:ems-esp:${key}:${role}`;

/** A logger keeping its lines ('warn message'). */
export function memoryLogger() {
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map((a) => a?.message ?? String(a)).join(' ')}`);
  return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

export async function setup({
  config = CONFIG,
  store = memoryStore(),
  latency = 0,
  clock = testClock({ start: Date.UTC(2026, 10, 11, 10, 0, 0) }),
  gladysOptions = {},
  getConfig,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, ...gladysOptions });
  const dev = fakeEmsEsp({ timers: clock.timers, latency });
  const logger = memoryLogger();
  const app = new EmsApp({
    gladys,
    logger,
    store,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    transport: dev.transport,
  });
  registerHandlers(gladys, app, logger);
  if (getConfig) {
    gladys.getConfig = getConfig;
  }
  /** Lets the clock run `ms` and everything settle. */
  const wait = async (ms = 0) => {
    await clock.advance(ms);
    await settle(10);
  };
  /** Runs a promise while the clock moves (step by step), and resolves its outcome. */
  const during = async (promise, ms = 10 * SECOND, step = 50) => {
    let done = false;
    let outcome;
    promise.then(
      (value) => {
        done = true;
        outcome = { ok: true, value };
      },
      (error) => {
        done = true;
        outcome = { ok: false, error };
      },
    );
    for (let t = 0; t < ms && !done; t += step) {
      await wait(step);
    }
    await settle(10);
    return outcome;
  };
  const connect = async () => {
    const outcome = await during(gladys.connect(), 30 * SECOND);
    if (outcome && !outcome.ok) {
      throw outcome.error;
    }
    await wait(0);
  };
  /** Creates the published device in Gladys, as the user would from Discovery. */
  const create = async () => {
    const device = gladys.fake.discoveredDevices.find((d) => d.external_id === DEVICE);
    if (!device) {
      throw new Error('device not discovered');
    }
    gladys.fake.devices = [...(gladys.fake.devices ?? []), device];
    await gladys.fake.deviceCreated(device);
    await wait(SECOND);
    return device;
  };
  /** A command as Gladys sends it, with the clock moving; resolves the ack. */
  const command = async (role, value, { ms = 6 * SECOND } = {}) => {
    const device = { external_id: DEVICE };
    const feature = { external_id: F(role) };
    const outcome = await during(gladys.fake.setValue(device, feature, value), ms);
    return outcome?.ok ? outcome.value : { success: false, error: 'no ack' };
  };
  return { gladys, dev, app, store, clock, logger, wait, during, connect, create, command };
}

/** The last text or state published for a role. */
export const last = (gladys, role, key) => gladys.fake.lastState(F(role, key));
