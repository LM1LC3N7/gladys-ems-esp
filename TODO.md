# TODO — EMS-ESP (gladys-ems-esp) v1

Handoff document: what is done, what was decided, what comes next. Keep it up
to date at the end of every milestone.

## Status

- [x] **Milestone 1 — read, bounded commands, protective stops**
      (2026-11-11): the REST API of EMS-ESP (optional API key, Bearer
      header), one request at a time; one device per installation (hashed
      identity of the heat source): outdoor and supply temperatures,
      pressure, the heating of the boiler on/off, per heating circuit its
      room temperature, setpoint and mode, per hot water its temperature,
      setpoint and on/off; switching on, modes and setpoints behind
      `allow_commands`; "off" protective with its guard in /data; a key
      refused on `/api/system` stops the reads, 429/5xx pause, getConfig()
      retried without end; /data bounded to 1.5 s; en/fr, docs, cover.
      Tested against a fake EMS-ESP (shapes of the 3.9 API) and servers on
      127.0.0.1, virtual and real clock (x20), Node 22 and 24.
- [x] **Review r1 fixes** (2026-11-11, review r1 of 8755495): B1 /data
      read again every 10 s while unreadable (one read at a time), the stops
      it keeps sent once it answers; I1 follow-up reads armed after a 200
      only (or once after a click left without an answer), 4xx counted in
      every phase, resends at the rhythm of the periodic reads, 429/5xx
      pauses growing 1, 2, 5, 10 min across reads and stops, no follow-up
      read during a pause, a refusal or the backoff; I2 writes read back
      every 600 ms until 4.3 s (the fake applies after 1 s by default), a
      stop judged contradicted only by a read begun 3 s after it left; I3
      queue of 16, a scene of 5 setpoints at 200 ms set and confirmed; I4
      the heating stop named "heating of the boiler, all circuits", its reach
      and the frost protection said, the error of an RC310 circuit points to
      it; I5 a test per surviving mutant of the review (`test/guards.test.js`);
      I6 the fake fails a test beyond 60 requests per virtual second, the
      clock rejects beyond 20 000 timers per advance, the logger is bounded;
      M1 read only mode = taken, never applied; M2 nothing armed nor sent
      after stop() (no save either); M3 `timeout-minutes` in CI; M4 Turkish
      upper case; M5 "On" sent without an answer no longer brings the stop
      back (refused or unsent: it does); M6 noted below.
- [x] **Review r2 fixes** (2026-11-11, review r2 of 3096120): I1 the test of
      a restart with another key used a random salt (its 8-bit prints
      collide once in 256): fixed salts, checked by a test, and a second test
      for a collision (the refusal holds, the button lifts it); suite run
      100 times under node:22-alpine, green; N1 a refusal of the key seen
      while /data was stuck is kept (and saved) once /data answers; N2 a 3xx
      to "On" counts as a refusal (the stop holds).
- [x] **Review r3 fixes** (2026-11-11): the HTTP tests wait for their
      condition with a bounded `until` (no fixed wait before a count), the
      refused port tried again on another port when taken meanwhile, the
      real clock test waits for the stuck read (bounded); suite 60 times
      under node:22-alpine, green.
