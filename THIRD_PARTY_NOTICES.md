# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).
Its only runtime dependency, `@gladysassistant/integration-sdk`, is under the
Apache License 2.0 as well.

## EMS-ESP

<https://github.com/emsesp/EMS-ESP32>: the firmware of the gateway this
integration talks to, under the GNU General Public License v3.0 (GPL-3.0;
version 3.9.0 of 2026-11-08 checked). No code of EMS-ESP is in this
repository: the integration only calls its REST API over the network, as
<https://docs.emsesp.org/> documents it (Commands page). Facts of that API
were checked against the project (the field names of `/api/system` and of
an entity, the status codes of `/api`, the words "on" and "off" in each of
its languages, so that an "off" mode is recognized); they are written here
from scratch, in JavaScript, and nothing of its text was copied.

The names Bosch, Buderus, Junkers, Nefit, Worcester and Sieger are those of
their owners; this integration is not affiliated with them nor with EMS-ESP.
