# gladys-ems-esp

A [Gladys Assistant](https://gladysassistant.com) external integration for
**Bosch-group boilers and heat pumps (Bosch, Buderus, Junkers, Nefit,
Worcester...) through a local [EMS-ESP](https://github.com/emsesp/EMS-ESP32)
gateway**, an ESP32 board reading their EMS bus. It calls the REST API of
EMS-ESP ([docs.emsesp.org](https://docs.emsesp.org/)) on your local network,
with an optional API key. Local only, no cloud. Unofficial, not affiliated
with EMS-ESP, Bosch or Buderus.

**Never tested with a real gateway**: checked against a fake server giving
the answers of EMS-ESP 3.9. A Buderus KM50/KM100/KM200 gateway without
EMS-ESP? See [gladys-bosch-thermostat](https://github.com/LM1LC3N7/gladys-bosch-thermostat).

User guides: [English](docs/en.md), [français](docs/fr.md).

## How it works

- One Gladys device per installation (`ext:<selector>:ems-esp:<key>`, the
  key a hash of the type, product id and bus address of the heat source as
  `/api/system` lists them), read every 60 s by default, one request at a
  time: `/api/system` (identity, version, settings, bus), the short values
  of `/api/boiler` and `/api/thermostat`, the mode entity of each heating
  circuit. Outdoor and supply temperatures, system pressure, the heating of
  the boiler on/off, per heating circuit (hc1-hc4) its room temperature,
  setpoint and mode, per hot water (dhw, dhw2) its temperature, setpoint and
  on/off.
- **Switching on, modes and setpoints behind one option, off by default**:
  room setpoints in half degrees, 5 to 30 °C; hot water in whole degrees,
  20 °C to a ceiling of 65 °C by default, 65 °C at most; always within the
  bounds EMS-ESP gives for the entity. Decided on a fresh read of the
  entity, checked again right before the request leaves, refused unsent
  after 3.5 s, successful only when a read shows the value. Setpoints are not
  written when EMS-ESP is set to °F.
- **"Off" is the protective command** (the heating of the boiler, a hot
  water, a heating circuit whose thermostat lists an off mode): no option;
  it cuts a read under way and leaves first, cancels the commands not sent
  yet, goes through a pause or a refused key (one try); kept in `/data` and
  sent again by the reads until EMS-ESP answers it (only answers count: 3
  4xx refusals at most, 3 answered resends when a read contradicts it). Its
  guard is lifted only by switching on or another mode chosen from Gladys,
  or another state read twice after the stop was seen applied. Its three
  refusal cases are listed in the guides.
- **No switch, no writable binary**: a "turn everything off" never reaches
  the boiler (on/off and modes are selects).
- **A key refused on `/api/system`** (401/403, from EMS-ESP 3.10): the reads
  stop, kept in `/data`, never an automatic retry; a 401 elsewhere is a value
  missing or a refused command. 429/5xx: a bounded pause kept in `/data`.
  Nothing secret in logs, statuses or `/data`; `/data` never waited on for
  more than 1.5 s.

## Credits

EMS-ESP (GPL-3.0) is only called through its documented API: none of its
code is here. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Built on
the structure of the sibling integration
[gladys-bosch-thermostat](https://github.com/LM1LC3N7/gladys-bosch-thermostat).

## Development

```bash
npm install
npm test                                        # node --test, loopback only
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run cover                                   # cover.png, plain Node
memcap npm run mutants                          # test/mutants.json, one at a time
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never leave the machine: EMS-ESP is a fake behind the injected
transport (`test/fixtures/emsesp.js`) or a server on 127.0.0.1 (`test/kit`,
copied from the shared test kit), Gladys is the SDK's fake.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags,
builds the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). Notices in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also shipped in the Docker
image).
