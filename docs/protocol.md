# Maschine MK3 USB protocol

Everything mk3d knows about talking to the MK3. Each fact carries a status:

- **verified**: observed on our own unit (serial redacted, firmware 1.4.5) with the tool named.
- **descriptor**: read from the device's own HID report descriptor (exact sizes, no meaning).
- **reference**: taken from a reference implementation, not yet confirmed on hardware.
- **NI agent**: read from NI's own driver code (decompiled), not yet confirmed on hardware.
- **unknown**: present on the device, meaning not known. Map it with a diagnostic tool before using it.

Byte offsets in HID reports count the report-ID byte as offset 0, which is how `node-hid`
delivers reports on macOS.

## Sources

| Source                                                                                               | License                         | Used for                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| `reference/ni-controllers-lib` (asutherland), `lib/maschine_mk3_config.json` and `lib/components/**` | ISC                             | Button bits, knob/strip offsets, LED addresses, LED palette, display format                |
| `reference/cabl` (shaduzlabs)                                                                        | MIT                             | Origin of the LED palette. No MK3 support in any branch                                    |
| `reference/rebellion` (terminar)                                                                     | LGPL-3.0                        | Not a USB driver: it talks to NI's agents over their private IPC (see "Alternative" below) |
| `ioreg` `ReportDescriptor` of the MK3 HID interface                                                  | n/a                             | Report IDs and sizes (decoded 2026-10-15)                                                  |
| NI's `NIHostIntegrationAgent` (arm64), read with REA + Ghidra, 2026-10-17                            | n/a (read only, nothing copied) | Pad event types, report handlers, settings reports. Status **NI agent** below              |
| `npm run enumerate`                                                                                  | n/a                             | IDs, interfaces, endpoints, firmware                                                       |

## Device

| Property             | Value                         | Status              |
| -------------------- | ----------------------------- | ------------------- |
| Vendor ID            | `0x17CC` (Native Instruments) | verified, enumerate |
| Product ID           | `0x1600`                      | verified, enumerate |
| Firmware (bcdDevice) | `0x0145` = 1.4.5              | verified, enumerate |
| Speed                | USB 2.0 high speed            | verified, enumerate |
| Configurations       | 1                             | verified, enumerate |

### Interfaces

| #   | Class                             | Name              | Endpoints                                               | Use                                             |
| --- | --------------------------------- | ----------------- | ------------------------------------------------------- | ----------------------------------------------- |
| 0   | audio control                     | Maschine MK3      | –                                                       | Built-in audio interface. Not ours              |
| 1   | audio streaming                   | Maschine MK3      | `0x01` OUT iso (alt 1)                                  | Audio out. Not ours                             |
| 2   | audio streaming                   | Maschine MK3      | `0x81` IN iso (alt 1)                                   | Audio in. Not ours                              |
| 3   | audio / MIDI streaming            | Maschine MK3 MIDI | `0x82` IN bulk, `0x02` OUT bulk                         | Class-compliant MIDI port (MIDI mode). Not used |
| 4   | HID                               | Maschine MK3 HID  | `0x83` IN interrupt (64 B), `0x03` OUT interrupt (64 B) | Buttons, pads, knobs, LEDs                      |
| 5   | vendor-specific (subclass `0xBD`) | Maschine MK3 BD   | `0x04` OUT bulk (512 B)                                 | Displays                                        |
| 6   | application-specific (DFU)        | Maschine MK3 DFU  | –                                                       | **Firmware update. Never touch**                |

All verified with `npm run enumerate`.

On macOS the HID interface is owned by IOHIDFamily, so it is read through hidapi (`node-hid`).
hidapi reports usage page `0xFF01` (vendor-defined). The input interval is 125 µs
(`ReportInterval = 125` in the I/O registry).

## HID reports (interface 4)

Sizes from the report descriptor (816 bytes). Total size = payload + 1 report-ID byte.

