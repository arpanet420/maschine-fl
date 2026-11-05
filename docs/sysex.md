# mk3d ↔ FL Studio protocol

Defined in `src/fl/protocol.ts` and `src/fl/sysex.ts`; the FL side is
`fl-script/MK3Bridge/device_MK3Bridge.py`. Both sides test against the same byte vectors in
`test/fixtures/sysex-vectors.json`.

Protocol version: **2** (the quick-edit additions below, `mainVolume`, UNDO_STATE, SET_MAIN_VOLUME and the pattern length, pattern colour and song loop messages are additive, no bump).

## Ports and channels

| Port          | Direction | Content                                                                |
| ------------- | --------- | ---------------------------------------------------------------------- |
| MK3 Bridge    | mk3d → FL | Pad notes on MIDI channel 1 (KEYBOARD) and 2 (PAD MODE); control CCs on channel 16; SysEx commands |
| MK3 Bridge FB | FL → mk3d | SysEx state messages                                                   |

FL's script sends SysEx out of the output port that has the same port number as its input.

## Pad notes (mk3d → FL)

| MIDI channel | Pad mode           | Note number                          | What the script does                                                                       |
| ------------ | ------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1            | KEYBOARD           | `base + pad` (base 0–112, default 36) | Nothing: FL plays the note on the selected channel. Velocity from the hit, poly aftertouch |
| 2            | PAD MODE (channels) | the channel's group-local index 0–127 | `OnNoteOn`/`OnNoteOff` play that channel (below). Poly aftertouch is swallowed             |

**Pad notes for channels.** In PAD MODE pad _n_ plays channel `bankStart + n`, and mk3d sends a
note on or off on MIDI channel 2 (0-based channel 1, `CHANNEL_NOTE_CHANNEL`) with the channel's
group-local index as the note number. The script plays it itself:
`channels.midiNoteOn(channels.getChannelIndex(index), 60, velocity)` for a note on, with velocity 0
(`OnNoteOff`, or a note on with velocity 0) for the note off, and sets `event.handled = True`.
`OnKeyPressure` on that MIDI channel is handled (ignored) too. Every other MIDI channel stays
unhandled, so keyboard notes go straight to FL (the touch strip no longer sends raw pitch bend or
CC 1 to a VST: it uses STRIP, below; a raw CC 1 remains for plugins without CC parameters).
Channels past index 127 cannot be played this way (the note number is 7-bit): mk3d plays nothing
for them. Verified in FL 2026 (owner, 2026-10-19): FL's `OnNoteOn` sees notes on MIDI channel 2
from this port, `midiNoteOn` with the converted index plays the right channel, and root note 60
sounds right. mk3d also selects the channel on a hit when it is not selected yet (SELECT_CHANNEL).

## Control CCs (mk3d → FL, channel 16, value 127 = trigger)

| CC  | Action in FL                                           |
| --- | ------------------------------------------------------ |
| 102 | `transport.start()` (play/pause)                       |
| 103 | `transport.stop()`                                     |
| 104 | `transport.record()` (toggle record arm)               |
| 105 | `globalTransport(FPT_CountDown, 1)` (toggle count-in)  |
| 106 | `globalTransport(FPT_Metronome, 1)` (toggle metronome) |
| 107 | `globalTransport(FPT_TapTempo, 1)`                     |
| 108 | Restart: `transport.stop()` then `transport.start()`   |

## SysEx frame

`F0 7D 4D 33 <command> <payload…> F7`. `7D` is the non-commercial manufacturer ID, `4D 33` is
"M3". Every payload byte is 7-bit. Commands `01`–`3F` go FL → mk3d, `40`–`7F` go mk3d → FL.

A receiver ignores frames with an unknown command and ignores extra bytes at the end of a known
one, so either side can add fields at the end later.

### Field types

| Type    | Bytes | Encoding                                                                                                                                                                                             |
| ------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `u7`    | 1     | 0–127                                                                                                                                                                                                |
| `u14`   | 2     | high 7 bits first: `[v >> 7, v & 0x7F]`                                                                                                                                                              |
| `u21`   | 3     | high 7 bits first                                                                                                                                                                                    |
| `norm`  | 2     | `u14` of `round(x × 16383)` for `x` in 0–1 (clamped). Pan −1…1 is sent as `(pan + 1) / 2`                                                                                                            |
| `color` | 4     | `0xRRGGBB` as a 28-bit number, high 7 bits first: `[c >> 21, c >> 14, c >> 7, c] & 0x7F`. FL's signed colors are masked with `& 0xFFFFFF` first                                                      |
| `str`   | 1–65  | UTF-8, at most 32 characters (cut before encoding). Byte `b < 0x7F` is sent as is; byte `b ≥ 0x80` as `0x7F, b & 0x7F`. Ends with `0x00`. The sender drops characters below `0x20` and `0x7F` itself |
| `s7`    | 1     | signed 7-bit: −64…63 sent as `value + 64` (clamped)                                                                                                                                                  |
| `none`  |       | `u14` value `0x3FFF` means "nothing" where noted                                                                                                                                                     |

