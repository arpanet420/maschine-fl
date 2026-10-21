# Maschine MK3 ↔ FL Studio – custom integration (macOS)

> **To Claude Code:** This is the project's master plan. Read the whole file before you start.
> Work one phase at a time, in order. Each phase ends with a **🔌 Hardware checkpoint**:
> stop there, tell the user exactly what to test on their MK3 / in FL Studio, and wait
> for an answer before moving on. Update the checklists (`[ ]` → `[x]`) in this file
> as you go, and record new facts about the USB protocol in `docs/protocol.md`.

---

## 1. Goal

A standalone background process on macOS that takes over the Maschine MK3 hardware directly over
USB and turns it into a tightly integrated controller for FL Studio:

- Pads play the selected channel and work as step sequencers for the Channel Rack.
- The two screens (480×272) show FL's state: channels, mixer, plugin parameters,
  patterns and transport, in FL's own colors.
- The 8 touch-sensitive knobs control what is shown on the screen.
- LEDs (pad RGB, buttons, touch strip) mirror FL's state.

### Out of scope

- Sample chopping, waveforms and audio analysis.
- Coexistence with the Maschine software. We take exclusive control of the device.
- Windows. The architecture should still not lock Windows out unnecessarily.

---

## 2. Architecture

```
┌──────────────┐  HID (input, LEDs)   ┌─────────────────────────┐  CoreMIDI virtual ports  ┌──────────────────────┐
│ Maschine MK3 │◄────────────────────►│ mk3d (Node/TypeScript)  │◄────────────────────────►│ FL Studio            │
│              │  USB bulk (displays) │  • hw/: driver          │  "MK3 Bridge" (→ FL)     │ device_MK3Bridge.py  │
└──────────────┘                      │  • modes/: UI logic     │  "MK3 Bridge FB" (← FL)  │  (FL's Python API)   │
                                      │  • render/: screens     │   notes, CC, SysEx       └──────────────────────┘
                                      │  • fl/: SysEx protocol  │
                                      └─────────────────────────┘
```

**Important constraint:** FL scripts run in a sandbox without sockets, threads or pip packages.
The only channel to the outside world is MIDI and SysEx. That is why all heavy logic (rendering,
modes, LED state) lives in the daemon. The FL script is thin: it translates incoming
commands into FL calls and sends state as SysEx.

### Division of responsibility

| Part         | Responsibility                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `hw/`        | Open the device, parse HID reports into typed events, write LED reports, send pixel data to the screens. No FL knowledge.     |
| `render/`    | Draw screen images with canvas and convert them to the device's pixel format. Can render to PNG for testing without hardware. |
| `fl/`        | Virtual MIDI ports, encode and decode the SysEx protocol, keep a mirror of FL's state (`FlState`).                            |
| `modes/`     | Modes (Channel/Step, Mixer, Plugin, Pattern). Take hw events + `FlState` and produce screen, LEDs and commands to FL.         |
| `fl-script/` | The Python script that is installed in FL.                                                                                    |

---

## 3. Technology choices

- **Runtime:** Node.js (LTS) + TypeScript. The reasoning is that `ni-controllers-lib` (Node)
  already has MK3 support and can be used as a reference or dependency.
- **HID:** `node-hid` (hidapi). On macOS the HID interface is claimed by IOHIDFamily,
  so it must be read through hidapi and not libusb.
- **Screens:** `usb` (libusb bindings) for the bulk endpoint on the vendor-specific interface.
- **MIDI:** `@julusian/midi` (RtMidi). On macOS it can create **virtual ports directly**,
  so the IAC bus is not needed.
- **Rendering:** `@napi-rs/canvas` (Skia, prebuilt binaries for Apple Silicon and Intel).
- **Test:** `vitest`. **Lint/format:** `eslint` + `prettier`.
- **NKS:** `.nksf` is a RIFF file (`NIKS`) with the chunks `NISI` (preset info), `NICA` (knob pages),
  `PLID` (the plugin's VST ID) and `PCHK` (the plugin's state). `NISI` and `NICA` are MessagePack
  (`@msgpack/msgpack`). Logos are in `/Users/Shared/NI Resources/image/<vendor>/<product>/`,
  colors in `/Users/Shared/NI Resources/dist_database/<vendor>/<product>/`. Read only, never modified.
- **FL script:** Python, only FL's built-in modules (`device`, `channels`, `mixer`,
  `patterns`, `transport`, `plugins`, `ui`, `general`, `midi`).

If `ni-controllers-lib` turns out to be unstable or incomplete: write our own thin
`hw/` layer directly on `node-hid` + `usb`, and use the library and cabl as protocol references.

---

## 4. Project structure (target)

```
maschine-fl/
├── PLAN.md                  ← this file
├── CLAUDE.md                ← short summary + commands (created in phase 0)
├── docs/
│   ├── protocol.md          ← the USB protocol: report IDs, byte layout, LED indices, screen format
│   ├── sysex.md             ← our SysEx protocol daemon ↔ FL
│   └── mapping.md           ← which MK3 control does what in which mode
├── reference/               ← cloned reference repos (gitignored, read only)
├── src/
│   ├── hw/                  ← device.ts, input.ts, leds.ts, display.ts, ids.ts
│   ├── render/              ← canvas → RGB565, widgets (list, fader, knob label)
│   ├── fl/                  ← midiPorts.ts, sysex.ts, flState.ts
│   ├── modes/               ← channel.ts, step.ts, mixer.ts, plugin.ts, pattern.ts
│   ├── nks/                 ← index of NKS data: knob pages, logos, colors
│   ├── tools/               ← enumerate.ts, inputlog.ts, ledtest.ts, displaytest.ts
│   └── main.ts
├── fl-script/
│   └── MK3Bridge/device_MK3Bridge.py
├── scripts/
│   ├── ni-agents.sh         ← stop/start NI's background agents
│   └── install-fl-script.sh ← symlink the script into FL's Hardware folder
└── test/
```

