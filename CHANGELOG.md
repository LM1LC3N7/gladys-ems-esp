# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-11

### Added

- First version: Bosch-group boilers and heat pumps (Bosch, Buderus, Junkers,
  Nefit, Worcester...) through a local EMS-ESP gateway, by its REST API with
  an optional API key: outdoor and supply temperatures, system pressure, the
  heating of the boiler on/off, per heating circuit its room temperature,
  setpoint and mode, per hot water its temperature, setpoint and on/off; one
  Gladys device per installation.
- Switching on, the modes and the room and hot water setpoints behind one
  option, off by default, within the bounds EMS-ESP gives; room 5 to 30 °C;
  hot water 65 °C at most (ceiling 40 to 65 °C, 65 °C by default).
- "Off" needs no option and is held by nothing but a missing configuration,
  a circuit listing no off mode or another installation at the address;
  kept in `/data` and sent again by the reads until EMS-ESP answers it.
- A key refused on `/api/system` stops the reads (no automatic retry); HTTP
  429/5xx pause them; the EMS bus disconnected publishes nothing; °F
  converted. "Test the connection" button. English and French.

[Unreleased]: https://github.com/LM1LC3N7/gladys-ems-esp/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-ems-esp/releases/tag/v0.1.1
