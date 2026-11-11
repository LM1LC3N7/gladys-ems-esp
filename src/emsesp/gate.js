// -----------------------------------------------------------------------------
// One request at a time to EMS-ESP (a small embedded web server that answers
// 429 to a second GET under way), never two connections open together. The
// waiting requests leave by priority: a stop first, then a command, then the
// polling. A stop also takes the connection: the request in flight (a read,
// or a command already written) is cut, and the stop leaves once its socket
// is closed (the transport settles only then).
// -----------------------------------------------------------------------------

export const PRIORITY = {
  STOP: 0,
  COMMAND: 1,
  POLL: 2,
};

export class Gate {
  constructor() {
    /** [{ priority, fn, resolve, reject, controller }] in leaving order. */
    this.queue = [];
    this.current = undefined;
    this.closed = false;
  }

  /** Runs `fn(signal)` in its turn; resolves or rejects as it does. */
  run(priority, fn) {
    return new Promise((resolve, reject) => {
      const entry = { priority, fn, resolve, reject, controller: new AbortController() };
      const at = this.queue.findIndex((e) => e.priority > priority);
      if (at === -1) {
        this.queue.push(entry);
      } else {
        this.queue.splice(at, 0, entry);
      }
      this.pump();
    });
  }

  pump() {
    if (this.current || this.queue.length === 0) {
      return;
    }
    const entry = this.queue.shift();
    this.current = entry;
    let promise;
    try {
      promise = Promise.resolve(entry.fn(entry.controller.signal));
    } catch (err) {
      promise = Promise.reject(err);
    }
    entry.finished = promise.then(entry.resolve, entry.reject).finally(() => {
      if (this.current === entry) {
        this.current = undefined;
      }
      this.pump();
    });
  }

  /** A stop is coming: the request in flight, unless a stop, is cut. */
  preempt() {
    if (this.current && this.current.priority !== PRIORITY.STOP) {
      this.current.controller.abort();
    }
  }

  /** Whether a request is in flight or waiting. */
  get busy() {
    return Boolean(this.current) || this.queue.length > 0;
  }

  /** Resolves once nothing is in flight any more (its socket closed). */
  async idle() {
    while (this.current) {
      await this.current.finished;
    }
  }

  /**
   * Drops every waiting request (rejected with `error`) and cuts the one in
   * flight, unless it is a stop (it ends by itself, within its deadline).
   */
  close(error) {
    this.closed = true;
    for (const entry of this.queue.splice(0)) {
      entry.reject(error);
    }
    this.preempt();
  }
}