| Direction | ID                                                    | Total size | Meaning                                                                  | Status                                                                        |
| --------- | ----------------------------------------------------- | ---------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| in        | `0x01`                                                | 42         | Buttons, encoders, knobs, touch strip, volume knobs                      | verified (Checkpoint 1)                                                       |
| in        | `0x02`                                                | 64         | Pad events: on (with hit strength), off, pressure                        | verified (Checkpoint 1) + NI agent                                            |
| in        | `0x20`                                                | 33         | 16 × 16-bit values                                                       | **unknown**: never sent in Checkpoint 1, and NI's agent has no handler for it |
| in        | `0x40`                                                | 31         | 15 × 16-bit values                                                       | **unknown**: never sent in Checkpoint 1, and NI's agent has no handler for it |
| out       | `0x80`                                                | 63         | Button LEDs and some indexed-color LEDs                                  | descriptor + reference                                                        |
| out       | `0x81`                                                | 42         | Touch-strip LEDs and pad LEDs                                            | descriptor + reference                                                        |
| out       | `0xF3`                                                | 2          | LED brightness (see "Settings reports")                                  | NI agent, **not sent**                                                        |
| out       | `0xF4`                                                | 33         | Device settings: pad sensitivity, pedal, "HPM " (see "Settings reports") | NI agent, **not sent**                                                        |
| feature   | `0xD0`, `0xD8`–`0xDB`, `0xF0`, `0xF2`, `0xF8`, `0xF9` | 7–33       | Probably calibration/settings                                            | **unknown, do not send**                                                      |
| feature   | `0xFE`, `0xFF`                                        | 210        | Large blocks, possibly firmware/flash related                            | **unknown, never send**                                                       |

Only `0x80` and `0x81` may be written. Reading feature reports could still be harmless, but
skip it unless a phase needs it.

### Input report `0x01`: controls

Descriptor layout: 80 × 1-bit (bytes 1–10), 2 × 4-bit (byte 11), 8 × 16-bit (bytes 12–27),
3 × 16-bit (bytes 28–33), 1 × 16-bit (bytes 34–35), 3 × 16-bit (bytes 36–41). Multi-byte values
are little-endian.

**Buttons** (bit set = pressed). Names follow ni-controllers-lib; mk3d's names are in
`src/hw/ids.ts`. Status: every named button, the 4D push/tilt/touch and all 8 knob touches
verified at Checkpoint 1. Jacks not tested.

| Byte | `0x01`              | `0x02`            | `0x04`          | `0x08`     | `0x10`        | `0x20`     | `0x40`     | `0x80`     |
| ---- | ------------------- | ----------------- | --------------- | ---------- | ------------- | ---------- | ---------- | ---------- |
| 1    | navPush             | pedalConnected    | navUp           | navRight   | navDown       | navLeft    | shift      | d8         |
| 2    | g1 (A)              | g2 (B)            | g3 (C)          | g4 (D)     | g5 (E)        | g6 (F)     | g7 (G)     | g8 (H)     |
| 3    | notes               | volume            | swing           | tempo      | noteRepeatArp | lock       | ?          | ?          |
| 4    | padMode             | keyboard          | chords          | step       | fixedVel      | scene      | pattern    | events     |
| 5    | microphoneConnected | variationNavigate | duplicateDouble | select     | solo          | muteChoke  | pitch      | mod        |
| 6    | performFxSelect     | restartLoop       | eraseReplace    | tapMetro   | followGrid    | play       | recCountIn | stop       |
| 7    | macroSet            | settings          | arrowRight      | sampling   | mixer         | plugin     | ?          | ?          |
| 8    | channelMidi         | arranger          | browserPlugin   | arrowLeft  | fileSave      | auto       | ?          | ?          |
| 9    | d1                  | d2                | d3              | d4         | d5            | d6         | d7         | navTouch   |
| 10   | knobTouch8          | knobTouch7        | knobTouch6      | knobTouch5 | knobTouch4    | knobTouch3 | knobTouch2 | knobTouch1 |

`d1`–`d8` are the display buttons above the screens. `pedalConnected` and
`microphoneConnected` are jack-detect states, not buttons. The six unnamed bits (`?`) never
changed while every control was pressed at Checkpoint 1; they are probably unused.

**Byte 11**: low nibble = 4D encoder rotation, a counter that wraps 0–15, one count per detent
(step = difference, with wrap). Verified over several full turns both ways. High nibble never
changed: **unknown**, probably unused.

**Bytes 12–27**: knobs 1–8, 16-bit little-endian each (knob 1 = bytes 12–13). Endless encoders
counting **0–999** and wrapping (verified: a clockwise turn went 992 → 12). Use deltas with wrap
at 1000. A brisk turn moves 20–45 counts per report.