---

## 5. Phases

### Phase 0 – Preparation and research

- [x] `git init`, Node project, TypeScript, eslint/prettier, vitest. Write a `CLAUDE.md` with
      build, test and run commands.
- [x] Clone references into `reference/` (read them, do not copy code verbatim unless the license allows it):
  - `ni-controllers-lib` (the GitHub repo behind the npm package), focusing on the MK3 part
  - `shaduzlabs/cabl`: find the branch with MK3 support
  - `terminar/rebellion`
  - `Aftalyfe/MaschineMK3FLStudioScript`, as an example of an FL script for the MK3
  - Image-Line's documentation for the FL Studio MIDI Scripting API (callback list and modules)
- [x] Summarize for the MK3 in `docs/protocol.md`:
  - VID/PID (probably VID `0x17CC`, PID `0x1600`, **verify**) and which interfaces and endpoints exist
  - HID input reports: buttons (bit field), pads (pressure values per pad), knobs (absolute/relative
    values + touch), 4D encoder, touch strip
  - HID output reports: LED layout for buttons, pad RGB, touch strip
  - Screens: endpoint, header format, coordinates, pixel format (probably RGB565, **verify** byte order)
- [x] `scripts/ni-agents.sh stop|start|status`. It should list `/Library/LaunchAgents` and
      `~/Library/LaunchAgents` for `native-instruments`/`NI` agents (e.g. NIHardwareAgent,
      NIHostIntegrationAgent; **verify the actual names**) and run `launchctl bootout`/`bootstrap`
      for `gui/$(id -u)`. It should also kill leftover processes. Never delete any files.
- [x] `src/tools/enumerate.ts` lists all NI devices with their interfaces (via node-hid and usb).

**🔌 Checkpoint 0:** The user runs `ni-agents.sh stop` and then `enumerate`. The MK3 should show up
with its interfaces. Check whether macOS asks for Input Monitoring permission and, if so, document
how to grant it.

---

### Phase 1 – Reading input

- [x] `hw/device.ts`: open and close the device, reconnect automatically on unplug.
- [x] `hw/input.ts`: parse raw reports into typed events:
      `ButtonEvent {id, pressed}`, `PadEvent {pad, pressure, phase: 'down'|'move'|'up'}`,
      `EncoderEvent {index, delta}`, `EncoderTouchEvent {index, touched}`, `NavEvent` (4D encoder
      turn/push/tilt), `StripEvent {position, touched}`.
- [x] Pad logic: hit threshold, velocity from the rise of the pressure or the peak during the first
      milliseconds, release threshold with hysteresis and an aftertouch stream. Make the curve configurable.
- [x] `hw/ids.ts`: named constants for all buttons (as labeled on the panel).
- [x] `tools/inputlog.ts`: logs events in readable form, plus a `--raw` mode that shows a hex dump and
      marks changed bytes. It is used to map unknown bits.
- [x] Unit tests for the parsing with recorded reports (save real dumps in `test/fixtures/`).
      Synthetic reports in `test/` plus a real recording (`test/fixtures/checkpoint1.jsonl`).

**Checkpoint 1 done (2026-10-15):** all buttons, pads, knobs, the 4D encoder and the touch strip
give the right events. The knobs count 0–999. Details in `docs/protocol.md`.

**🔌 Checkpoint 1:** The user presses every button, pad and knob. All should give correctly named
events. If anything is missing we run `--raw` and map it together.

---

### Phase 2 – LEDs

- [x] `hw/leds.ts`: state model for all LEDs (brightness for single-color ones, color index
      or RGB for pads, group buttons and touch strip). Send only diffs and limit
      the update rate (~60 Hz).
- [x] Mapping from arbitrary RGB (FL colors) to the nearest color in the MK3's palette, if the device
      uses a palette instead of free RGB.
- [x] `tools/ledtest.ts`: light everything in turn, a rainbow on the pads, a "run" mode where
      the button you press lights up.

**🔌 Checkpoint 2:** All LEDs can be lit and turned off, and the pad colors look right.

**Checkpoint 2 done (2026-10-15):** all LED addresses are correct (Mixer = byte 4, Browser = byte 5,
the opposite of the reference), the palette looks right and run mode lights everything. The buttons' LEDs
have only three states (off, dim, bright), not a gradient. Details in `docs/protocol.md`.

---

### Phase 3 – Screens

- [x] `hw/display.ts`: send a full image and sub-regions to screen 0 and 1.
- [x] `render/`: canvas 480×272 per screen → RGB565 buffer in the right byte order. Redraw only
      changed sub-regions (dirty rects). Aim for ≥ 30 fps on a full update.
- [x] Widgets: header (mode name + page), 8 knob columns (label + value + arc), list with
      colored rows, vertical fader with peak meter, transport row (BPM, position, play/rec).
- [x] `--png` mode that writes screen images to disk, so the UI can be developed and tested
      without hardware.
- [x] `tools/displaytest.ts`: test image, color bars, text, animation (measure fps).

Note: the device accepts ~7.7 MB/s (~34 ms per full screen), so full redraws of both screens
manage ~15 fps. Small sub-regions reach 150+ fps, and the UI redraws only what has changed.

**🔌 Checkpoint 3:** The test image shows correctly on both screens: right colors, no offset
and smooth animation.

