// -----------------------------------------------------------------------------
// The only network access of the integration: one HTTP request to EMS-ESP on
// node:http. A fresh connection per request (no keep-alive, no agent),
// `Connection: close`, a deadline for the whole exchange, a size cap checked
// on every chunk (and on Content-Length before the body), no redirect
// followed. Resolves { status, body } for any status; rejects an EmsError
// for the transport failures, with `sent` true as soon as the request was
// written (it may then have reached the gateway). The promise settles only
// once the socket is closed: the next request never opens a second
// connection while one is still open.
//
// `beforeSend`: called once the connection is up, right before the request
// is written; if it throws, nothing is sent and its error is passed on with
// `beforeSend` set. `signal`: aborts the exchange (a stop takes the
// connection). `sendWithin`: the connection must be up within this many ms,
// else nothing is written (a command never leaves late).
//
// Headers: our own User-Agent, `Accept: application/json`, the JSON content
// type of a write, and `Authorization: Bearer <API key>` when a key is
// configured (given by the client, never logged).
// -----------------------------------------------------------------------------

import http from 'node:http';
import { USER_AGENT } from '../constants.js';
import { CODES, EmsError } from './errors.js';

/**
 * @param {object} o
 * @param {string} o.host
 * @param {number} o.port
 * @param {string} o.path
 * @param {'GET'|'POST'} [o.method]
 * @param {string} [o.body] the JSON body of a POST
 * @param {string} [o.authorization] the Authorization header, if any
 * @param {number} o.timeout ms for the whole exchange
 * @param {number} o.maxBytes
 * @param {number} [o.sendWithin]
 * @param {() => void} [o.beforeSend]
 * @param {AbortSignal} [o.signal]
 * @param {{ setTimeout: Function, clearTimeout: Function }} [o.timers]
 * @param {typeof http.request} [o.request] node:http's (tests: a connection that never comes up)
 */
export function httpRequest({
  host,
  port,
  path,
  method = 'GET',
  body,
  authorization,
  timeout,
  maxBytes,
  sendWithin,
  beforeSend,
  signal,
  timers = globalThis,
  request = http.request,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let written = false;
    let req = null;
    let socket = null;
    const handles = [];

    const settle = (error, value) => {
      for (const h of handles) {
        timers.clearTimeout(h);
      }
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      // The socket closed before anything else happens.
      if (socket && !socket.destroyed) {
        socket.once('close', () => settle(error, value));
        socket.destroy();
        return;
      }
      if (socket && !socket.closed && socket.destroyed) {
        socket.once('close', () => settle(error, value));
        return;
      }
      req?.destroy();
      settle(error, value);
    };
    const onAbort = () => finish(new EmsError(CODES.ABORTED, { sent: written }));
    if (signal?.aborted) {
      reject(new EmsError(CODES.ABORTED));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    handles.push(
      timers.setTimeout(
        () => finish(new EmsError(CODES.TIMEOUT, { sent: written })),
        Math.max(1, timeout),
      ),
    );
    if (sendWithin !== undefined) {
      handles.push(
        timers.setTimeout(
          () => {
            if (!written) {
              finish(new EmsError(CODES.LATE));
            }
          },
          Math.max(0, sendWithin),
        ),
      );
    }

    const send = () => {
      if (written || settled) {
        return;
      }
      // The very last check of a command, once the connection is up and
      // right before the first byte is written.
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
      req.end(body);
    };

    try {
      req = request({
        host,
        port,
        path,
        method,
        agent: false,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/json',
          connection: 'close',
          ...(authorization ? { authorization } : {}),
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
        },
      });
      req.on('socket', (s) => {
        socket = s;
        s.on('error', () => {});
        if (s.connecting) {
          s.once('connect', send);
        } else {
          send();
        }
      });
      req.on('response', (res) => {
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          finish(new EmsError(CODES.TOO_LARGE, { sent: true }));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new EmsError(CODES.TOO_LARGE, { sent: true }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(null, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', () => finish(new EmsError(CODES.UNREACHABLE, { sent: true })));
      });
      req.on('error', () => finish(new EmsError(CODES.UNREACHABLE, { sent: written })));
    } catch {
      // A header Node refuses: a failure, never a crash.
      finish(new EmsError(CODES.UNREACHABLE));
    }
  });
}