Rounding is `floor(x + 0.5)` on both sides (not Python's `round`, which rounds half to even).
Decoded `norm` values are `v / 16383`; decoded pan fields are `v / 16383 × 2 − 1`. In SET_CHANNEL
and SET_TRACK the value is always the raw `norm` (for pan: `(pan + 1) / 2`).

Lists carry at most **4 entries per message** (PARAM_NAMES, PRESETS and MARKERS: 8); a longer list goes out as several messages, each
with its own `offset`. Indexes are 0-based unless noted. Channel indexes are FL's
group-local indexes (what the channel rack shows with the current filter group).

## FL → mk3d

| Cmd  | Name             | Payload                                                                                                                                                                                                    | Sent when                                                                                                                                                                                                                                       |
| ---- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01` | HELLO            | `u7 version`                                                                                                                                                                                               | Script starts; answer to REQUEST_STATE. mk3d drops its old state; everything follows                                                                                                                                                            |
| `02` | TRANSPORT        | `u7 flags`, `u21 tempo` (BPM × 100), `norm swing`, `norm mainVolume`                                                                                                                                       | Change. Flags: 1 playing, 2 recording, 4 metronome, 8 count-in, 16 song mode (`transport.getLoopMode() == 1`; 0 = pattern mode, also for an older script that does not know the bit). `swing` is the main swing (`REC_MainShuffle`); a message without it means swing 0. `mainVolume` is FL's main volume (`REC_MainVol`, not the Master mixer fader); a message without it (an older script, or a failed read) means unknown, mk3d shows no value until it arrives |
| `04` | GOODBYE          | none                                                                                                                                                                                                       | `OnDeInit`: FL quits, or the script is reloaded or disabled. mk3d forgets FL's state                                                                                                                                                            |
| `05` | ALIVE            | none                                                                                                                                                                                                       | Every second. mk3d forgets FL's state after 3.5 s without any message                                                                                                                                                                           |
| `03` | SONG_POS         | `u14 bar`, `u7 step`, `u14 tick`, `u14 ppq` (bar and step 1-based; 16 steps to the bar, PPQ / 4 ticks to the step)                                                                                                                                                    | Change, at most every 50 ms                                                                                                                                                                                                                     |
| `08` | CHANNELS         | `u14 total`, `u14 offset`, `u7 n`, n × (`u7 flags`, `color`, `str name`)                                                                                                                                   | Change in the channel window. Flags: 1 selected, 2 muted, 4 solo (`channels.isChannelSolo`)                                                                                                                                                                                    |
| `09` | SELECTED_CHANNEL | `u14 index` (`none`), `color`, `norm volume`, `norm pan`, `str name`, `str plugin`                                                                                                                         | Change. `plugin` is the generator's plugin name, empty if none                                                                                                                                                                                  |
| `0A` | CHANNEL_DETAIL   | `u14 index` (`none`), `norm pitch` (pan-style, −1…1 = the channel's pitch knob as a factor of its range), `u7 pitchRange` (semitones), `norm cutoff`, `norm resonance`, `u14 mixerTrack`, `u7 channelType` | Change, for the selected channel. Cutoff and resonance are the channel's filter knobs (REC events `REC_Chan_FCut`/`FRes`); `channelType` is `channels.getChannelType`                                                                           |
| `10` | MIXER            | `u14 total`, `u14 offset`, `u7 n`, n × (`u7 flags`, `color`, `norm volume`, `norm pan`, `str name`)                                                                                                        | Change in the mixer window. `total` = `mixer.trackCount() − 1`: Master and the inserts, without FL's hidden "current" track (the last one). Flags: 1 selected, 2 muted, 4 solo, 8 armed                                                                                                                                                                         |
| `11` | SELECTED_TRACK   | `u14 index`                                                                                                                                                                                                | Change                                                                                                                                                                                                                                          |
| `12` | METERS           | `u14 offset`, `u7 n`, n × (`u7 left`, `u7 right`)                                                                                                                                                          | Only when meters are on in VIEW; at most every 50 ms. Peak 0–1 × 127, clamped                                                                                                                                                                   |
| `13` | UI_STATE         | `u7 snap` (`ui.getSnapMode()`, 0–127), `u7 visible` (bit i = `ui.getVisible(i)`: 0 mixer, 1 channel rack, 2 playlist, 3 piano roll, 4 browser), `u7 focused` (the focused window 0–4, 5 = a plugin window, 127 = none; `ui.getFocused`) | After REQUEST_STATE, on `HW_Dirty_FocusedWindow`, when the snap mode changes (checked on every service pass) and by the 100 ms re-read                                                                                                          |
| `14` | UNDO_STATE       | `u14 position` (`general.getUndoHistoryPos()`), `u14 count` (`getUndoHistoryCount()`), `str hint` (`getUndoLevelHint()`)                                                                                   | After REQUEST_STATE, after every undo, redo and batch edit (CLEAR_STEPS, paste, cut), on `HW_Dirty_Undo`, and by the 100 ms re-read; only when it changed. mk3d keeps it in FlState, logs it and shows the hint on the SHIFT + pad undo/redo card |
| `15` | PRESETS          | `u14 count`, `u14 current` (`none` = unknown), `u7 n` (≤ 8), `u14 offset`, n × `str name`                                                                                                                  | Only while VIEW has the presets flag (the BROWSER page is shown). The selected channel's plugin presets: `count` = `plugins.getPresetCount` (0 = none, no plugin, or no programs), `current` = the index whose name equals `getName(FPN_Patch)` (`none` if none does), names `offset … offset + n − 1`: after PRESET_WINDOW the offset asked for (clamped to 0…count − 8), else around `current` (`offset = clamp(current − 3, 0, count − 8)`, 0 when unknown). Sent when the selected channel or plugin changes, after PRESET_STEP, PRESET_WINDOW and PRESET_LOAD, when FL changes the preset, and when the flag turns on. Key `PRESETS` (one frame; always sent, empty with count 0) |
| `16` | MARKERS          | `u7 total`, `u7 offset`, `u7 n` (≤ 8), n × (`u21 ticks`, `str name`), `u14 ppq`                                                                                                                         | The playlist markers in time order: entries `offset … offset + n − 1` of `total` (at most 127), `ticks` = absolute ticks (`transport.getSongPos(SONGLENGTH_ABSTICKS)` units), `ppq` = `general.getRecPPQ()` ticks per quarter note, so a marker's bar is `ticks / (ppq × 4) + 1` in 4/4. Sent after a scan (below): on REQUEST_STATE, REQUEST_MARKERS, ADD_MARKER and project load. The list goes out as several messages, one per service pass (never all in one call); a list with no markers is one message with `total 0` and the PPQ. `ticks` 0x1FFFFF (the largest `u21`) = the time is unknown (mk3d: `null`; the marker has its name, no bar, and a JUMP_MARKER to it does nothing). Keys `MARKERS@offset` |
| `17` | PROBE            | `str text` (up to 100 characters, not the usual 32) | A line for mk3d's log, logged as `← FL probe: <text>`; mk3d does nothing else with it. What the script has to say that FL's own state doesn't: a call FL refused (`setPatternLength(3, 32) -> error: <message>`, the same for SET_PATTERN_COLOR, SET_LOOP and DOUBLE_PATTERN), which parameter PERFORM chose (`perform: Diva -> param 12 "VCF1: Frequency"`), and the anchor search of a plugin that reports its parameters in units (`param search …`). A line longer than 100 characters is cut at a space into several, the continuations starting with `+ `. Key `PROBE@n`, never deduplicated |
| `18` | PATTERN          | `u14 number` (1-based), `u14 count`, `u14 length` (steps), `color`, `str name`                                                                                                                             | Change                                                                                                                                                                                                                                          |
| `19` | PATTERNS         | `u14 count`, `u14 offset`, `u7 n`, n × (`u7 flags`, `color`, `str name`)                                                                                                                                   | Change in the pattern window. Offset is 0-based: entry 0 = pattern 1. Flags: 1 current                                                                                                                                                          |
| `1A` | STEP_GRID        | `u14 channel`, `u14 pattern`, `u14 offset`, `u7 n`, `u21 bits`                                                                                                                                             | Change. Steps `offset … offset + n − 1` (n ≤ 16) of the selected channel in the current pattern; bit i = step `offset + i`                                                                                                                      |
| `1B` | PATTERN_GRID | `u7 channel`, `u14 start`, `u7 n` (≤ 16), ceil(n / 7) bytes of step bits (7 to a byte: bit i of byte j = step `start + 7j + i`), `u7 flags` (bit 0 = the channel uses the step sequencer) | Only while VIEW has the patternGrid flag (the ARRANGER page is shown), for the 16 channels of the channel bank in VIEW and the whole current pattern (at most 256 steps): see "Pattern overview" below. Only chunks that changed, a few per service pass. Key `PATTERN_GRID@channel@start` |
| `26` | STEP_PARAMS      | `u14 channel`, `u14 step`, `u7 pitch`, `u7 velocity` | The answer to REQUEST_STEP_PARAMS (NOT VERIFIED in FL). |
| `1C` | LOOP_STATE       | `u7 active` (0/1), `u21 start`, `u21 end` | The song loop range = the playlist time selection: `arrangement.selectionIsActive()` and, while active, `selectionStart()` / `selectionEnd()` in ticks (NOT VERIFIED: that they are the absolute ticks MARKERS uses; `start`/`end` are 0 while inactive). Sent after REQUEST_STATE, on REQUEST_LOOP (even when unchanged), after SET_LOOP and whenever it changes: the three getters are read on every service pass, like the snap mode (key `LOOP_STATE`). mk3d keeps it in `FlState.loop`, lights RESTART bright while active and shows it on the LOOP overlay |
| `1D` | FEATURES         | `u7 missing` | Which hidden functions this FL version lacks, checked with `getattr` (key `FEATURES`, sent with the rest of the state): bit 0 = `patterns.setPatternLength`, bit 1 = `arrangement.selectionSet` or `selectionClear`. 0 = all there. mk3d then shows `Not available in this FL version` on the page and sends no SET_PATTERN_LENGTH / SET_LOOP; the script never calls a function it did not find |
| `20` | PLUGIN           | `u14 channel` (`none`), `u7 valid`, `u14 paramCount`, `str name`                                                                                                                                           | Change. The selected channel's generator. `paramCount` = index of the last named parameter + 1 (FL reports 4240 for every VST, most unnamed at the end), 0 while the script is still reading the names                                          |
| `21` | PLUGIN_PARAMS    | `u7 n`, n × (`u14 param`, `norm value`, `str name`, `str valueText`, `flag known`)                                                                                                                                       | Change in a watched parameter (see VIEW)                                                                                                                                                                                                        |
| `22` | PARAM_NAMES      | `u14 offset`, `u7 n` (≤ 8), n × `str name`                                                                                                                                                                 | After the plugin changes (and after REQUEST_STATE): the names of parameters `offset … offset + n − 1`, `""` = unnamed, for the range up to the last named parameter. Frames whose 8 names are all empty are not sent. Keys `PARAM_NAMES@offset` |
| `23` | LIVE_GRID        | `u7 scanned`, `u7 perf` | The LIVE header, only while VIEW's `liveScenes` is set (the LIVE overlay, SHIFT + SCENE, is open): `scanned` = `min(LIVE_TRACK_SCAN, playlist.trackCount())`, the playlist tracks 1…`scanned` that LIVE_TRACK rows cover (mk3d drops rows of tracks above it); `perf` = `playlist.getPerformanceModeState()` (blocks read as empty while it is off). Read (with every LIVE_TRACK row) at most every `LIVE_SECONDS` (50 ms) while watched, and at once on FL's `OnUpdateLiveMode` callback, a VIEW change or a TRIGGER_LIVE_CLIP (FL has no dirty flag for performance-mode changes, FL calls OnIdle about every 10 ms, and one read is ~200 FL calls); key `LIVE_GRID`, sent when it changed |
| `24` | ACTIVITY         | `u14 first`, `u7 n` (≤ 16), n × `u7 active` | Which channels FL is playing now: `active[i]` = `channels.getActivityLevel(first + i) > 0` (the test Image-Line's Akai Fire script uses to light its channel pads with FL's own notes). `first` = the start of the selected channel's bank of 16 (`selected − selected mod 16`, channel 0's bank when nothing is selected; group-local indices), n = the channels of that bank that exist. Read at most every `ACTIVITY_SECONDS` (40 ms) while FL plays, and after it stops while the last frame had a channel active (so a final frame clears the pads), plus every full re-read; key `ACTIVITY`, sent only when it changed. mk3d lights PAD MODE's pads with it |
| `27` | PLAYED_NOTES     | `u14 channel`, `u7 n`, n × `u7 note` | The notes of the selected channel starting now, for KEYBOARD's pads, every ACTIVITY pass while FL plays and that channel sounds. No FL call says which note plays. `channels.getGridBit` and `getCurrentStepParam` do see recorded notes (measured 2026-11-04: param 0 = pitch, param 7 = the note's absolute tick, e.g. 193 on step 8 at PPQ 96), so the script reads the steps at the song position and reports a note for half a step from its start. **Limits:** one note per step (what a chord gives is NOT VERIFIED), no note lengths, and in song mode the position is taken modulo the selected pattern's length, so a clip that starts off that grid or another pattern on the channel lights the wrong pads. |
| `25` | LIVE_TRACK       | `u14 offset`, `u7 track`, `u7 flags`, `color`, `u7 trigSnap`, `str name`, `u7 n` (≤ 16), n × (`u7 status`, `color`) | One playlist track's row of the LIVE window, sent with LIVE_GRID for each track 1…`scanned`: `track` 1-based; `flags` 1 = `isTrackMuted`, 2 = `isTrackSolo`; `color` = `getTrackColor`; `trigSnap` = `getLiveTrigSnap(track)` clamped to 0…127, as FL returns it (FL's `LiveSnap_*`: 0 off, 1 ¼ beat, 2 ½ beat, 3 1 beat, 4 2 beats, 5 4 beats, 6 auto; 5 seen on hardware 2026-10-21); `name` = `getTrackName`; block `i` is block `offset + i` (`offset` = VIEW's `liveOffset`): `status` = `getLiveBlockStatus(track, block, LB_Status_Default)` & 7 (bits 1 filled, 2 scheduled, 4 playing; the default mode is the one that tells scheduled from playing, `LB_Status_Simplest` reports both as 2), `color` = `getLiveBlockColor` for a filled block, else 0. Key `LIVE_TRACK@<track>`: only the rows that changed go out. mk3d derives a scene (a column) as the OR of its tracks' bits and the first filled track's color |

## mk3d → FL

| Cmd  | Name              | Payload                                                                                                                    | Action in FL                                                                                                                                                                      |
| ---- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `41` | REQUEST_STATE     | none                                                                                                                       | Clear the script's cache and resend HELLO and everything in view                                                                                                                  |
| `42` | VIEW              | `u14 channelOffset`, `u14 mixerOffset`, `u14 patternOffset`, `u14 stepOffset`, `u7 flags`, `u7 n`, n × `u14 param` (n ≤ 8), `u7 liveScenes`, `u14 liveOffset` | What to watch. Windows: 16 channels, 8 mixer tracks, 16 patterns, 16 steps (`stepOffset` = the STEP page × 16); plugin params listed. Flags: 1 meters, 2 presets (PRESETS is read and sent only while it is set), 4 patternGrid (PATTERN_GRID is read and sent only while it is set; `channelOffset` is the bank, `stepOffset` the page whose chunks go first). `liveScenes` = the LIVE overlay is open and watching (LIVE_GRID is then read and sent; off, it is neither); `liveOffset` = the scene (block) window start. Default before any VIEW: all offsets 0, meters, presets and patternGrid off, params 0–7, `liveScenes` off. A script older than this field ignores the trailing bytes (every payload may grow; readers stop at the fields they know) |
| `43` | SELECT_CHANNEL    | `u14 index`                                                                                                                | `channels.selectOneChannel(index)`                                                                                                                                                |
| `44` | SET_CHANNEL       | `u14 index`, `u7 what` (0 volume, 1 pan, 2 mute, 3 pitch, 4 cutoff, 5 resonance, 6 solo), `norm value`                     | `setChannelVolume` / `setChannelPan` / `muteChannel` / `setChannelPitch` (pan-style, mode 0) / filter REC events / `soloChannel`. Mute and solo: set to value > 0.5               |
| `4B` | SET_CHANNEL_TRACK | `u14 index`, `u14 track`                                                                                                   | `channels.setTargetFxTrack(index, track)`                                                                                                                                         |
| `4C` | SHOW_EDITOR       | `u14 index`                                                                                                                | `channels.showEditor(index)` (toggles the channel's plugin or sampler window)                                                                                                     |
| `45` | SET_STEP          | `u14 channel`, `u14 step`, `u7 on`                                                                                         | `channels.setGridBit(channel, step, on)`                                                                                                                                          |
| `6B` | REQUEST_STEP_PARAMS | `u14 channel`, `u14 step` | Send STEP_PARAMS (STEP's held step). |
| `6C` | SET_STEP_PARAM | `u14 channel`, `u14 step`, `u7 param` (0 pitch, 1 velocity), `u7 value` | `channels.setStepParameterByIndex` in the current pattern, no undo point (NOT VERIFIED in FL). |
| `6D` | NUDGE_PARAM | `u14 param`, `pan step` (−1…1) | Move a parameter that isn't `known` by `step` from where it really is. The script finds its 0–1 value from the value text (`find_param_norm`, `docs/bugs.md` #6). |
| `46` | SELECT_TRACK      | `u14 index`                                                                                                                | `mixer.setTrackNumber(index)`                                                                                                                                                     |
| `47` | SET_TRACK         | `u14 index`, `u7 what` (0 volume, 1 pan, 2 mute, 3 solo, 4 arm), `norm value`                                              | `setTrackVolume` / `setTrackPan` / mute, solo, arm set to value > 0.5                                                                                                             |
| `48` | SET_PARAM         | `u14 param`, `norm value`                                                                                                  | `plugins.setParamValue(value, param, selectedChannel)`                                                                                                                            |
| `49` | SELECT_PATTERN    | `u14 number` (1-based)                                                                                                     | `patterns.jumpToPattern(number)`                                                                                                                                                  |
| `4A` | UI                | `u7 action`                                                                                                                | 0 up, 1 down, 2 left, 3 right, 4 enter, 5 escape, 6 undo (`general.undoUp()`), 7 redo (`general.undoDown()`), 8 save (`globalTransport(FPT_Save, 1)`), 9 cut, 10 copy, 11 paste (the step clipboard, below), 12 quantize, 13 quantize starts (`channels.quickQuantize(selected, 0 / 1)`), 14 saveNew (`globalTransport(FPT_SaveNew, 1)`, FILE's `NEW VER`) |
| `4D` | CLONE_PATTERN     | `u14 number` (1-based)                                                                                                     | `patterns.clonePattern(number)`; if FL did not select the clone and the pattern count grew, `patterns.jumpToPattern(number + 1)`. Numbers outside 1…count are ignored             |
| `4E` | NEW_PATTERN       | none                                                                                                                       | `patterns.findFirstNextEmptyPat(midi.FFNEP_DontPromptName)`: a new empty pattern, selected by FL                                                                                  |
| `4F` | CLEAR_STEPS       | `u14 channel`                                                                                                              | One undo point (`general.saveUndo("MK3: clear steps", UF_PR)`), then `channels.setGridBit(channel, i, False)` for every step `i` of the current pattern's length (`getPatternLength`), in one callback. Nothing is read or sent until the loop is done, then the step grid and UNDO_STATE are |
| `50` | SET_TEMPO         | `u21 tempo` (BPM × 100)                                                                                                    | `general.processRECEvent(REC_Tempo, round(bpm × 1000), REC_UpdateValue \| REC_UpdateControl)`, bpm clamped to 10–522                                                              |
| `51` | SET_SWING         | `norm value`                                                                                                               | `processRECEvent(REC_MainShuffle, value × FromMIDI_Max, REC_MIDIController \| REC_UpdateControl)`                                                                                |
| `52` | SHOW_WINDOW       | `u7 window` (0–4, as in UI_STATE)                                                                                          | Window focused: `ui.hideWindow`. Else `ui.showWindow` and `ui.setFocused`, for windows 0–3 after `ui.hideWindow` if they are open behind another. Other numbers are ignored        |
| `53` | SET_SNAP          | `u7 mode`                                                                                                                  | `ui.setSnapMode(mode)` (`midi.Snap_*`)                                                                                                                                            |
| `54` | SET_MAIN_VOLUME   | `norm value`                                                                                                               | `processRECEvent(REC_MainVol, value × FromMIDI_Max, REC_MIDIController \| REC_UpdateControl)`, like SET_SWING                                                                    |
| `55` | PRESET_STEP       | `u7 dir` (0 previous, 1 next)                                                                                              | `plugins.prevPreset(selected)` / `nextPreset(selected)` on the selected channel (nothing without a plugin or presets); PRESETS follows                                            |
| `56` | JUMP_MARKER       | `u7 index`, `u7 quantized`                                                                                                 | Go to marker `index` (0-based, the list of MARKERS) with `transport.setSongPos(ticks, SONGLENGTH_ABSTICKS)`: at once, or with `quantized` 1 while FL plays, at the next bar (kept pending, run from `OnUpdateBeatIndicator` when the value is "bar"; a newer jump replaces it, a jump now cancels it). Stopped: always at once, and a pending jump runs when FL stops. An index past the list is ignored |
| `58` | SET_LOOP_MODE     | `u7 song`                                                                                                                  | `transport.setLoopMode()` (a toggle) only when `getLoopMode()` differs from 1 = song / 0 = pattern; TRANSPORT then reports the mode in flag 16                                      |
| `5A` | REQUEST_MARKERS   | none                                                                                                                       | Send MARKERS again, from a fresh scan when FL is stopped, else from the cache (and scan when FL stops). mk3d sends it when ARRANGER or SCENE opens                                   |
| `5D` | PRESET_WINDOW     | `u14 offset` | BROWSER scrolls its list: the next PRESETS carries the names `offset … offset + 7` (clamped to 0…count − 8); `current` stays the loaded preset. The window stays until a PRESET_STEP or PRESET_LOAD (then the names follow `current` again), or the channel, bank or VIEW flag changes. Ignored without presets |
| `5E` | PRESET_LOAD       | `u14 index` | BROWSER's 4D push: load preset `index` by `plugins.nextPreset` / `prevPreset(selected)` the short way round from the current preset (`\|Δ\|` calls, wrapping; at most 2 calls per service pass, so the script never stalls: `current` follows the steps and PRESETS goes out each pass). While the current preset is unknown, or for an `index` outside 0…count − 1, nothing is stepped and PRESETS is sent again so mk3d can show why. `index` = current: nothing. A new PRESET_LOAD replaces one still stepping; PRESET_STEP or another channel cancels it |
| `5F` | SET_PATTERN_LENGTH | `u7 pattern` (1-based, so at most 127), `u14 length` | `patterns.setPatternLength(pattern, length)` (official since FL 26.1, verified in steps by the owner). `length` is in the unit `getPatternLength` returns and PATTERN reports (steps in FL 26.1.5; the script divides by `STEPS_PER_UNIT`), clamped to 1…512 (32 bars); a pattern outside 1…count is ignored. Afterwards the script reads `getPatternLength` back, queues one PROBE line and re-reads PATTERN, PATTERNS and the pattern overview. Nothing is called when the function is missing (FEATURES) |
| `60` | SET_LOOP          | `u21 start`, `u21 end` | `arrangement.selectionSet(start, end)` in ticks (NOT VERIFIED: absolute ticks), or `selectionClear()` when both are 0; `end` ≤ `start` is ignored. Then it reads `selectionIsActive/Start/End` back, queues one PROBE line and LOOP_STATE follows |
| `61` | REQUEST_LOOP      | none | Send LOOP_STATE now, even if it equals the last one. mk3d sends it when the LOOP overlay opens |
| `62` | SET_PATTERN_COLOR | `u14 pattern` (1-based), `color` | `patterns.setPatternColor(pattern, color)` with the wire's `0xRRGGBB` passed through unchanged (as the script does for the colours it reads); then a read-back PROBE line and PATTERN / PATTERNS again |
| `63` | DOUBLE_PATTERN    | `u7 pattern` (1-based, at most 127) | Double the **current** pattern (another number is ignored; so is a second DOUBLE while one runs, and a length above 256 steps: PROBE `doublePattern(1) 512 -> skipped (at most 512 steps)`). `general.saveUndo("MK3: double pattern", UF_PR)` once, `patterns.setPatternLength(pattern, 2L)`, then for every channel, `DOUBLE_CHANNELS_PER_PASS` (4) channels per service pass, `getGridBit` / `setGridBit` copy steps 0…L−1 to L…2L−1 and, for the steps that are on, the step parameters 0–7 (`channels.getCurrentStepParam` / `setStepParameterByIndex`; a failing or missing function is skipped). The grid is not sent while it runs and goes out once at the end. Piano roll notes cannot be read by a script and are not copied |
| `64` | CREATE_PATTERN    | `u14 number` (1-based) | Create pattern `number` (only if it is above `patternCount`, at most 999) and select it: `patterns.jumpToPattern(number)` (creates a missing pattern, NOT VERIFIED), then `patternNumber` is read back; if it is not `number`, `findFirstNextEmptyPat(FFNEP_DontPromptName)`. PROBE `createPattern(7): jumpToPattern -> patternNumber 7, patternCount 5 -> 7` or `createPattern(7): jump left 1; findFirstNextEmptyPat -> pattern 6, count 5 -> 6` |
| `65` | STRIP             | `u7 kind` (0 pitch, 1 mod, 2 perform), `u14 value`, `u7 release` (0 or 1) | The touch strip, for the **selected channel** (raw MIDI pitch bend and CC 1 from our port do nothing in FL, and the channel cutoff does nothing for VSTs, so the strip no longer sends them). mk3d sends at most one per ~15 ms while the finger slides (the latest value wins) and always the release (`1` = the finger lifted, `value` the last one, for `perform` anything). **pitch**: `value` 0–16383, centre 8192; `channels.setChannelPitch(selected, bend, 0)` with `bend = clamp((value − 8192) / 8192, −1, 1)` (mode 0 = a factor of the pitch bend range), release → 0; the script remembers the channel the bend was set on and resets that one if the selection moved. Works for every generator. **mod**: `value` 0–127; if the plugin is a VST (`plugins.getParamCount(selected) >= 4224`; FL's wrapper has 0–4095 plugin parameters, **4096–4223 = MIDI CC 0–127**, 4224–4239 channel aftertouch) `plugins.setParamValue(value / 127, 4096 + 1, selected)`; otherwise the script does nothing and mk3d sends the raw CC 1 on MIDI channel 1 itself (mk3d decides from PLUGIN's `paramCount` >= 4224, the last named parameter + 1; the simpler of the two options, as the script cannot send MIDI into FL). The value stays after the release. **perform**: `value` 0–16383 = 0…1, a filter sweep: the script finds the plugin's **filter cutoff parameter once per (channel, plugin)** from the parameter names it already read for PARAM_NAMES (the first whose lower-case name contains `cutoff`, or contains `freq` together with `vcf`, `filter` or `flt`; Diva: `VCF1: Frequency`; only the first 4096 parameters), cached, and logs the choice as a PROBE line (`perform: Diva -> param 11 "VCF1: Frequency"`, or `perform: <plugin> -> channel cutoff`). The first non-release value of a touch remembers that parameter's current value, every value sets `value / 16383`, the release restores the remembered one (also if the selection moved meanwhile: it is restored on the channel it was taken from, and on `OnDeInit`). No parameter found (FL's own instruments), or the names not read yet: the channel cutoff (`SET_CHANNEL cutoff`'s mechanism, remembered and restored the same way). mk3d sends a release on a mode change, SHIFT, a page change, a channel change and a disconnect. NOT VERIFIED in FL: `setChannelPitch` on VSTs, the CC parameter index 4097, the cutoff name match |
| `66` | TRANSPOSE         | `u14 channel`, `s7 semitones` (−64…63) | SHIFT + pads 13–16 (±1, ±12), for the selected channel in the current pattern. One undo point (`general.saveUndo("MK3: transpose", UF_PR)`) first, then for every step that is on (`getGridBit`), `setStepParameterByIndex(channel, pattern, step, pPitch, getCurrentStepParam(channel, step, pPitch) + semitones)`, clamped to 0…127; `setGridBit` is never called. **Known bug:** on a piano roll channel FL reports the notes as grid bits, so one note per step position moves and chords can split (owner, 2026-10-19). PROBE line: `transpose(ch 6, +12): steps 3 changed` |
| `67` | PLUGIN_PICKER     | none | Open or close FL's Plugin picker: `transport.globalTransport(FPT_F8 (67), 1)`, a toggle (verified in FL 2026). No undo (FL adds its own when a channel is added) |
| `68` | UI_KEY            | `u7 key` | A plain FL key for what has the focus: 0 up, 1 down, 2 left, 3 right, 4 enter, 5 escape (`ui.up()` … `ui.escape()`). Verified in FL 2026: with the Plugin picker open, up / down / left / right browse it, enter adds the highlighted plugin as a new channel and escape closes it without adding. Unknown key: ignored |
| `6A` | TRIGGER_LIVE_CLIP | `u14 block` (`none`), `u7 release` | Fire scene `block` the way Image-Line's Akai Fire script launches one: a single `playlist.triggerLiveClip(track, block, TLC_MuteOthers \| TLC_Fill \| TLC_ColumnMode [\| TLC_GlobalSnap while `ui.getSnapMode()` is not `Snap_None`])` on the first scanned track (1…`LIVE_TRACK_SCAN`) whose `getLiveBlockStatus(track, block)` has the filled bit (checked fresh); `TLC_ColumnMode` (the stubs: "Scene mode") makes FL fire that block on every track. Nothing filled there: no call. `release` 1 (the pad came up) repeats the press's call with `TLC_Release` added, once; a release without a press does nothing. `block none` stops every scanned track instead: `triggerLiveClip(track, -1, TLC_MuteOthers \| TLC_Fill)` on each, as the Fire's track stop buttons do. A script older than `release` reads only `block`; a frame without it decodes as a press. Needs FL's performance mode on to do anything audible (LIVE_GRID's `perf`) |

**Markers (MARKERS, JUMP_MARKER, REQUEST_MARKERS).** FL has no scenes, so a
playlist marker stands for a scene or section (the SCENE overlay). The API has no marker count and no
marker time. The **count and the names** come from `getMarkerName(i)` until it is empty (0-based, at most
127, `total` is a `u7`; a diagnostic run showed it is reliable). The **times** come from a scan,
**only while FL is stopped** (a jump while playing is audible): it remembers the song position, sets it to
0, then repeats `jumpToMarker(1, False)` + `getSongPos(SONGLENGTH_ABSTICKS)` until the position stops
increasing, and puts the position back (a project without names is not scanned). A marker at tick 0 is
probed with `jumpToMarker(0, False)` first (see [fl-api-notes.md](fl-api-notes.md)). When the scan
found a different number of times than there are names the two cannot be matched up, so the names are kept
and **every time is sent as unknown** (`ticks` 0x1FFFFF) instead of guessing; no marker is invented at
tick 0. A marker AT tick 0 makes the scan one short, so such a project has unknown times (known limit; the
names still list). The list is kept
in the script and answered from the cache while FL plays; if a scan was wanted while playing, it runs when
FL stops. mk3d keeps the list in `FlState.markers` with `ppq`, finds the marker the song is in from SONG_POS
(the last marker at or before the position) and shows nothing but the notice when `total` is 0.

**Pattern overview (PATTERN_GRID, VIEW flag 4).** ARRANGER shows the current pattern as sounds × steps,
because the script API cannot see the playlist's clips outside performance mode. `getGridBit` also reports
the steps recorded notes start on (measured 2026-11-04, PLAYED_NOTES), so such a channel shows those. While VIEW has the
patternGrid flag the script reads `channels.getGridBit(channel, step)` for the 16 channels of the channel
bank (`channelOffset`; channels from 128 up get no row, `channel` is a `u7` and the same index CHANNELS
uses) and for the pattern's steps up to 256 (`patterns.getPatternLength`), in chunks of 16 steps, and sends a
chunk as PATTERN_GRID when it differs from what it sent before (the usual per-key cache). The reading is
paced: at most 4 chunks (64 `getGridBit` calls and at most 4 frames) per service pass, the chunks of the
page in VIEW's `stepOffset` first, then the other pages by distance, so a whole 16 × 256 re-read is spread
over many passes. A plan runs to its end before the 100 ms re-read starts a new one; a grid change
(SET_STEP, CLEAR_STEPS and the other batch edits, the `OnRefresh` / `OnDirtyChannel` flags that already
mark the grid) or a moved bank or page restarts it with the visible page first. When the pattern number
changes the script forgets the chunks it sent and sends every chunk of the new pattern again, after PATTERN
(mk3d clears its steps when PATTERN's number changes: chunks are never dropped otherwise, also not on a VIEW
change, so mk3d and the script agree on what was sent); the flag going on drops them too, and REQUEST_STATE.
`flags` bit 0 = the channel uses the step sequencer, from `channels.isGridBitAssigned(channel)` (the stub
only says "whether the grid bit is assigned"). NOT VERIFIED that it tells a piano roll channel from a step
channel; when the function is missing, raises or says yes the bit is 1, and mk3d shows `piano roll`, dimmed,
across the row of a channel only when it is 0. A message with more than 16 steps does not decode.

**Live grid (LIVE_GRID, VIEW's `liveScenes`/`liveOffset`, TRIGGER_LIVE_CLIP).** The LIVE overlay
(hold SHIFT + SCENE) is Maschine-scene-style clip launching on FL's playlist, using the
performance-mode functions the 2026-10-20 playlist probe found work once performance mode is
actually on (`docs/workflow.md`, "Playlist probe, 2026-10-20"): outside performance mode every
block reads as empty (`status 0`), which the overlay shows as a hint to turn it on in FL. FL's own
"scene" is a column across every track, triggered together (its manual: "any group of Clips, on
independent tracks, that can be triggered to start playing together"). The script API has it, as a
**flag** rather than a function: `TLC_ColumnMode` on `triggerLiveClip` (`midi.py`: `# scene`).
The calls are copied from Image-Line's own Akai Fire script (`device_Fire.py`, the reference for
performance mode from a controller): launch with `TLC_MuteOthers | TLC_Fill` (+ `TLC_GlobalSnap`
while FL's snap is on, + `TLC_ColumnMode` for a scene), release with the same call plus
`TLC_Release` on pad-up, stop a track with `subNum -1` and `TLC_MuteOthers | TLC_Fill`, and read
`getLiveBlockStatus` in the default mode (bits 1 filled, 2 scheduled, 4 playing). Since the LIVE screens redesign (2026-10-20) the script sends one LIVE_TRACK row per track instead of a column aggregate, so mk3d can draw the whole clip matrix and the track list. The first two
builds (2026-10-20) got this wrong: they sent flags 0 and no release, and the second one replaced
the scene flag with its own per-track fan-out after a binary diff of function names found no
"trigger scene" function — the flag was never looked for. With flags 0 the hardware log showed
clips stacking up on one track (`2110` → `2210` → `2220`, several blocks of track 1 "active" at
once, which `TLC_MuteOthers` prevents), and `LB_Status_Simplest` could not show whether any of them
was playing or only scheduled. The whole window is read at most every `LIVE_SECONDS` (50 ms) while
watched and at once on FL's `OnUpdateLiveMode` callback (no `OnRefresh` flag covers performance-mode
changes; the read is not chunked across passes); `getLiveBlockColor` only returns a real color once a
block has one set (an unset clip reads as FL's default gray). `playlist.trackCount()` gives no real
upper bound on blocks (the playlist is an open timeline), so the overlay's block window has no last
page, only a first one (block 0).

**Step clipboard (UI 9, 10, 11).** `ui.cut/copy/paste` act on whatever window has the focus, so the
script keeps its own clipboard instead. Copy (10) reads `channels.getGridBit` for every step of the
current pattern (`getPatternLength`) of the selected channel and keeps the list in the script. Paste
(11) does nothing without a clipboard, else `general.saveUndo("MK3: paste steps", UF_PR)` once and
then `setGridBit` into the selected channel of the current pattern for the first `min(clipboard
length, pattern length)` steps (on and off alike; later steps are untouched), and the grid goes out
once afterwards. Cut (9) is copy followed by CLEAR_STEPS' loop under one undo point
(`MK3: cut steps`). While such a batch runs the script's `service()` returns at once (FL may call
`OnRefresh` or `OnIdle` from inside `saveUndo`/`setGridBit`), so mk3d never sees a half-done grid.