- [ ] **Review r4**.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-ems-esp:0.1.0`):
  the first patch release gives 0.1.1. The User-Agent reads the version of
  `package.json`.
- **Lot 21, wave 3, rank 51** of the list of Pierre-Gilles. Neighbours:
  gladys-bosch-thermostat (KM gateways, local, its structure reused),
  guim31/gladys-bosch-homecom (cloud), William-De71/gladys-ebusd (eBUS, other
  bus, other brands): no overlap.
- **Reference**: EMS-ESP 3.9.0 (2026-11-08), GPL-3.0. Only its documented
  REST API is called (docs.emsesp.org); no code ported or copied. Facts of
  the API (fields of `/api/system` and of an entity, status codes of `/api`,
  the on/off words of its languages) checked against its sources and its
  own API tests; said in `THIRD_PARTY_NOTICES.md`.
- **REST, not MQTT** in v1: the REST API gives the bounds, the enum lists
  and the write right of each entity, needed for bounded commands and the
  confirmation by read back; MQTT would need a broker and the discovery of
  the topics. Listed in Next.
- **API key**: optional (EMS-ESP < 3.10 reads without one), printable ASCII
  without space, 8-1024 characters, sent only as `Authorization: Bearer`;
  not enumerable on the client. A 401/403 on `/api/system` is the refusal of
  the key (reads stopped, persisted, 8-bit salted print of address and key);
  a 401/403 on any other read is a value missing; on a write, a refusal of
  that command ("Read and Write" key needed), never a refusal of the key.
- **Identity**: `sha256("ems-esp:<type>:<productID>:<deviceID>")`, 16 hex
  digits, of the first boiler, else heat pump, else thermostat of the
  device list of `/api/system`. EMS-ESP gives no serial nor MAC in its API:
  two gateways on the same boiler model look the same (said in the docs).
  No device listed = unknown (values not shown, commands refused, a stop
  still sent); another key = another installation.
- **Not EMS-ESP** (no `system.version` in `/api/system`): a bad answer, a
  failed read, never a refusal.
- **Bus**: `busStatus` not starting with "connected" publishes no value
  (EMS-ESP keeps old values).
- **Values**: numbers only (never a text as 0, null or missing = unknown),
  plausible ranges; °F (settings.fahrenheit) converted exactly to °C;
  booleans in every format of EMS-ESP (true/false, 1/0, on/off in its 12
  languages); enums by their `index` and `enum` list.
- **Circuits**: `heating` (boiler `heatingactivated`), hc1-hc8 of the
  thermostat (4 kept), dhw/dhw2.. of the boiler as dhw1/dhw2 (2 kept). The
  mode of a heating circuit read as an entity (its enum list) at each poll.
  EMS-ESP 3.7+ only (hot water nested under `dhw`).
- **Modes**: a select of the enum texts EMS-ESP lists (its language), the
  off word of any language kept as `off`; written back as EMS-ESP lists it,
  "off" written as "off" (EMS-ESP takes English whatever its language).
  The options of a created select are kept. On/off of the heating and of
  the hot water: a select `on`/`off`, never a switch.
- **Stops** (`off` of heating, dhwN, an hc that lists it): one per circuit
  in /data. No option, no bounds, no read. Tried again 250 ms when it
  cannot connect, then kept `unsent` and sent first by every next read,
  without limit; only an answer counts: a 4xx answer counts as a refusal
  (3 at most, only while the reads go through), a 200 makes it `sent`, a
  429/5xx or no answer keep it as it was. Sent while the reads are refused:
  a 200 counts (EMS-ESP took it), a refusal is kept `unsent`, never counted,
  sent again first with another key or a button that gets through.
  `confirmed` when a read begun after it shows off; another state read:
  sent again, 3 answered resends at most. Guard lifted only by switching on
  / another mode from Gladys (saved first) or another state read twice once
  confirmed.
- **Commands**: one option for switching on, modes and setpoints. Batches
  gathered for 50 ms share one fresh read (`/api/system`, then the entity of
  each command); writes leave in order, then each entity is read back every
  600 ms until it shows (EMS-ESP applies a write 0.5-2 s after its 200).
  Sent by 3.5 s, confirmed by 4.3 s; 16 waiting at most. "On" or a mode
  sent without an answer (or a 5xx) replaces a stop of the circuit (it
  left); refused (4xx, 429) or unsent, the stop holds and is sent again.
- **Heating stop**: `heatingactivated` off is the summer mode of the boiler:
  every circuit stops and the frost protection of the thermostat may not
  heat; named so in the select and the docs. RC310/RC300 circuits list no
  off mode: no circuit stop for them (coordinator's decision, r1).
- **Bounds**: min/max of the entity (required), intersected with ours: room
  5-30 °C half degrees, hot water 20 °C to `max_dhw` (65 by default, 40-65,
  never above 65), checked again in `beforeSend`, final 65 °C guard. EMS-ESP
  gives 0-254 for the hot water setpoint (no own limit): ours apply, the
  boiler clamps, the read back tells. Setpoints refused in °F (v1).
- **Same structure as gladys-bosch-thermostat** (Gate, transport, publisher,
  store, app flow, test kit), its review r1 fixes included.
- **Manifest**: `categories: ["climate"]`, `transports: ["local"]`; no
  `keywords` nor `countries` (would be DE, NL, UK, BE and the EU).
- **Mutation checks**: `test/mutants.json` (101: ours, the 30 of review r1
  and those of the fixes of r1 and r2), run with `memcap npm run mutants`. Three
  survivors marked `equivalent`, kept as second guards: `startedAt >
stopSentAt` in `observe()` (a read begun before a stop left is already
  dropped by the write counter, the stop counting as a write); the stop
  check in the `beforeSend` of a setpoint (a stop can only appear after the
  check at the start of the batch through a click, which also moves the
  epoch `check()` refuses on); `stop.phase === 'sent'` before confirming a
  click (the only other phase it can have there is `confirmed`).

## To check on a real gateway

- EMS-ESP 3.10 (dev) skips a write of the same value within 60 s and answers
  200 (`write_protection`): the resends of a stop at 5 and 20 s may do
  nothing there; the periodic resends (an interval of 60 s or more) do.

- A POST on `/api/<device>/<tag>/<entity>` (`/api/boiler/dhw/activated`,
  `/api/thermostat/hc1/mode`): the docs show `/api/thermostat/hc2/seltemp`,
  the API tests `/api/boiler/dhw/chargetype` (GET). The body of a 200 to a
  POST (`{}` in the API tests), the status of a write in read only mode,
  the enum list of `hcN/mode` on RC310 and RC20.
- That `heatingactivated` off stops the heating with every thermostat.
- 3.10: the reads with a "Read" key, the writes with "Read and Write".

## Next

- MQTT (push) as an alternative to polling.
- The hot water mode of the thermostat (`thermostat/dhw/mode`), one-time
  charge (bounded in time), setpoints in °F with exact conversion.
- Energy counters (with the guard of gladys-p1-monitor), heat pump details.
