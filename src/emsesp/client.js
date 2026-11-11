// -----------------------------------------------------------------------------
// The REST API of one EMS-ESP gateway: a read (GET of a JSON object) and a
// write (POST of { "value": ... }), through the Gate (one request at a time,
// a stop first: EMS-ESP answers 429 to a second GET while one is under way).
// The API key lives here only, not enumerable: never in a URL, a log, an
// error, /data.
//
// Deadlines are on the monotonic clock given (`sendBy`: the request must be
// written by then, else nothing leaves; `answerBy`: the answer by then).
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from '../constants.js';
import { CODES, EmsError } from './errors.js';
import { Gate, PRIORITY } from './gate.js';
import { httpRequest } from './http.js';

/** A path of the API: /api then 1 to 3 segments of lower case letters, digits and _. */
const PATH = /^\/api(\/[a-z0-9_]{1,40}){1,3}$/;

export class EmsClient {
  constructor({
    host,
    port,
    token,
    transport = httpRequest,
    monotonic = () => performance.now(),
    timers = globalThis,
  }) {
    this.host = host;
    this.port = port;
    this.transport = transport;
    this.monotonic = monotonic;
    this.timers = timers;
    this.gate = new Gate();
    Object.defineProperty(this, 'authorization', {
      value: token ? `Bearer ${token}` : undefined,
      enumerable: false,
    });
  }

  /** One exchange in its turn: resolves { status, body } of the transport. */
  exchange(path, { method = 'GET', body, priority = PRIORITY.POLL, sendBy, answerBy, beforeSend }) {
    if (this.gate.closed) {
      return Promise.reject(new EmsError(CODES.ABORTED));
    }
    if (!PATH.test(path)) {
      return Promise.reject(new EmsError(CODES.BAD_ANSWER));
    }
    return this.gate.run(priority, async (signal) => {
      const now = this.monotonic();
      if (sendBy !== undefined && now >= sendBy) {
        throw new EmsError(CODES.LATE);
      }
      const timeout = answerBy === undefined ? TIMINGS.requestTimeout : Math.max(1, answerBy - now);
      return this.transport({
        host: this.host,
        port: this.port,
        path,
        method,
        body,
        authorization: this.authorization,
        timeout,
        maxBytes: LIMITS.responseBytes,
        ...(sendBy === undefined ? {} : { sendWithin: Math.max(0, sendBy - now) }),
        beforeSend,
        signal,
        timers: this.timers,
      });
    });
  }

  /**
   * A read: resolves the JSON object of a 200; rejects HTTP (another
   * status), BAD_ANSWER (no JSON object).
   */
  async get(path, options = {}) {
    const { status, body } = await this.exchange(path, { ...options, method: 'GET' });
    if (status !== 200) {
      throw new EmsError(CODES.HTTP, { sent: true, status });
    }
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw new EmsError(CODES.BAD_ANSWER, { sent: true });
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw new EmsError(CODES.BAD_ANSWER, { sent: true });
    }
    return json;
  }

  /** A write: resolves on 200 (EMS-ESP took the request); HTTP otherwise. */
  async post(path, value, options = {}) {
    const body = JSON.stringify({ value });
    const { status } = await this.exchange(path, { ...options, method: 'POST', body });
    if (status !== 200) {
      throw new EmsError(CODES.HTTP, { sent: true, status });
    }
  }

  /** A stop ("off"): it takes the connection (see the Gate). */
  stop(path, value, options = {}) {
    this.gate.preempt();
    return this.post(path, value, { ...options, priority: PRIORITY.STOP });
  }

  /** Whether a request is in flight or waiting. */
  get busy() {
    return this.gate.busy;
  }

  close() {
    this.gate.close(new EmsError(CODES.ABORTED));
  }
}