Relative changes (knob turns) are worked out in mk3d, which knows the current value, and sent as
SET_* with an absolute value.

## Rules for the FL script

- Every callback catches its own exceptions.
- **Send only what changed.** The script keeps the last payload it sent per message key (for
  example `CHANNELS@4` for the entries starting at offset 4) and skips identical ones.
- **No bursts.** Changed messages go into a queue (a newer message with the same key replaces the
  older one) and at most 8 frames are sent per callback; the rest go out on the next `OnIdle`.
- Dirty flags in `OnRefresh`, `OnDirtyChannel`, `OnDirtyMixerTrack` and `OnProjectLoad` mark
  what to re-read; `OnIdle` also re-reads everything in view every 100 ms as a safety net.
- The plugin's parameter names are read with `plugins.getParamName` in slices of 1000 per `OnIdle`
  pass (a VST has 4240 parameters), then sent as PARAM_NAMES; the cache of that family is dropped
  whenever the selected channel, plugin name or `getParamCount` changes.
- Meters go out from `OnUpdateMeters` (the script calls `device.setHasMeters()` in `OnInit`),
  only while VIEW asks for them.

## Compatibility

Removed on 2026-11-05 without a version change (trials and commands nothing sent): BROWSER_NODE (`1E`),
ADD_MARKER (`57`), PLAYLIST_VIEW (`59`), SET_SONG_POS (`5B`), RUN_PROBE (`5C`), PICKER (`69`), FEATURES bits 2 and 3,
DOUBLE_PATTERN's trailing mode byte, UI_KEY 6, and BROWSE (`67`) became PLUGIN_PICKER without its `u7 action`. The
codes stay free. A script from before that ignores what it no longer gets, except that PLUGIN_PICKER has no payload for
it to read, so BROWSER's PLUG-INS does nothing until the script is reloaded.