**Bytes 28–33**: touch strip. 28–29 a counter or timestamp, 30–31 position, 32–33 a second
value. Verified: position runs 0–1024 left to right (1024 at the far right), 0 = no finger, and
a report arrives every ~11 ms while sliding. The second value stayed 0 with one finger
(two fingers not tested). Bytes 28–29: meaning **unknown**.

**Bytes 34–35**: one 16-bit value. Never changed at Checkpoint 1 (no pedal plugged in). NI's
agent routes it to its pedal handler: probably the pedal position. Status: NI agent.

**Bytes 36–41**: mic input gain (36–37), headphone volume (38–39), master volume (40–41),
16-bit little-endian. Status: reference; NI's agent also routes them to potentiometer handlers.

### Input report `0x02`: pads

Up to 21 three-byte entries starting at byte 1: `[pad index 0–15] [hi nibble: event type, lo
nibble: value bits 11–8] [value bits 7–0]`. Values are 12-bit (0–4095). Pad indices are in device
order: 0 is the top-left pad, rows go down (verified on hardware 2026-10-19). mk3d converts them
with `panelPad` to Maschine numbering (pad 0 = bottom-left, rows go up).

**Event types** (NI agent: `NI::NHL2::PadHandler::process`; verified against
`test/fixtures/checkpoint1.jsonl`, where the nibbles counted 0: 2, 1: 14, 2: 2, 3: 14, 4: 117
for 16 hits):

| Nibble | Event                             | Value                                |
| ------ | --------------------------------- | ------------------------------------ |
| 0, 1   | **on**: the device detected a hit | hit strength, computed by the device |
| 2, 3   | **off**: the pad was released     | 0                                    |
| 4      | pressure while held (aftertouch)  | current pressure                     |
| other  | ignored by NI                     |                                      |

- The device detects hits and measures their strength itself. The host does not need its own
  threshold or onset window; NI's driver just reads the on value. Pressure entries also arrive
  just before an on and after an off; only held pads get aftertouch.
- The list ends at the first all-zero entry `[0, 0, 0]`. Bytes after it are stale and must be
  ignored: the device does not clear its buffer. `[0, 0, v]` with `v ≠ 0` is an on for pad 0.
- Held pads are re-reported every ~25 ms (40 Hz) while their pressure changes (verified).
- How hard a hit must be for a given on value depends on the device's pad sensitivity setting
  (`0xF4` below). mk3d never sets it, so the device keeps whatever value it had.
- Corrected 2026-10-17: earlier notes here treated every entry as a pressure sample and took
  velocity from the first one. That ignored the event type and made hits feel too soft.
  ni-controllers-lib's fixed threshold of 256 is not how NI does it.

There is no faster pad stream: NI's agent reads pads from this report only.

### Settings reports `0xF3`/`0xF4` (NI agent, **not sent**)

What NI's agent sends to configure the device. mk3d sends none of these; PLAN.md §6 forbids
output reports other than `0x80`/`0x81` until a phase needs one and the owner approves.

| Report                   | Setting (NI property)                    | NI default |
| ------------------------ | ---------------------------------------- | ---------- |
| `F4 22 FF 05 01 <0–100>` | Pad sensitivity (`PadS`)                 | 75         |
| `F4 22 00 03 <flags>`    | Pedal (`Pdl`)                            | 3          |
| `F4 23 4D 01 <0/1>`      | `HPM ` (probably a headphone/audio mode) | 1          |
| `F3 <0–100>`             | LED brightness (`LED1`)                  | ?          |

Index 0–15 came out in sequence when the pads were hit in device order, top-left first (verified,
Checkpoint 1; panel order verified on hardware 2026-10-19: index 0 lit the top-left pad).

### Output report `0x80`: button LEDs (63 bytes)

Byte 0 = `0x80`. Plain LEDs show three states, not a gradient (verified with `ledtest ladder`,
Checkpoint 2). Observed, comparing values side by side:

| Look   | Values tried                            |
| ------ | --------------------------------------- |
| off    | 0, 1                                    |
| dim    | 8, 16, 24, 32, 48, 64, 80, 96, 112, 128 |
| bright | 31, 63, 127, 255                        |