**Checkpoint 3 done (2026-10-15):** right colors (big-endian RGB565), screen 0 = left, no
offset, sub-regions work, the animation is as smooth as the panel allows.

**Things to keep in mind in the design later** (from photos of the screens):

- Black turns blue-gray (the panel's black level); a pure black background looks best.
- Orange (`#ff8a00`) turns yellow on the panel; warm colors need correcting.
- The panel ghosts on fast movement; avoid sliding animations, switch directly instead.
- A transfer that is interrupted midway locks the screens until the device is restarted. The daemon must never
  interrupt a transfer in progress.

---

### Phase 4 – MIDI bridge + minimal FL script

- [x] `fl/midiPorts.ts`: create two virtual CoreMIDI ports:
  - **"MK3 Bridge"** (daemon → FL): notes, CC and commands
  - **"MK3 Bridge FB"** (FL → daemon): SysEx feedback
- [x] `fl-script/MK3Bridge/device_MK3Bridge.py`, first version:
  - Header: `# name=MK3 Bridge` (+ optionally `# url=`)
  - `OnInit`: send "hello" via `device.midiOutSysex`
  - `OnNoteOn`/`OnNoteOff`: let them pass through (`event.handled = False`) so the selected channel plays
  - `OnControlChange`: transport (play/stop/rec) via our own CC numbers
- [x] `scripts/install-fl-script.sh`: symlink `fl-script/MK3Bridge` to
      `~/Documents/Image-Line/FL Studio/Settings/Hardware/` (**verify the path** on the user's machine).
- [x] Write in `docs/setup.md` how to set up FL: MIDI Settings → Input "MK3 Bridge",
      controller type "MK3 Bridge", Output "MK3 Bridge FB", **same port number** on in and out.
- [x] `main.ts`: pads → notes (pad 1 = C1 …, configurable), aftertouch, transport buttons → CC.
- [x] Recording early: Rec arms recording, Shift + Rec = count-in (`midi.FPT_CountDown`),
      Tap/Metro = metronome (`midi.FPT_Metronome`). The Rec LED mirrors FL's recording state.

**🔌 Checkpoint 4:** Pads play the instrument in FL with dynamics, and Play/Stop/Rec work.
The daemon's log shows "hello" from FL. **Recording test:** arm Rec, start Play, play on the
pads and check that the notes end up in the piano roll of the selected pattern with the right velocity.
Also test count-in and metronome.

**Checkpoint 4 result (2026-10-17): approved.** Hello, transport, count-in, metronome and
recording to the piano roll work. The dynamics first felt too soft. With REA the cause was
found: the MK3 itself marks each pad entry as a hit (with strength), release or press, and NI reads
exactly that (`docs/protocol.md`). After the rewrite, light to hard hits gave velocity 13–127.
The pad sensitivity (`F4` report) did not need to be sent.

---

### Phase 5 – SysEx protocol in both directions

- [x] Specify in `docs/sysex.md`. Draft:
  - Frame format: `F0 7D 4D 33 <cmd> <payload…> F7` (`7D` = non-commercial manufacturer ID,
    `4D 33` = "M3")
  - Strings: 7-bit ASCII, null-terminated, max 32 characters
  - Values: 14 bits (two 7-bit bytes) for volume/pan/parameters
  - Colors: 24-bit RGB packed into 4 × 7-bit bytes
  - Larger dumps are split with `<seq> <total>`
- [x] Commands **FL → daemon:** `HELLO`, `TRANSPORT {playing, recording, bpm, songPos}`,
      `CHANNELS {offset, [name, color, selected, mute]…}`, `SELECTED_CHANNEL`,
      `STEP_GRID {channel, pattern, bits[16]}`, `MIXER {offset, [name, color, vol, pan, mute, solo]…}`,
      `METERS {offset, peaks[8]}`, `PLUGIN {name, page, [paramName, value, valueText]…}`,
      `PATTERN {current, name, color, count}`
- [x] Commands **daemon → FL:** `REQUEST_STATE {what}`, `SELECT_CHANNEL`, `SET_STEP`,
      `SET_MIXER {track, param, value}`, `SET_PARAM {param, value}`, `NUDGE_PARAM {param, delta}`,
      `SELECT_PATTERN`, `SET_PAGE`, `UNDO`, `SAVE`, …
- [x] The FL script: send state in `OnRefresh(flags)`, `OnDirtyMixerTrack`, `OnDirtyChannel`,
      `OnProjectLoad`, `OnUpdateMeters` (requires `device.setHasMeters()`) and throttled in `OnIdle`.
      Send **only what has changed**. Keep your own cache in the script and compare.
- [x] Encoder and decoder in TypeScript with unit tests (round-trip). Keep the Python side
      a simple mirror image.
- [x] `fl/flState.ts`: the daemon's mirror of FL. It sends events to the modes when something changes.

**🔌 Checkpoint 5:** Switch channel and project in FL and see that the daemon's log (or `--png`) shows
the correct state without noticeable delay.

**Checkpoint 5 result (2026-10-18): approved.** Channel switching (with the right plugin), color, mute,
steps, pattern switching, position and tempo show up immediately in the log and on the screens. The Diva parameter
Output follows on the MK3's screen. When FL is closed the MK3 shows "Waiting for FL Studio…" (GOODBYE +
ALIVE heartbeat). Discovered live: `getCurrentTempo(True)` gives the whole BPM and `getPatternLength`
gives steps, not beats; FL's colors are `0x--RRGGBB`. FL 2025 is also installed but lacks the
MK3 Bridge setting.

---

### Phase 6 – Modes

See `docs/mapping.md` (created in this phase) for the exact button mapping. **Workflow (2026-10-19):** `docs/workflow.md`
follows Maschine's own design (home page + main pages, hold-to-peek overlays with a pin tab, latched
tool pages, SHIFT as a second function) and proposes a build order; `docs/design.md` describes how FL
looks on the screens. Original draft:

| Button on the MK3          | Mode    | Left screen                                 | Right screen                              | Pads                                                   | Knobs                                |
| -------------------------- | ------- | ------------------------------------------- | ----------------------------------------- | ------------------------------------------------------ | ------------------------------------ |
| **Channel**                | Channel | Channel list (colors), selected highlighted | Selected channel: vol, pan, pitch, filter | Play the selected channel                              | Channel parameters                   |
| **Step** (Pattern section) | Step    | Channel + pattern                           | 16 steps as a grid, page 1/2…             | 16 steps for the selected channel, LED = channel color | Step velocity/pitch for the held pad |
| **Mixer**                  | Mixer   | Tracks 1–4 (fader + peak)                   | Tracks 5–8                                | Select track                                           | Volume (Shift = pan)                 |
| **Plug-in**                | Plugin  | Plugin logo (NKS) + name + pages            | 8 parameters with value text              | Play                                                   | Parameters on the current page       |
| **Pattern**                | Pattern | Pattern list                                | Info about the selected pattern           | 16 patterns, press = select                            | –                                    |

Common to all modes:

- The display buttons above the screens select a page or tab.
- **Touching** a knob shows its full name and value in large type. The arrow buttons scroll through banks of 8.
- The 4D encoder: turn = scroll a list, push = select, tilt = navigate in FL (`ui.up/down/left/right`).
- The GROUP A–H buttons: quick selection of a channel or track.
- Transport: Play, Rec, Stop, Restart, Tap (tempo), Metro; Shift + Rec = loop record.
- Touch strip: the mode buttons PITCH (default) / MOD / PERFORM / NOTES are a radio group (`src/strip.ts`, docs/mapping.md "Touch strip"): pitch bend, mod wheel (CC 1, remembers the value per channel), filter sweep on cutoff (resets on release), notes; no mode = play position. Built, not verified in FL yet. Shift + strip does nothing yet.
- Modes should be plain objects (`onEnter`, `onEvent`, `render`, `ledState`) and be
  testable without hardware by feeding in events + `FlState` and checking the `--png` output.

Order: Channel (the foundation) → Mixer → Plugin → Step → Pattern.

- [x] Channel
- [x] Mixer
- [x] Plugin
- [x] Step
- [x] Pattern

**Result 2026-10-19 (hardware, build steps 1–5 in `docs/workflow.md`):** The user has tried everything
on the MK3 with FL 2026. The page model (home page, main pages, hold overlays with a pin tab) works.
The PATTERN/MUTE/SELECT/SOLO overlays work after the pads were numbered as in Maschine (pad 1 =
bottom left; the device numbers from top left, `panelPad`). The Mixer page in FL's style
works. PAD MODE plays the pad's own channel (notes on MIDI channel 2, `channels.midiNoteOn`, root note
60), KEYBOARD and channel banks via GROUP A–H work. STEP works; the playhead was hard to see and
is now shown as a light square on the screen and in the opposite shade on the pads. PATTERN duplicate/create and ERASE
work. Quick edit, SHIFT+pad, NAVIGATE and GRID: after feedback VOLUME controls FL's _main volume_
(not the Master fader), CLEAR/paste becomes a single undo step, copy/paste is a
step clipboard in the FL script and every SHIFT action shows a short read-out; the user confirms that
main volume, undo/redo, clear and copy/paste now behave correctly. Next: step 6 (NOTE
REPEAT, BROWSER presets, FILE, SETTINGS, ARRANGER/SCENE markers, CHORDS).

**Result 2026-10-18 (hardware, step 6a NOTE REPEAT):** The user has tried NOTE REPEAT on the MK3
with FL 2026: "its perfect!". Hold and pin overlay, bars on displays 2–8, rate/gate/swing on knobs
1–3, repeats in KEYBOARD and PAD MODE, tempo-locked to FL. Not checked separately: the assumption of
24 ticks per step in SONG_POS (PPQ 96) for sync to the song position during playback.