LOOP_STATE (`1C`), FEATURES (`1D`), UI_KEY (`68`), SET_PATTERN_LENGTH (`5F`), SET_LOOP (`60`), REQUEST_LOOP (`61`) and
SET_PATTERN_COLOR (`62`), DOUBLE_PATTERN (`63`), CREATE_PATTERN (`64`), STRIP (`65`) and TRANSPOSE (`66`) were added without a version change: an older script ignores the commands
(PATTERN's knobs and the LOOP overlay then do nothing visible: no LOOP_STATE, so RESTART's LED stays
dim and the loop reads as off; no FEATURES, so mk3d assumes the functions exist), an older mk3d
ignores LOOP_STATE and FEATURES.

PATTERN_GRID (`1B`) and VIEW flag 4 (patternGrid) were added without a version change: an older script
ignores the flag bit it does not know and sends no PATTERN_GRID (ARRANGER then shows empty rows), an older
mk3d ignores PATTERN_GRID. MARKERS `ticks` 0x1FFFFF (unknown) is new too: an older mk3d shows such a marker
at a far bar.

MARKERS (`16`), JUMP_MARKER (`56`), SET_LOOP_MODE (`58`),
REQUEST_MARKERS (`5A`), the `s7` field and TRANSPORT's flag 16 (song mode) were added
without a version change: an older script ignores the commands (ARRANGER and SCENE then show no markers) and
sends no song-mode flag (mk3d reads pattern mode), an older mk3d ignores MARKERS and the flag.

