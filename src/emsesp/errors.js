// -----------------------------------------------------------------------------
// The errors of the transport and of EMS-ESP, as codes. A message never
// carries an address, the API key or an answer of the gateway.
// -----------------------------------------------------------------------------

export const CODES = {
  /** No connection, or the connection dropped. */
  UNREACHABLE: 'unreachable',
  /** No complete answer in time. */
  TIMEOUT: 'timeout',
  /** The answer was larger than allowed: dropped before the end. */
  TOO_LARGE: 'tooLarge',
  /** Cut on purpose (a stop takes the connection). */
  ABORTED: 'aborted',
  /** A command could not leave in time: nothing written. */
  LATE: 'late',
  /** An HTTP status other than 200. */
  HTTP: 'http',
  /** An answer that is not the JSON object expected (not EMS-ESP, cut short). */
  BAD_ANSWER: 'badAnswer',
  /** EMS-ESP refuses the reads (401/403 on /api/system): no API key, or a wrong one. */
  AUTH: 'auth',
};

export class EmsError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {{ sent?: boolean, status?: number }} [details]
   *   `sent`: the request was written (it may have reached the gateway)
   */
  constructor(code, { sent = false, status } = {}) {
    super(status === undefined ? code : `${code} ${status}`);
    this.name = 'EmsError';
    this.code = code;
    this.sent = sent;
    this.status = status;
  }
}

/** The reads are refused (only /api/system decides it: a 401 elsewhere is a value missing). */
export const isKeyRefused = (err) => err?.code === CODES.AUTH;

/** EMS-ESP refuses the request: no API key, a wrong one, or one without the right asked. */
export const isDenied = (err) =>
  err?.code === CODES.HTTP && (err.status === 401 || err.status === 403);

/** The gateway asks to slow down (429: another request under way) or fails (5xx). */
export const isBusy = (err) =>
  err?.code === CODES.HTTP && (err.status === 429 || (err.status >= 500 && err.status <= 599));

/**
 * An answer refusing the request (400 bad value, 404 unknown device or
 * entity, 401/403 not allowed...): a value missing for a read, a refusal
 * for a write; never a failure of the gateway.
 */
export const isMissing = (err) =>
  err?.code === CODES.HTTP && err.status >= 400 && err.status <= 499 && err.status !== 429;

/** A short reason for the logs and the texts (never a secret). */
export function reasonOf(err) {
  if (!(err instanceof EmsError)) {
    return 'error';
  }
  if (err.code === CODES.HTTP) {
    return `HTTP ${err.status}`;
  }
  return err.code;
}
