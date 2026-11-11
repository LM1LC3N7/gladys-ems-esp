# EMS-ESP (Bosch, Buderus, Junkers, Nefit)

This integration shows in Gladys a boiler or heat pump of the Bosch group
(**Bosch, Buderus, Junkers, Nefit, Worcester, Sieger**...) read on its EMS bus
by an **EMS-ESP** gateway: an ESP32 board (BBQKees or home-made) with the
free EMS-ESP firmware, on your local network, without any cloud.

**Never tested with a real gateway**: the integration calls the REST API that
EMS-ESP documents ([docs.emsesp.org](https://docs.emsesp.org/), "Commands"
page) and was checked against a fake server giving the answers of version
3.9. Not affiliated with EMS-ESP, Bosch or Buderus. Feedback is welcome.

You have a Buderus **KM50, KM100 or KM200** network gateway and no EMS-ESP?
The [gladys-bosch-thermostat](https://github.com/LM1LC3N7/gladys-bosch-thermostat)
integration reads it.

## What you get

One Gladys device per installation, read every 60 s by default:

- outdoor and supply temperatures, system pressure (read on the boiler);
- **heating (boiler)**: the heating of the boiler on/off
  (`heatingactivated`, the "summer mode" of the boiler);
- for each **heating circuit** of the thermostat (hc1 to hc4): room
  temperature, room setpoint, mode (manual, auto, day, night, frost
  protection... depending on the thermostat, with "Off" when it lists one);
- for each **hot water** (dhw, dhw2): water temperature, setpoint, on/off
  (`activated`);
- the link status ("OK", "Gateway unreachable", a stop from Gladys under
  way...).

A feature appears once EMS-ESP gives its value and never disappears
afterwards. The modes offered are those the thermostat lists when the device
is added, in the language set in EMS-ESP (an "Off" mode is recognized in all
of its languages).

The identity of the device is a print of the type, product id and bus
address of the boiler (else the heat pump, else the thermostat) as EMS-ESP
lists them: its API gives no serial number nor MAC address. Two gateways on
the same boiler model cannot be told apart; another boiler at the address is
seen at once.

## Configuration

1. Find the address of EMS-ESP on your network (in your router, or in
   EMS-ESP, Network), e.g. `192.168.1.50`. Make it fixed (DHCP reservation):
   a `.local` name may not resolve from the container.
2. In EMS-ESP, **Settings, Security, API keys**, create a key: "Read and
   Write" to send commands (stops included), "Read" to read only. From
   **EMS-ESP 3.10** every read needs a key; before, reads need none (a key is
   still needed for the commands). On versions without API keys, use the
   access token of the admin user.
3. In Gladys, open the configuration of the integration, enter the address
   (with `:port` if not 80) and the key.
4. Save, then add the device from the **Discovery** tab.

The key is kept by Gladys in its database, never shown again, sent only to
your EMS-ESP gateway, in the `Authorization` header of each request (plain
http on your local network, as EMS-ESP answers). The integration sends its
own `User-Agent: gladys-ems-esp/<version>` header.

The **Test the connection** button reads EMS-ESP once, but not sooner than
the refresh interval after the previous read.

## The commands

By default Gladys only reads. The option **Allow switching on, the modes and
the setpoints** (off by default) lets the dashboard, the scenes and the
voice assistants:

- switch the heating of the boiler or a hot water back **on**;
- change the **mode** of a heating circuit, among those the thermostat
  lists;
- change the **room setpoint** of a heating circuit, by half degrees,
  between 5 and 30 °C and within the bounds EMS-ESP gives for it;
- change the **hot water setpoint**, in whole degrees, within the bounds of
  EMS-ESP, between 20 °C and the configured ceiling: **65 °C by default, 40
  to 65 °C, 65 °C at most** whatever is typed or EMS-ESP allows (scalding
  risk).

They are neither switches nor binaries: a "turn everything off" of a scene or
a voice assistant does not reach the boiler.

Each command first reads EMS-ESP again (its identity, then the entity it
writes with its bounds, its modes and whether it takes a write) and decides
on that read, not on the values kept in memory; commands arriving together
(a scene) share that read, leave one by one, then each is read back. A
command leaves by 3.5 s after the click, otherwise it is refused and nothing
is sent. It is reported successful only when a read made after it, before
4.3 s, shows the value asked; otherwise Gladys shows "sent and accepted, not
applied yet" (or "sent, without confirmation" when EMS-ESP did not answer),
and the follow-up reads, 5 s and 20 s later, publish the value as soon as it
shows. Beyond 4 commands waiting, they are refused. An HTTP 4xx refusal of a
command concerns it only: the reads go on. A 401/403 means the key has no
right to write: the error says so.

When EMS-ESP is set to **°F**, the temperatures are converted to °C for
Gladys and the setpoints are not written in this version (nothing is sent);
on, off and modes still are.

A setpoint is refused while a stop of its circuit sent from Gladys holds (see
below): switch the circuit back on (or choose another mode) first. When /data
cannot be read, switching on, modes and setpoints are refused (a stop kept
there would be unknown).

## The stop

Choosing **"Off"** for the heating of the boiler, for a hot water, or for a
heating circuit whose thermostat lists an off mode (RC20, RC30, BC400, CR11,
SRC thermostats...) needs no option. The integration writes `off`, which
EMS-ESP understands in all of its languages.

**A circuit whose thermostat lists no off mode** (RC310, RC300, RC35...:
manual and auto, day and night) cannot be stopped from its mode select: stop
the heating of the boiler ("Heating (boiler) on/off"), with no option either.

The stop leaves without waiting for a read, ahead of any other request: a
read under way is cut, the commands not sent yet are cancelled (nothing asked
before the stop leaves after it). Neither the option, nor the bounds, nor a
pause asked by EMS-ESP (HTTP 429/5xx), nor a key refused before (one try),
nor /data unreadable or stuck, nor a device not read yet hold it.

The integration refuses it in these three cases only:

- the configuration of the integration is not valid, or could not be read
  yet since the integration started;
- the circuit does not list "Off" (in the select created, or in the last
  read);
- the last read showed **another** installation at this address.

EMS-ESP itself refuses it without a key that has the "Read and Write" right
(HTTP 401/403; the error says so) or in read only mode (the link status says
so).

Only an answer of EMS-ESP counts as a try. When it cannot leave (gateway
unreachable, cut), it is tried again for 250 ms, then kept in /data and sent
again first by each next read, without limit, until EMS-ESP answers it: it
leaves at the first read that reaches it, and at a restart of the
integration or a change of configuration. Sent without an answer (timeout,
cut) or refused with HTTP 429/5xx, it is sent again the same way, without
being counted. It is not sent to another installation read at the address.
When EMS-ESP refuses it with HTTP 4xx while the reads go through, it is sent
again twice at most, then the status says so. Clicked while EMS-ESP refuses
the reads with the key, it is sent once: accepted, it counts; refused, it is
kept and sent again first once another key is saved or the button gets
through.

It is reported successful when a read made after it shows the circuit off.
Once seen applied, nothing is sent again. If a read made after it still
shows another state, it is sent again, 3 times at most (only the sends that
got an answer count), then the status says so.

The stop from Gladys is kept in /data, with no time limit. It is lifted only
by switching on or another mode chosen from Gladys (with the option; the
lifting is written to /data before the command leaves), or when, once the
stop was seen applied, another state is read twice in a row (changed on the
thermostat, the boiler or in EMS-ESP).

## Status and errors

- **EMS-ESP refuses the reads with this key** (HTTP 401/403 on
  `/api/system`, from 3.10): the reads stop, with no automatic retry; save
  another key or use "Test the connection". A 401/403 on another address of
  the API is no refusal of the key: that value is left out.
- **EMS-ESP asks to slow down** (HTTP 429: another request under way, from
  Home Assistant for instance; or 5xx): a pause of 1 min to 6 h, kept in
  /data, for everything but the stop.
- **Gateway unreachable**: tried again after 1, 2, 5 then 10 min, not sooner
  than the interval; the link status says so, and values older than two
  intervals are not published again.
- **EMS bus not connected** (EMS-ESP says so): no value is published, they
  could be old.
- **Value missing** (HTTP 404 of an entity or a device EMS-ESP does not
  have, an empty or null value): left out, the others are read; an unknown
  value is not published as 0.
- **Another installation answers at the address**: its values do not go to
  the device created; it shows as a new device in Discovery.
- **EMS-ESP in read only mode**: the link status says so; EMS-ESP then
  refuses every command, stops included.

## What /data keeps

`ems-esp-state.json`: a pause under way, a refusal of the key (with 8 bits
of a salted print, enough to know whether it changed, not enough to find
it), the time of the last read (a restart does not read sooner than the
interval), the stops sent from Gladys. No secret. A read or a write of /data
is not waited for more than 1.5 s: a stuck volume counts as unreadable and
does not hold a stop.

## Known limits

- REST API only (no MQTT in this version); EMS-ESP 3.7 or newer (hot water
  under `dhw`).
- A few requests per read (system, boiler, thermostat, then the mode of
  each heating circuit). EMS-ESP serves one request at a time: another
  application reading it at the same moment may cause a 429 and a pause of
  one minute.
- Setpoints not written when EMS-ESP is set to °F.
- Schedules, the hot water mode of the thermostat, one-time charge, energy,
  solar, mixers, heat pump details, sensors added to EMS-ESP: not in this
  version.

## Credits

The integration calls the API of [EMS-ESP](https://github.com/emsesp/EMS-ESP32)
(firmware under the GPL-3.0 license) as
[docs.emsesp.org](https://docs.emsesp.org/) documents it; no code of EMS-ESP
is reused. See THIRD_PARTY_NOTICES.md.