PRESETS (`15`), PRESET_STEP (`55`), VIEW flag 2 (presets) and UI action 14 (saveNew) were added
without a version change: an older script ignores the commands and the flag bit it does not know (and
sends no PRESETS), an older mk3d ignores PRESETS. PRESET_WINDOW (`5D`) and PRESET_LOAD (`5E`) came later:
an older script ignores them, so BROWSER's cursor
scrolls through the names it has but cannot load.

TRANSPORT gained `norm swing` at the end, then `norm mainVolume` after it, and UI_STATE, UNDO_STATE,
SET_MAIN_VOLUME, SET_TEMPO, SET_SWING, SHOW_WINDOW, SET_SNAP
and the UI actions 9–13 were added without a version change (everything is additive): a receiver
reads a TRANSPORT without swing as swing 0, one without `mainVolume` as "main volume unknown", and
ignores the commands it does not know.

CHANNELS flag 4 (solo) was added without a version change: it is a new bit in an existing flags
byte, which older receivers ignore.

## Phase 4 compatibility

Version 1 sent TRANSPORT with flags only. mk3d reads tempo as 0 when it is missing.

## What is still to confirm in FL

See [fl-api-notes.md](fl-api-notes.md): the FL calls the script relies on, what it assumes and whether that has been seen.