**Result 2026-10-18 (hardware, steps 6b–6d):** The FILE page works and saves ("file menu is good,
save works"). CHORDS works ("chord mode is good"). BROWSER, SETTINGS and FIXED VEL have not had
any comment yet; in the log BROWSER shows only 2 presets for Diva with no known current index, and
each step renames the channel and adds an undo step. ARRANGER/SCENE: the user does not understand how
they are supposed to be used and wants a view resembling Maschine's arranger, where the content is visible. The marker scan
gave wrong positions in pattern mode (one marker was read as @0). To be redone.

**Reworked (software, not tried on hardware):** The playlist probe's answer: the script sees
neither clips nor piano roll notes (performance mode off). The user chose a pattern overview. ARRANGER
now shows the current pattern as sound × step (right screen: up to 8 channel rows × 16 steps with playhead,
left: the channels; 4D = row cursor, pads = patterns) via the new PATTERN_GRID (`1B`) and the VIEW flag
`patternGrid` (`4`). The marker list takes count and names from `getMarkerName` (times unknown
if the scan doesn't match). FL's performance mode is a later alternative. Reload the script in FL.

**Result 2026-10-18 (hardware):** ARRANGER as a pattern overview: "its good for now!". BROWSER after
the rework (cursor, scrolling, loading with a 4D push): "clear"; at the owner's request knob 5 scrolls too,
and display button 8 `LOAD` loads the cursor's preset.

**Result 2026-10-18 (hardware, PATTERN page):** Knob 4 LENGTH in whole bars, DOUBLE on display button 3
and a new pattern on an empty pad work ("Length, DOUBLE and creating on an empty pad work").
`setPatternLength` counts in steps; `jumpToPattern(k)` creates the pattern (`patternCount 3 -> 4`). But in
the log the second half was empty after DOUBLE (`xxxxx..x.xxxx...` + 16 empty steps): the notes
were recorded (piano roll notes), and copying them with `setGridBit` does not seem to work; to be investigated.
The SHIFT + RESTART loop sets FL's song loop (`song loop: 0…1536 ticks`).
Follow-up: FL's hidden `patterns.duplicatePatternData(n)` copies all notes, including piano roll notes
(tried with SHIFT + DOUBLE). DOUBLE now uses it directly and then sets the length to 2L.
Limitation: the clips in the playlist keep their length; the API can't change playlist clips, so they have to
be dragged out by hand. Tried on a new pattern: DOUBLE copies cleanly. The short extra notes in an earlier pattern were
leftovers from the old step copy (`setGridBit` on a channel with piano roll notes adds short notes),
which `duplicatePatternData` then copied along.

**Result 2026-10-18 (hardware):** ARP (NOTE REPEAT in KEYBOARD/CHORDS) works ("arpeggio is
fine"). Window following is unclear to the owner ("not sure about follow"), to be followed up.

**Result 2026-10-18 (hardware, touch strip):** NOTES plays notes well, PITCH bends the pitch
(`setChannelPitch`, ±2 st in the log). MOD and PERFORM were not audible: PERFORM selected Diva's "CutoffSlop"
(the name matching now scores names so that "VCF1: Frequency" wins; not tried again). MOD writes
the VST parameter for CC 1; the owner confirms later that the mod wheel works ("modwheel working").
The owner: "maybe that's ok for now".

#### Idea list from the owner (2026-10-18)

Random observations and ideas, with a first assessment of what FL's API allows:

- [x] **New instrument on an empty pad.** The public API can't create channels, but FL 2026 has
      an undocumented module `ilmcp` with `addChannel(plugin name)`, `getBrowserNames(path)` and
      `addEffect` (found with REA 2026-10-18, see docs/fl-ilmcp.md). The probe (`MK3D_PROBE=1`, open
      ARRANGER) showed 2026-10-18 that it **cannot** be imported from a controller script (it exists
      only in FL's Gopher/MCP sessions). Blocked for now. Earlier assessment:
      the API can't create channels or load plugins directly.
      Possible route: FL's browser via `ui.navigateBrowser` / `navigateBrowserMenu` /
      `selectBrowserMenuItem` (e.g. "Open in new channel"); needs a probe first.
      **Solved 2026-10-19 (verified in FL 2026):** the BROWSER page's PLUG-INS (display button 2) opens FL's
      Plugin picker (F8): 4D turn/tilt scrolls, 4D push (Enter) adds the plugin as a new channel;
      the name is not shown (the user looks in FL). See docs/fl-ilmcp.md "Plugin loader trial", Result.
- [x] **Bug: the Mixer shows a channel 17 at full volume.** The log shows `mixer (18)` with track 17 without
      a name; probably a hidden/"current" track that should not be shown.
- [x] **The page buttons bring up FL's windows:** ARRANGER → the playlist (already done), MIXER → FL's mixer,
      STEP/PATTERN → the channel rack, etc. (SHOW_WINDOW already exists.)
- [x] **Arpeggio in NOTE REPEAT** (in Maschine, NOTE REPEAT opens `ARP` in keyboard mode). Built entirely in
      mk3d (KEYBOARD and CHORDS; PAD MODE remains Note Repeat): Type, Rate, Octaves, Gate, Swing,
      HOLD, four presets; not built: Dynamic, LOCK, GATE RESET, page 2. Not tried on the MK3.
- [ ] **Hidden functions in the documented modules work** (probe 2026-10-18,
      docs/fl-ilmcp.md): ~~pattern length~~ (`patterns.setPatternLength`: built as the PATTERN overlay,
      knob 4 `LENGTH`, knob 1 on page 2 = the pattern's color; not tried in FL, the log shows `← FL probe:`),
      clear pattern (`clearPattern`, ERASE), ~~loop range in the song~~ (`arrangement.selectionSet`: built,
      SHIFT + RESTART tap = loop off/on, hold = the LOOP overlay; the tap verified on the MK3
      2026-10-21, the overlay not tried), the channel's swing (`channels.setSwing`), the FX slots' mix and bypass on the Mixer page, time signature.
- [ ] _Last:_ **Port NKS presets.** `.nksf` contains the plugin's state, but the API can't set
      a plugin's state; maybe via conversion to FL/VST preset files and FL's browser.
- [ ] _Last:_ **Sample editor.** MIDI scripts can't edit audio (Edison scripts only run
      inside Edison); partly possible via the Sampler channel's parameters (start, length, envelope).

**API stub review (2026-10-19), next-probe steps for three open ideas:**

- **Performance mode as scenes — confirmed viable (2026-10-20).** The playlist probe that found
  `playlist.getLive*` reading nothing was run with performance mode off; re-run with it **on** and
  a clip on Track 1 block 0, `getLiveBlockStatus` reported the real grid (`T1 def: 1 0 0 0…`, every
  other track/block `0`) and `liveTimeToBlockNum` came alive too (see `docs/workflow.md`, "Playlist
  probe, 2026-10-20"). So block status (filled/scheduled/playing) can drive pad LEDs and
  `triggerLiveClip` is the trigger call — a real Maschine-scenes feature, not just a stretch goal.
  Still open: `getLiveStatus` (the per-track summary) still errors where `getLiveBlockStatus`
  doesn't. **Built (2026-10-20), then corrected the same day on hardware:** the first LIVE overlay
  showed one selected track's 16 blocks, which the owner caught was wrong against a real multi-track
  layout — FL's own "scene" fires every track's clip at a column together (its manual: "any group of
  Clips, on independent tracks..."). A second build fanned presses out per track (a binary diff
  of function names had found no "trigger scene" function) and still did nothing audible. Third
  build: copied from Image-Line's own Akai Fire script, where the scene trigger is a flag,
  `TLC_ColumnMode`, and launches use `TLC_MuteOthers | TLC_Fill` plus a `TLC_Release` call on pad-up
  (see Phase 7's checklist, docs/sysex.md "Live grid") — not yet tried on the MK3. Likely cause of
  the `getLiveStatus` error: the probe calls it with `LB_Status_Simplest`, which the stubs say is
  only valid for `getLiveBlockStatus` (the Fire script uses `LB_Status_Simple`); not re-probed.
- **Sample editor, as a parameter editor (not a waveform editor).** No API gives PCM/waveform
  access, so chopping/scrubbing stays out of reach. But `midi.REC_Chan_*` exposes more than start/
  length/envelope implies: `SmpOfs` (start), `StretchTime`, `Crossfade` (loop), `FCut`/`FRes`/`FType`
  (filter), plus 5 full envelope/LFO generators (volume, pan, mod X/Y, pitch, cutoff). Paired with
  `device.getLinkedValue/getLinkedValueString/getLinkedParamName(eventId)` — value, display text and
  name for any event ID, no prior linking needed — this is Plugin mode's "8 knobs = 8 params" pattern
  retargeted at `channels.getRecEventId(ch) + midi.REC_Chan_*` instead of a VST param index, gated on
  `channels.getChannelType() === midi.CT_Sampler`. Mostly plumbing; reuses existing `pluginMode.ts`
  machinery. The cheapest of the three to build.
- **NKS preset loading — conversion confirmed, hardware access is not possible.** `PCHK` for u-he
  plugins (Diva, Repro-1/5, Satin, ColourCopy, Twangstrom) is `u32 version` + u-he's own plain-text
  `.h2p` patch format, byte-for-byte (see `docs/nks.md`, "PCHK and loading NKS presets"). **Verified
  2026-10-20:** stripped and written to `…/Diva/NKS Import Test/MidRangePad (from nksf PCHK).h2p`,
  it shows up in Diva's own Patches browser and sounds right. **But** mk3d's BROWSER page
  (`plugins.getPresetCount()/nextPreset()/prevPreset()`) turned out to drive a different, generic
  129-slot VST program list on Diva ("Program `<n>`"), not the Patches browser — stepping it live
  on the hardware changed the channel name but left the Patches browser untouched. So the
  conversion works, but **FL scripting has no hook into the plugin's real preset browser**; loading
  NKS presets from the MK3 hardware stays out of scope, same conclusion as the original plan, just
  for a different reason (the preset list and the real patch library are separate, not "the API
  can't set plugin state"). What's left, if wanted later: a standalone one-time migration tool
  (convert the whole indexed u-he NKS library into native `.h2p` files, no FL/hardware involved) —
  lower priority, not requested yet.
- **Pads light up when the sequencer plays them (owner, 2026-10-20, for later).** A basic difference
  from Maschine: there, pads the pattern plays flash with playback (the owner's understanding; not
  confirmed in NI's manual yet, whose "Playing on the controller" page only describes Keyboard
  mode's root-note highlighting). Wanted in pad mode, and if possible KEYBOARD and CHORDS.
  - **Pad mode (pad = channel): built (2026-10-20), software only.** `channels.getActivityLevel(index)`
    (API v9; "how recently a note was played, as well as whether any notes are currently playing")
    is what Image-Line's Akai Fire script lights its channel pads with (`getActivityLevel(n) > 0` →
    "playing note (from FL)"). The FL script reads it for the selected channel's bank of 16 every
    pass while FL plays and sends ACTIVITY (0x24, docs/sysex.md) when it changes; PAD MODE's pads
    light pressed while their channel plays (docs/mapping.md "Pad modes"). **Verified on the MK3
    (2026-10-21)**: pads flash in time with their steps and clear on STOP; SELECT / MUTE / SOLO do
    not light from playback. The `> 0` test is fine, no threshold needed. Not done: KEYBOARD and
    CHORDS.
  - **KEYBOARD / CHORDS (pads = notes of one channel): harder.** No script API reports which note
    a channel is playing. Options to probe: the selected channel's step-sequencer steps (already
    read for STEP) plus the song position predict the root-note hits only, not piano-roll notes;
    `OnMidiOutMsg` gets notes only through a MIDI Out plugin routed to the bridge port (needs setup
    in the project, so not a default); otherwise whole-channel activity could light every pad
    faintly as a "this channel is playing" hint.

**Owner's order (2026-10-19):** performance-mode probe first, then NKS preset loading (the `.h2p`
test above), then the sample editor.

#### NKS in Plugin mode

NKS plugins (e.g. u-he Diva) have ready-made knob pages and logos. Plugin mode uses them when
they exist, otherwise FL's own parameter list.

- [x] `nks/`: index NKS data at startup. Find `.nksf` files (e.g.
      `/Library/Application Support/<vendor>/<product>/NKS`), read `PLID` and `NICA`
      (pages of 8 with name, section and parameter ID). Cache the index on disk.
- [x] Match the plugin that has focus in FL against the NKS data. FL's API gives the plugin's name, not the VST ID,
      so match on name and verify with `PLID`/`dist_database`.
- [~] Verify that `NICA`'s parameter ID corresponds to the index in `plugins.getParamValue` in FL 2026,
  for both VST2 and VST3 (test with Diva). Document in `docs/mapping.md`.
- [x] Show `MST_logo.png` and the plugin's color (`color.json`) in the screen header.
- [x] Fallback without NKS: FL's parameter list in pages of 8.
- Out of scope: loading NKS presets. FL's API can't set a plugin's state.

**Result 2026-10-18 (hardware):** The NKS pages for Diva work. The log: `NKS: Diva → u-he Diva
via vst2, 10 pages (coverage 100 %, agreement 87 %)`. Pages, sections and knob names match
Diva's GUI, and knob 1 on the Filter page turns `VCF1: Frequency` (NICA id 148 = FL index 148).
NICA id = FL index is thus verified for Diva in FL 2026 (the format FL loaded is not logged;
the match went via the VST2 ID). VST3 plugins with their own ParamIDs (e.g. Ozone) have not been tried yet.
The index reads 4553 presets for 28 products (cold start 2.7 s, then cache).

**Status 2026-10-18:** Channel and Plugin modes built (Plugin first with FL's parameter list
in pages of 8). The user has tried both on the hardware: the Channel buttons work after the
reworked layout (controls are drawn on the screen they sit by), and Plugin mode turns Diva's own
knobs in the GUI. The NKS research is in `docs/nks.md`. Next: NKS pages in Plugin mode, then
Mixer, Step, Pattern.

**🔌 Checkpoint 6:** One checkpoint per mode. The user tries it in a real project and gives
feedback on the feel before the next mode is started.

---

### Phase 7 – Polish and operation

- [ ] **Project review 2026-10-21** (`docs/review-2026-10-21.md`): prioritized findings and lessons;
      section A (LIVE/ACTIVITY polling cost, the setup.md reload instruction, committing) comes
      before the next hardware test.
- [ ] Config file (`~/.config/mk3d/config.json`): velocity curve, pad note mapping, threshold values,
      color theme.
- [x] Note Repeat (hold overlay, see docs/mapping.md; synced to FL's tempo; the daemon can keep its own clock from BPM or
      use MIDI clock from FL if that is more stable).
- [x] FL's performance mode as Maschine scenes: pads start clips per track (the API reports clips
      only in performance mode, see the probe in docs/workflow.md). The owner thinks users will want
      this. **Confirmed viable (2026-10-20)**, built, **tried on hardware and found wrong the same
      day**: the first LIVE overlay showed one selected track's 16 blocks, triggering only ever that
      track regardless of which pad — but the owner's test layout had clips on three different
      tracks, and FL's own "scene" (its manual: "any group of Clips, on independent tracks, that can
      be triggered to start playing together") fires every track's clip at a column together. The
      second build fanned a press out per track after a binary diff of function names found no
      "trigger scene" call; it still did nothing audible on hardware. **Third build (2026-10-20),
      copied from Image-Line's own Akai Fire script** (`device_Fire.py` in FL's user Hardware
      folder): the scene trigger is a flag, `TLC_ColumnMode`, not a function; launches use
      `TLC_MuteOthers | TLC_Fill` (+ `TLC_GlobalSnap` with snap on) where ours sent 0 (the log
      showed clips stacking on one track); the pad's release sends `TLC_Release`, which ours never
      did; and status is read in `LB_Status_Default` so scheduled and playing are told apart
      (Simplest reported both as 2, which the earlier builds read as "working"). docs/sysex.md
      "Live grid", docs/mapping.md "LIVE". **Verified on the MK3 (2026-10-21)**: a pad fires its
      column on every track that has a clip there and stops the tracks that have none, a press on
      an empty column does nothing, the release follows 60–80 ms later and cuts nothing off, and
      the status reads 3 (queued, FL stopped), 5 (playing, a switch pending) and 7 (playing).
      `getLiveTrigSnap` 5 is `LiveSnap_Four` (4 beats; the stubs list 0 off, 1 ¼ beat, 2 ½ beat,
      3 1 beat, 4 2 beats, 5 4 beats, 6 auto), which matches every switch landing within one bar.
      Pages (display 7/8) and display 4 STOP work. Owner feedback, fixed the same day (software
      only, not yet on the MK3): the queued half-beat blink was too subtle, now brightest/off every
      250 ms like SCENE, also while stopped; "hard to understand what patterns are in the tracks",
      now each clip is labelled with the one pattern that has its color (docs/mapping.md "LIVE").
      Reading more than 8 tracks needs chunking.
- [ ] **LIVE readability redesign (owner, 2026-10-20: "almost empty now, and requires looking at
      computer").** After the third build is verified on hardware. Today a pad is a whole column
      squeezed into one color and the screens show one sentence. What the API offers that LIVE does
      not use yet (`playlist` stubs): per track `getTrackName/getTrackColor`, every block's status
      and color, `isTrackMuted/isTrackSolo` + `muteTrack/soloTrack`, `getTrackActivityLevel`,
      `getLiveTriggerMode/getLiveLoopMode/getLivePosSnap/getLiveTrigSnap` with `incLive*` to step
      them, and `liveDisplayZone` (the box FL draws on the playlist around a controller's window,
      as the Fire and Launchpad do). No clip names. In priority order:
      **Steps 1 and 2 built (2026-10-20), software only, not yet on the MK3** (docs/mapping.md
      "LIVE", LIVE_GRID/LIVE_TRACK in docs/sysex.md, `out/ui-live-*.png`): the clip matrix and the
      aligned track list, per-track LIVE_TRACK rows on the wire, scheduled pads blinking on the half
      beat, `Bar n` with beat dots and a "Queued — press PLAY" hint. Not built from step 2: the
      "starts in N beats" countdown — it needs `getLiveTrigSnap`'s values mapped to snap lengths;
      LIVE_TRACK carries the raw value and the log prints it (`snap n`), so the hardware session
      can map it.
      1. **The grid on the screens (biggest gain).** Right screen: a zoomed-out clip matrix, 8
         tracks × 16 blocks in their real colors, playing solid, scheduled outlined, the pads'
         16-block window framed. Left screen: one row per track — name, color, mute/solo badge,
         which block it plays. Wire change: LIVE_GRID sends per-track rows (one track per frame,
         deduplicated per row) instead of the column aggregate; mk3d derives the scene view itself.
      2. **Timing.** Scheduled pads blink on the beat and playing pads pulse (mk3d already gets
         FL's beat indicator, `OnUpdateBeatIndicator`); a bar/beat counter and a "starts in 3
         beats" countdown for scheduled clips from the song position and the trigger snap.
      3. **Two pad layouts on a display button.** SCENES (today: a pad fires a column) and CLIPS
         (4 tracks × 4 blocks, single-clip launch without `TLC_ColumnMode`, like the Fire), the 4D
         encoder moving the window. In CLIPS, MUTE / SOLO + pad mute or solo that track (the
         Maschine way); per-track stop on the display buttons.
      4. **Scene names and FL's box.** If a playlist marker starts at a block's time, show its name
         as the scene name (the owner's project has markers "Pad #1"…"Pad #16"; mk3d already reads
         markers) — NOT VERIFIED that FL's markers line up with its blocks. Call `liveDisplayZone`
         for the pads' window so FL shows what the Maschine covers.
      5. **Knobs for per-track settings**: trigger mode, loop mode and snap per track via
         `incLive*`, which FL otherwise hides in a track menu.
      1 and 2 are what fix "almost empty" and "needs the computer". Nothing built, no mockups yet.
- [x] Scales and chords on pads (the Keyboard and Chords buttons; see docs/mapping.md, the CHORDS page).
- [x] The Fixed Velocity button (the SETTINGS page has the value and the velocity curve).
- [x] `launchd` agent (`~/Library/LaunchAgents/io.github.arpanet420.mk3d.plist`) so that the daemon starts at
      login. Logs to `~/Library/Logs/mk3d.log`. `bin/mk3d` (setup, service, start/stop, doctor)
      and `Formula/maschine-fl.rb`. Verified: the CLI and the plist against a temp home with `MK3D_NO_LAUNCHCTL`
      (`test/cli.test.ts`), `npm run build`. NOT verified: the Homebrew formula (only `ruby -c`), the service
      against real launchd and the MK3, possible Input Monitoring permission for `node` — the owner will try.
- [ ] Start screen and clear status on the screen: "Waiting for FL Studio…" when no HELLO has arrived.
- [ ] Robustness: FL is restarted, the device is unplugged, macOS sleeps and wakes.
- [x] README with installation from scratch (Homebrew first, then from a clone; `docs/install.md`).
      The formula is untested, see above.

---

## 6. Working rules for Claude Code

1. **No hardware access in tests.** All logic above `hw/` should be testable with mocked
   events and `FlState`. `hw/` is tested with recorded fixtures.
2. **Don't guess the protocol.** If something is unknown: write a diagnostic tool, ask the user to run
   it and paste the output, then document it in `docs/protocol.md`.
3. **Never touch NI's files.** Start and stop agents with launchctl, never delete or modify
   anything under `/Library` or in NI's program folders. Never send firmware commands
   to the device.
4. **The FL script must be defensive.** FL can crash or hang if the script throws errors in
   callbacks. Catch exceptions, log with `print` (visible in FL's Script output) and never send
   large SysEx bursts in a single call.
5. Small commits per completed subtask, with descriptive messages.
6. Update the checklists in this file when something is done.

---

## 7. Risks and open questions

| Risk                                           | Handling                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| A firmware update from NI changes the protocol | Note the firmware version in `docs/protocol.md`, don't update unnecessarily            |
| The NI agents restart themselves               | `ni-agents.sh` checks and stops them again. Possibly a check at daemon startup         |
| FL's API doesn't expose something we want      | Check the API documentation before designing a mode, and document gaps in `mapping.md` |
| Latency SysEx FL → daemon                      | Measure in phase 5. Send diffs, group and throttle in `OnIdle`                         |
| Pixel format or byte order wrong               | Test image with known color bars in phase 3                                            |

**Open questions for the user (ask in phase 0):**

- Apple Silicon or Intel? Which macOS version? Which FL Studio version?
- Should pads play the selected channel by default, or an FPC mapping?
- Which mode is most important to finish first after the foundation? (Suggestion: Step → Mixer → Plugin.)

**Answers (2026-10-15):**

- Apple Silicon (M4), macOS 27.0.1, **FL Studio 2026** (26.1.5). FL Studio 2025 is also
  installed but is not the target.
- Pads play the **selected channel** by default.
- Mixer is important; the step sequencer is rarely used but should be included. Order after the foundation:
  Mixer → Plugin → Step.
- Recording to the piano roll should work early (tested in Checkpoint 4).
- Plugin mode uses NKS data (knob pages, logos) when it exists.