Every bright value has its low five bits set, but the exact encoding is **unknown** (1 is off,
32 is dim). mk3d uses 0 = off, 16 = dim, 63 = bright. Indexed LEDs take a palette index (see
below). Addresses verified with `ledtest walk` (Checkpoint 2). ni-controllers-lib had bytes 4 and 5 wrong: 4 is **Mixer**,
5 is **Browser**, matching the panel order Channel, Plug-in, Arranger, Mixer, Browser, Sampling.

| Byte  | LED                 | Byte  | LED                 | Byte  | LED                                       |
| ----- | ------------------- | ----- | ------------------- | ----- | ----------------------------------------- |
| 1     | channelMidi         | 21    | volume              | 41    | followGrid                                |
| 2     | plugin (instance)   | 22    | swing               | 42    | play (green)                              |
| 3     | arranger            | 23    | noteRepeatArp       | 43    | recCountIn (red)                          |
| 4     | mixer               | 24    | tempo               | 44    | stop                                      |
| 5     | browser (+ plug-in) | 25    | lock                | 45    | shift                                     |
| 6     | sampling, indexed   | 26    | pitch               | 46    | fixedVel                                  |
| 7     | arrowLeft           | 27    | mod                 | 47    | padMode                                   |
| 8     | arrowRight          | 28    | performFxSelect     | 48    | keyboard                                  |
| 9     | fileSave            | 29    | notes               | 49    | chords                                    |
| 10    | settings            | 30–37 | groups A–H, indexed | 50    | step                                      |
| 11    | auto                | 38    | restartLoop         | 51    | scene                                     |
| 12    | macroSet            | 39    | eraseReplace        | 52    | pattern                                   |
| 13–20 | d1–d8               | 40    | tapMetro            | 53    | events                                    |
|       |                     |       |                     | 54    | variationNavigate                         |
|       |                     |       |                     | 55    | duplicateDouble                           |
|       |                     |       |                     | 56    | select                                    |
|       |                     |       |                     | 57    | solo                                      |
|       |                     |       |                     | 58    | muteChoke                                 |
|       |                     |       |                     | 59–62 | 4D encoder up, left, right, down, indexed |

### Output report `0x81`: strip and pad LEDs (42 bytes)

Byte 0 = `0x81`. Bytes 1–25: touch-strip LEDs, left to right. Bytes 26–41: the 16 pads in device
order, top-left first, matching the input pad indices 0–15 (verified on hardware 2026-10-19).
mk3d converts to and from its own numbering with `panelPad`. All take a palette index. Status: verified with
`ledtest walk` and `ledtest rainbow` (Checkpoint 2).

### LED palette

Indexed LEDs do not take free RGB. The value is a palette index:

| Index       | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| 0           | off                                                                           |
| 1–3         | unused (black)                                                                |
| 4 + 4·c + v | color `c` (0–15) at variant `v`: 0 dim, 1 dim flash, 2 bright, 3 bright flash |
| 68–71       | white, four brightness steps                                                  |

Colors `c`: 0 red, 1 orange, 2 light orange, 3 warm yellow, 4 yellow, 5 lime, 6 green, 7 mint,
8 cyan, 9 turquoise, 10 blue, 11 plum, 12 violet, 13 purple, 14 magenta, 15 fuchsia.

An approximate RGB value for each of the 72 indices is in
`reference/ni-controllers-lib/lib/maschine_mk3_config.json` (`indexed_led_mapping`, MIT, from
cabl). Map FL colors to the nearest entry by squared RGB distance. The touch-strip and 4D
encoder dot LEDs reportedly cannot show white. Status: reference.

## Displays (interface 5, endpoint `0x04` bulk OUT)

Two 480 × 272 screens. Claim interface 5, then write one bulk transfer per update. Status:
reference (ni-controllers-lib `ni_lcd_displays.ts`); interface and endpoint are verified.

Transfer layout (all multi-byte fields **big-endian**):

| Offset | Size       | Content                                                       |
| ------ | ---------- | ------------------------------------------------------------- |
| 0      | 1          | `0x84`                                                        |
| 1      | 1          | `0x00`                                                        |
| 2      | 1          | display index (0 = left, 1 = right)                           |
| 3      | 1          | `0x60`                                                        |
| 4      | 4          | `0x00`                                                        |
| 8      | 2          | x                                                             |
| 10     | 2          | y                                                             |
| 12     | 2          | width                                                         |
| 14     | 2          | height                                                        |
| 16     | 4          | command `0x00` + 24-bit count of pixel **pairs** (pixels ÷ 2) |
| 20     | 2 × pixels | pixels, RGB565, big-endian (`RRRRRGGG GGGBBBBB`)              |
| …      | 4          | `0x03 0x00 0x00 0x00` (blit)                                  |
| …      | 4          | `0x40 0x00 0x00 0x00` (end)                                   |

A full frame is 16 + 4 + 261 120 + 8 = 261 148 bytes. ni-controllers-lib only sends full frames
(x = y = 0). The meaning of `0x60` is **unknown**.

On macOS, interface 5 can be claimed while the HID interface is in use (verified).

Verified at Checkpoint 3 (`displaytest`): big-endian RGB565 gives the right colors, screen 0 is
the left screen, there is no offset or cropping (a 1-pixel border shows on all edges), and
partial updates via x/y/width/height work: only the given rectangle changes.

**A transfer cut off midway breaks the screens** (verified, Checkpoint 3): when a process was
killed while sending, both screens stayed blank (backlight on) and every later frame was lost,
presumably because the controller was still waiting for the rest of the cut-off frame. Only a
power cycle recovered it. mk3d must never abandon a transfer: `Mk3Display` runs transfers one
at a time and `close()` waits for the one in flight.

**Throughput** (verified, `displaytest anim` and a timing probe, 2026-10-15): a full-screen
transfer takes ~34 ms whether the two screens are sent in turn or in parallel, so the device
takes ~7.7 MB/s. That caps full redraws at ~29 screens/s: ~29 fps for one screen, ~15 fps for
both. Our rendering and RGB565 conversion take ~1.3 ms for both screens. Small partial updates
run at 150+ fps. mk3d therefore sends only the changed bounding box.

## macOS notes

- NI's `NIHostIntegrationAgent` runs as a login-item app (launchd label
  `application.com.native-instruments.NIHostIntegrationAgent.*`), not from a LaunchAgent plist.
  `NIHardwareAgent` exists in `/Library/Application Support/Native Instruments/Hardware/` but was
  not running. No NI plists in `/Library/LaunchAgents` or `~/Library/LaunchAgents`.
  `/Library/LaunchDaemons/com.native-instruments.NativeAccess.Helper2.plist` is Native Access's
  installer helper and is left alone.
- Listing devices needs no permission. Opening the HID interface for reading from Terminal also
  worked without an Input Monitoring prompt (Checkpoint 0, 2026-10-15). Logitech Options+ keeps a
  non-exclusive handle on the MK3; that does not block us.
- **The MK3 goes silent after NI's agent has used it** (verified, Checkpoint 0). With
  `NIHostIntegrationAgent` stopped, the HID interface opened fine but delivered no input reports;
  macOS's counters showed the last input report arrived seconds after boot. The agent had been
  drawing the "start the Maschine software" screen, which went black when it stopped. After
  power-cycling the MK3 (agents still stopped) pad reports streamed immediately (227 reports of
  `0x02` in 5 s). The agent did not relaunch on replug.
  - A USB reset from mk3d does not work on macOS (verified, Checkpoint 1): `UsbDevice.reset()`
    fails with `0xe00002c5` (kIOReturnExclusiveAccess) because the audio and HID drivers keep the
    device open.
  - A short session does not cause it (verified, Checkpoint 1): after `ni-agents.sh start`
    (both agents, "start the Maschine software" screen shown) and `stop`, pads kept reporting
    with the screen black. The earlier silence, present since boot with only
    `NIHostIntegrationAgent` running, is unexplained. Replugging fixes it.
  - What the agent sends to put the device into that state is **unknown**. If we ever need it,
    the NI agent binaries could be inspected with REA (read-only).

## Alternative: rebellion's approach

rebellion does not touch USB. It pretends to be a Maschine/Komplete Kontrol instance and talks to
NIHA/NIHIA over their private IPC, so the NI software keeps working alongside it. The plan
deliberately takes exclusive USB control instead; this is noted in case coexistence is ever needed.
