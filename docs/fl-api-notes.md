# FL API notes

What the FL script (`fl-script/MK3Bridge/device_MK3Bridge.py`) assumes about FL's Python API, and how much of
that has been checked. The script's commands and frames are in [sysex.md](sysex.md), FL's undocumented functions
in [fl-ilmcp.md](fl-ilmcp.md), and results from the MK3 in `PLAN.md` and [bugs.md](bugs.md).

The status of each row:

| Status | Means                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seen   | Seen in FL 2026 (26.1.5), on the MK3 or in mk3d's log, on that date                                                                                               |
| Used   | A page that depends on it works and nobody complained, but nobody looked at this detail                                                                          |
| Manual | [FL's scripting manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/midi_scripting.htm) says so (read 2026-11-05), or FL's own `midi.py` has the value. Not tried beyond what the row says |
| Stubs  | Only checked against the API stubs in `reference/FL-Studio-API-Stubs` (names, argument order, defaults, "Included since API version"), which are a third party's reading of FL |
| Open   | Neither settles it and nobody has looked. The row says what the script does meanwhile                                                                             |

Every call in the script is wrapped in try/except, and hidden or newer functions go through `getattr`. A wrong
assumption gives a wrong value, not a crash.

A full re-read is about 300 FL calls every 100 ms on FL's UI thread, counted against the fake FL. What that costs in
FL: mk3d's log says once per script load, about a minute after it (`script took … of FL's thread`).

## Position, tempo and basics

| Call                                                           | What we assume                                                                                                                                                                                  | Status                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `mixer.getCurrentTempo(True)`                                  | Whole BPM (140), not BPM × 1000 as the stubs suggest. The script reads the float version and scales anything above 1000 down to be safe                                                          | Seen 2026-10-18        |
| `transport.getSongPos(SONGLENGTH_ABSTICKS)`, `general.getRecPPQ()` | SONG_POS comes from one read of absolute ticks and the project's PPQ, so FL's bar:step:tick bases don't matter and the read can't tear                                                         | Seen 2026-11-04 (bug 1) |
| `patterns.getPatternLength(n)`                                 | Steps, though the stubs say beats: 64 for a 4-bar pattern (`STEPS_PER_UNIT = 1`)                                                                                                                | Seen 2026-10-18        |
| `getChannelColor`, `getTrackColor`, `getPatternColor`          | `0x--RRGGBB`, which is what the wire carries, so nothing is swapped (`fl_color`). The stubs say `0x--BBGGRR`; FL's own `utils.ColorToRGB` agrees with us                                         | Seen 2026-10-18        |
| `event.sysex` in `OnSysEx`                                     | Includes the `F0 … F7` framing                                                                                                                                                                  | Seen 2026-10-18        |
| `channels.selectedChannel(True)`                               | −1 when nothing is selected                                                                                                                                                                     | Stubs                  |
| `mixer.trackCount()`                                           | Counts Master and the hidden Current track, so inserts = count − 2 and the wire's total is count − 1                                                                                             | Manual                 |
| `mixer.getTrackPeaks(i, 0 / 1)`                                | 0 to 1, above when clipping (the manual's "< 1" is a slip). `enc_peak` clamps                                                                                                                    | Manual                 |
| `OnDirtyChannel(index, flag)`                                  | Two arguments in the manual (`CE_New` … `CE_Select`), one in the stubs and in what scripts define: ours takes either. If FL passed two to a one-argument function it would raise before our `try` | Manual                 |
| `device.isAssigned()`                                          | True when the linked output is there. `OnInit` says in FL's Script output when it isn't, the usual setup slip                                                                                     | Manual                 |
| `patterns.patternCount`, `isPatternDefault(n)`                 | The count is of patterns that aren't default, and they needn't be adjacent: 1 and 5 count as 2 (stubs). So the script scans `isPatternDefault` upward for the last one (`used_patterns`, at most `PATTERN_SCAN_LIMIT`, only when the count changes or `HW_Dirty_Patterns` comes). Never below the count: `jumpToPattern` creating a pattern raised it (`patternCount 3 -> 4`), maybe while the new one still counts as default. True means empty (manual; Novation's script reads it the same way) | Manual; a gap in FL: Open |
| `transport.stop()` then `transport.start()` (CC 108, RESTART)  | `start()` plays from where `stop()` leaves the position, which FL normally resets to the start                                                                                                   | Used                   |

## Channels

All channel indexes are group-local (`useGlobalIndex` stays False), except where `channels.getChannelIndex` converts one.

| Call                                                                                    | What we assume                                                                                                                                                                  | Status                                  |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `muteChannel`, `soloChannel`                                                            | Toggles, so "set to value" compares with `isChannelMuted` / `isChannelSolo` first and toggles only when needed. The manual also gives both a `value` (solo since API 30, same for the mixer's and playlist's mute and solo); compare-and-toggle works, so it stays | Seen 2026-10-19 (MUTE and SOLO)         |
| `soloChannel`                                                                           | `isChannelSolo` reflects it right away, which that compare relies on. Its effect on other channels: FL may un-solo them                                                          | Used                                    |
| `getChannelPitch(i, 0)`, `getChannelPitch(i, 2)`                                        | 0 = −1…1, 1 = semitones, 2 = the range. We clamp the pitch to −1…1, since FL may report more when automated                                                                       | Manual                                  |
| `setChannelPitch(i, value, 0)`                                                          | Applies to a VST channel, which ignores raw pitch bend from this port, so the touch strip's PITCH uses it (±2 st in the log)                                                     | Seen 2026-10-18                         |
| `device.getLinkedValue(getRecEventId(i) + REC_Chan_FCut / FRes)`                        | The filter knobs as 0–1. `processRECEvent(REC_GetValue)` read 0 for them in FL 26.1.5, so it isn't used                                                                          | Seen 2026-10-18 (the 0); reading: Used |
| `processRECEvent(id, round(value × FromMIDI_Max), REC_MIDIController)`                  | Writes a filter knob on the 0…`FromMIDI_Max` (2³⁰) scale                                                                                                                         | Used                                    |
| `showEditor(i)`                                                                         | Toggles when no value is passed, so a repeated command closes the window                                                                                                         | Seen 2026-10-19                         |
| `getTargetFxTrack`, `setTargetFxTrack(channel, track)`, `getChannelType`, `getRecEventId` | As the stubs say                                                                                                                                                                 | Stubs                                   |
| `midiNoteOn(indexGlobal, note, velocity)`, `getChannelIndex(i)`                         | PAD MODE: notes on MIDI channel 2 reach `OnNoteOn`, the converted index plays the right channel, velocity 0 = note off, root note 60 sounds right                                | Seen 2026-10-19                         |
| `getActivityLevel(i)`                                                                   | `> 0` while a channel sounds, per hit, no threshold needed                                                                                                                       | Seen 2026-10-21                         |

### The plug-in window follows the selection

SELECT_CHANNEL while a generator's window has the focus. The owner wasn't sure about this on 2026-10-18
("not sure about follow"), so all of it counts as open.

If the focus moves during a parameter name scan, mk3d's log says so once per scan (`focus moved during a parameter
scan`), which would show whether `getParamName` is what confuses this.

| Call                                                     | What we assume                                                                                                                                                                            | Status |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `ui.getFocused(midi.widPluginGenerator)`, `ui.getFocusedFormID()` | True for a generator window, and the form id is its channel rack index (−1 for an invalid plug-in; an effect's id is `(track << 6 + slot) << 16`). Whether the index is group-local isn't said | Manual |
| `OnRefresh` with `HW_Dirty_FocusedWindow`                | Delivered when the focus moves (the manual's table calls this flag "channel selection changed", which looks like a slip). `plugins.getParamName` may also fire it (NI's script says so), which would feed the bookkeeping below | Open   |
| `showEditor(i, 1)`, `showEditor(i, 0)`                   | 1 shows, 0 hides (API 3). That 1 on an open window does nothing is our reading                                                                                                             | Manual |
| `channels.focusEditor(i)`                                | Brings that window to the front                                                                                                                                                            | Manual |
| `follow_opened`, `seen_open` (ours)                      | They learn only from focus changes and SHOW_EDITOR, so a window closed with the mouse stays in the set: a later follow may skip closing it, or close one opened by hand. Accepted            | —      |

## Patterns

| Call                                                                       | What we assume                                                                                                                                                                                 | Status                                                  |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `patterns.clonePattern(number)`                                            | Takes the 1-based number the other `patterns.*` calls use (the stub only says "index of pattern"), and API v25 closes the piano roll. FL selects the clone; if not and the count grew, we select `number + 1`. The manual adds a destination since API 43, unused | Seen 2026-10-19 (duplicate works); selection: Used |
| `patterns.jumpToPattern(k)`                                                | Creates a missing pattern                                                                                                                                                                      | Seen 2026-10-18 (`patternCount 3 -> 4`)                 |
| `patterns.findFirstNextEmptyPat(FFNEP_DontPromptName)`                     | Creates and selects a new empty pattern without asking for a name, also when all have content. NEW_PATTERN and CREATE_PATTERN's fallback                                                       | Open                                                    |
| `patterns.setPatternLength(pattern, length)`                               | Steps, 1-based pattern. In the manual since API 39, which says beats, as it and the stubs do for `getPatternLength`; FL 26.1.5 counts steps                                                       | Seen 2026-10-18 (`setPatternLength(2, 33)` reads back 33) |
| `patterns.duplicatePatternData(p)`                                         | In the manual since API 45. Copies every note, piano roll notes too, and leaves the length at what the content spans, so DOUBLE sets the length afterwards                                       | Seen 2026-10-18                                         |
| `patterns.setPatternColor(pattern, color)`                                 | The wire's `0xRRGGBB` passes through unchanged, as for the colors we read                                                                                                                      | Used (PATTERN's knob 1, tried in FL)                    |
| `getGridBit` / `setGridBit` copy (DOUBLE when `duplicatePatternData` is missing) | Copies step parameters too. Adds short notes on piano roll channels, so it's only the fallback                                                                                            | Seen 2026-10-18 (the short notes)                       |

FL has no call to delete a pattern, so mk3d has no such command. `patterns.clearPattern(i)` (API 44) empties one; unused so far.

## Steps and the clipboard

| Call                                                                | What we assume                                                                                                                                                                                                               | Status                                |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `channels.setGridBit(channel, step, value)`                         | Doesn't write piano roll notes, though `getGridBit` shows them as on. What ERASE and STEP should do on recorded channels is still open                                                                                         | Seen 2026-10-18                       |
| `channels.getGridBit`, `getCurrentStepParam`                        | Also see recorded notes: pitch and tick. KEYBOARD's flashing pads depend on it (PLAYED_NOTES). Only one note per step has been checked; chords are open                                                                        | Seen 2026-11-04                       |
| `setStepParameterByIndex(channel, pattern, step, param, value)`     | TRANSPOSE writes `pPitch` of every step that is on, one undo point (`UF_PR`), and never calls `setGridBit`. **Known bug** (owner, 2026-10-19): piano roll notes count as grid bits, so it moves one note per step position and can split chords. The API can't select or move piano roll notes | Seen 2026-10-19                       |
| CLEAR_STEPS, one `setGridBit` per step in one callback              | Fast enough for a pattern of a few hundred steps; nobody has timed it                                                                                                                                                          | Seen 2026-10-19 (works); timing: Open |
| The step clipboard (ours)                                           | Copy stores the selected channel's bits for the current pattern's length; paste writes back up to the shorter length as one batch; cut is copy + clear. It lives until the script reloads. `ui.cut/copy/paste` aren't used, since they act on whatever has the focus | Seen 2026-10-19                       |
| `channels.isGridBitAssigned(channel)`                               | Tells a piano roll channel from a step channel (the stub says only "whether the grid bit is assigned"). When it's missing, raises or returns True, the flag is 1 and mk3d shows nothing special, so a wrong guess never hides steps | Open                                  |

ARRANGER's pattern overview (PATTERN_GRID, VIEW flag 4) reads `getGridBit` for 16 channels up to 256 steps, at
most 64 calls and 4 frames per pass, visible page first, so a full re-read is spread over many passes. A pattern
change forgets the sent chunks. Tried on 2026-10-18 ("its good for now!"); how long the 64 calls take is open.

## Quick edit, SHIFT + pads, NAVIGATE and GRID

The owner tried all of these on 2026-10-19, and confirmed main volume, undo and redo, clear, copy and paste by
name. The others are marked Used.

| Call                                                                                       | What we assume                                                                                                                                                         | Status                 |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `processRECEvent(REC_Tempo, round(bpm × 1000), REC_UpdateValue \| REC_UpdateControl)`       | Changes the tempo and FL's display (the stub's own example uses `REC_Control \| REC_UpdateControl`). The manual has `mixer.setCurrentTempo` since API 38; this works, so it stays | Used                   |
| `device.getLinkedValue(REC_MainShuffle)` and `REC_MIDIController \| REC_UpdateControl`      | Reads the main swing as 0–1 and writes on the 0…`FromMIDI_Max` scale, which FL maps onto the knob's whole 0–100 %. The manual has `channels.getShuffle/setShuffle` since API 42; this works, so it stays | Used                   |
| The same for `REC_MainVol`                                                                 | The toolbar's main volume, not the Master fader. A failing read leaves it out of TRANSPORT, so mk3d shows no value rather than 0                                          | Seen 2026-10-19        |
| `ui.getSnapMode`, `ui.setSnapMode(value)`                                                  | GRID sends FL's own numbers: its `midi.py` has Line 0, Cell 1, None 3, the step fractions 4–7, Step 8, the beat fractions 9–12, Beat 13, Bar 14, Events 16 and Markers 17, and no bar fractions. The stubs' clash isn't FL's. The manual's table stops at Bar, and `setSnapMode` is a plain set (API 24), `snapMode` the ±1 | Manual; each pad in FL: Open |
| `channels.quickQuantize(i, startOnly)`                                                     | 0 quantizes the whole note, 1 only its start (the stub says "???", default 1). Without a piano roll open FL may do nothing or act on the channel's current pattern           | Open                   |
| `ui.getVisible(0…4)`, `ui.getFocused(0…4)`, `ui.getFocused(5)`                             | UI_STATE. 0 mixer, 1 channel rack, 2 playlist, 3 piano roll, 4 browser. 5 is true when a plug-in window has the focus (`midi.widPlugin` only works in `ui.getFocused`)     | Manual                 |
| `ui.hideWindow`, `ui.showWindow`, `ui.setFocused`                                          | FL raises a window only when it opens it, so one open behind another is closed and reopened in one press (the F-keys take two, `setFocused` alone about three; an Image-Line forum post reports the same). The browser isn't closed first | Seen 2026-11-04 (bug 5) |
| `ui.up/down/left/right/enter/escape()`                                                     | Called with no arguments (the value argument is undocumented)                                                                                                             | Seen 2026-10-19 (the picker) |

## Undo

| Call                                                                                  | What we assume                                                                                                                                                                                                     | Status          |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `general.undoUp()`, `general.undoDown()`                                              | Undo and redo. The stubs warn that FL 21 and later may have flipped the visual order; the owner's try says the direction is right                                                                                    | Seen 2026-10-19 |
| `general.saveUndo(name, UF_PR)`, once before the first `setGridBit`                   | One undo entry per batch. Saved before the edit                                                                                                                                                                      | Seen 2026-10-19 |
| `ui.setHintMsg(name)`, with the same name                                             | FL's hint bar says what the MK3 just did                                                                                                                                                                             | Manual          |
| Nothing read during a batch (ours)                                                    | FL may call `OnRefresh` or `OnIdle` from inside `saveUndo` or `setGridBit`, so `service()` reads nothing until the batch ends and everything goes out once, never half done                                          | —               |
| `getUndoHistoryPos`, `getUndoHistoryCount`, `getUndoLevelHint`, `getUndoHistoryLast`  | UNDO_STATE sends the first three. The stub says Pos "seems to behave the same as Count" and that Last is the current position (0 = newest), while the hint is built from Last + 1 and Count. What each one means hasn't been read from a log | Open            |

## BROWSER presets and FILE

| Call                                                                     | What we assume                                                                                                                                                                                       | Status                            |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `plugins.getPresetCount`, `nextPreset`, `prevPreset`                     | Whether the count is 0 for plug-ins without programs, and whether next and previous wrap (the script assumes they do when it guesses the index after a step), is open for VST, VST3 and FL's own plug-ins | Open                              |
| `plugins.getName(i, -1, FPN_Patch)`, `FPN_Preset`                        | **Found on hardware (Diva):** for a VST, `FPN_Patch` doesn't match the preset names, but FL names the channel after the current program. The current preset is the one named like `FPN_Patch`, else like the channel, else the last guess | Seen 2026-10-18                   |
| `plugins.getName(i, -1, FPN_Preset, GPN_GetCurrentPreset)`               | The name of the current preset, per the manual. Tried third, after the patch name and the channel name, so what works on Diva can't get worse; a plug-in where those two say nothing gets the right highlight | Manual; in FL: Open               |
| `channels.getChannelName(i)` after a preset step                         | Follows the program for other plug-ins than Diva                                                                                                                                                     | Open                              |
| Reading a bank of up to `PRESET_SCAN_LIMIT` (1024) names                 | Whole, once, in one callback, cached until the channel, plug-in or count changes. Bigger banks are read only around the known index. How long it takes is open                                         | Open                              |
| `FPN_Patch` right after `nextPreset` / `prevPreset`                      | FL may rename late, so the script keeps its own index for `PRESET_SETTLE_SECONDS` after a step or load                                                                                                | Used                              |
| PRESET_LOAD, `PRESET_STEPS_PER_PASS` program changes per pass            | Steps the short way round. Whether FL takes that many VST program changes in one callback without stalling is open                                                                                    | Open                              |
| `transport.globalTransport(FPT_Save, 1)`, `FPT_SaveNew`                  | Save works. `FPT_SaveNew` saves a new version of the project                                                                                                                                          | Save: Seen 2026-10-18; new: Open  |

## Markers

FL has no scenes; a marker stands for one. The API has no marker count and no marker time.

- The **count and names** come from `arrangement.getMarkerName(i)` (0-based) until it is empty, at most 127. The
  probe showed this is reliable, while the jump scan gave unstable positions (a marker alternately at 0 and at 1158).
- The **times** come from a scan, only while FL is stopped, since a jump while playing is audible: remember the
  position, `setSongPos(0)`, then `jumpToMarker(1, False)` and `getSongPos(ABSTICKS)` until the position stops
  increasing, then restore it. A scan is wanted on REQUEST_STATE, REQUEST_MARKERS and on project load. While FL
  plays the cached list is answered and the scan runs when FL stops.
- When the scan finds a different number of times than there are names, they can't be matched, so the names are
  kept and every time is sent as unknown (`MARKER_TICKS_UNKNOWN`). A marker is never invented at tick 0, and one
  with an unknown time can't be jumped to.
- MARKERS goes out in chunks of at most 8, one per service pass.

| Call                                               | What we assume                                                                                                                                                                                                           | Status                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| `getMarkerName(i)`                                 | Lists markers by time, and an unnamed marker would end the list early                                                                                                                                                    | Seen 2026-10-18; rest Open |
| `jumpToMarker(1, False)`                           | Every marker counts, whatever its kind. It goes to the next by time and stays or wraps after the last, which ends the scan either way                                                                                    | Open                      |
| `jumpToMarker(0, False)` at position 0             | `jumpToMarker(1)` from tick 0 skips a marker AT tick 0, so this is tried first. If it stays at 0, a marker there is assumed only when `getMarkerName(n)` for the n found is not empty. A marker at tick 0 makes the scan disagree with the names, and the times are unknown | Open                      |
| `getSongPos` / `setSongPos` in pattern loop mode   | They address the pattern, so markers are probably not reached. mk3d shows what comes back. The scan gave wrong positions in pattern mode on 2026-10-18                                                                   | Seen 2026-10-18           |
| `setSongPos(ticks, SONGLENGTH_ABSTICKS)`           | Moves the position, also while playing, in the absolute ticks the markers use                                                                                                                                            | Used                      |
| `OnUpdateBeatIndicator(1)`                         | Comes at the start of a bar. JUMP_MARKER with `quantized` is held for it while playing, and runs at once when stopped. A late bar beat makes the jump late by a callback                                                  | Open                      |
| `transport.setLoopMode()`, `getLoopMode()`         | A toggle, so it's only called when `getLoopMode()` differs. 0 pattern, 1 song                                                                                                                                             | Used                      |

## The song loop

| Call                                                                                        | What we assume                                                                                                                                                                                 | Status                                                 |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `arrangement.selectionSet(start, end)`, `selectionClear()`, `selectionIsActive()`, `selectionStart()`, `selectionEnd()` | The first three are in neither the manual nor the stubs. Absolute ticks, the unit of MARKERS: the log showed `song loop: 0…1536 ticks`. `selectionClear()` for start = end = 0. Read on every pass (three cheap getters) and sent when it changed, on REQUEST_LOOP and after SET_LOOP | Seen 2026-10-18; the tap 2026-10-21; the overlay: Open |

A function that is missing is reported once in FEATURES (mk3d shows `Not available in this FL version`) and
nothing is called.

## Touch strip

| Call                                              | What we assume                                                                                                                                                       | Status                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| PITCH: `setChannelPitch`                          | See Channels                                                                                                                                                          | Seen 2026-10-18                      |
| MOD: parameter 4096 + 1 of a VST                  | FL's wrapper maps 4096–4223 to MIDI CC 0–127, so this is the mod wheel                                                                                                 | Seen 2026-10-18 ("modwheel working") |
| PERFORM: the cutoff picked by name                | A name with "cutoff", or "freq" with "vcf", "filter" or "flt" (Diva's `VCF1: Frequency`). The first try picked `CutoffSlop`; the name scoring since hasn't been tried. The choice is logged as a PROBE line | Open                                 |
| NOTES                                             | Plain notes                                                                                                                                                            | Seen 2026-10-18                      |

## Plug-in parameters

| Call                                                                  | What we assume                                                                                                                                                                                                                                 | Status                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `plugins.getParamName(i)` for every index up to `getParamCount`       | 4240 for a VST, most unnamed at the end, read in slices of `PARAM_SCAN_PER_PASS` per pass. How long a slice takes is open: lower the constant if `OnIdle` stutters                                                                                | Works; timing: Open                       |
| NICA's parameter id = the index in `plugins.getParamValue`            | Verified for Diva                                                                                                                                                                                                                                 | Seen 2026-10-18                           |
| `plugins.setParamValue`                                               | Also moves the plug-in's own GUI knob                                                                                                                                                                                                              | Seen 2026-10-18                           |
| `plugins.getParamValue` before a parameter's first set                | Gives the number in the plug-in's own units, from when the instance was loaded; `getLinkedValue` and `REC_GetValue` give the same. After one set it gives 0–1. The text is always right, so the script finds the 0–1 value from the text on the first turn ([bug 6](bugs.md)) | Measured 2026-11-04; the fix: Open        |

## LIVE (performance mode)

| Call                                                                                          | What we assume                                                                                                                                                         | Status          |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `playlist.getLiveBlockStatus(track, block, LB_Status_Default)`, `getLiveBlockColor`           | Real data only while performance mode is on; otherwise every block reads as empty. Bits 1 filled, 2 scheduled, 4 playing: 3 queued, 5 playing with a switch pending, 7 playing | Seen 2026-10-21 |
| `playlist.triggerLiveClip(track, block, TLC_MuteOthers \| TLC_Fill \| TLC_ColumnMode …)`      | As Image-Line's Akai Fire script does it, with `TLC_Release` on the pad's release: it fires the column on every track with a clip there and stops the others             | Seen 2026-10-21 |
| `playlist.getLiveTrigSnap(track)`                                                             | 5 is `LiveSnap_Four` (4 beats). The manual lists 0 off, 1 ¼ beat, 2 ½ beat, 3 1 beat, 4 2 beats, 5 4 beats, 6 auto                                                       | Seen 2026-10-21 |
| `playlist.liveDisplayZone(left, top, right, bottom, ms)`                                      | FL outlines the pads' window for 2 s when LIVE opens or moves, and a duration makes the zone temporary (manual). Our coordinates: blocks 0-based with `right` left out, tracks 1-based with `bottom` included | Open            |
| `playlist.getLiveStatus(i, mode)`                                                             | Not used. It raised "Index out of range" in our probe, which passed `LB_Status_Simplest`; the manual gives it only Default and Simple                                      | Manual          |

## The Plugin picker

`transport.globalTransport(FPT_F8, 1)` toggles FL's Plugin picker. Up and down scroll it, Enter adds the plug-in as
a new channel. Seen 2026-10-19 ([fl-ilmcp.md](fl-ilmcp.md)).

The manual also documents `ui.showPicker(mode, category)` since API 41: mode 0 the Plugin picker, 1 the Project picker;
category 0 generators or patterns, 1 effects or channels. That explains our 2026-10-19 trial, which called mode 1 and
saw patterns and channels. `showPicker(0, 0)` might open the picker on generators alone. Not tried: F8 works and toggles.

`transport.globalTransport` takes the event's `pmeFlags` in FL's own scripts and in the manual; we let it default to
`PME_System`, which has worked since the first version.

## Is it safe to edit?

The Fire triggers clips only when `event.pmeFlags & PME_System_Safe` is set, Novation's script asks
`general.safeToEdit()` (API 29) first, and the manual's flag table says critical things can't be done while a modal
window is open. Our script makes changes from `OnSysEx` without looking: what FL refuses raises, and the setter logs
it. No failure seen. mk3d's log says once per load if either ever says no (`OnSysEx while FL says it isn't safe`).

The manual spells the event's property `pmeflags`; every script of FL's reads `pmeFlags`, so ours does too.

## What the manual has that we don't use

Compared function by function on 2026-11-05: the manual lists about 355 functions in the modules we import, the
script calls about 125. Most of the rest is no use to a pad controller. These might be, the most useful first. None
has been tried.

| What it would give the MK3 | Calls | Notes |
| -------------------------- | ----- | ----- |
| FL shows what the MK3 covers: a red frame around the channel bank, the STEP page's steps and the MIXER's 8 tracks | `ui.crDisplayRect(left, top, right, bottom, ms, flags)`, `ui.miDisplayRect(first, last, ms, flags)`, `ui.scrollWindow(window, index)` to keep them in view | Almost every controller script does this, Image-Line's and the vendors'. One call when a bank moves. LIVE has it since 2026-11-05 (`liveDisplayZone`) |
| Effects on the MK3: a PLUG-IN page for mixer slots, with mix level, bypass and EQ | `plugins.*(track, slot)` (every call takes a slot), `mixer.isTrackPluginValid`, `getTrackPluginId`, `get/setPluginMixLevel` (API 37), `enableTrackSlots`, `focusEditor`, `getActiveEffectIndex`, `get/setEqGain`, `Frequency`, `Bandwidth` (API 35) | The biggest thing the API allows that mk3d doesn't do |
| Capture: what was just played becomes notes | `general.dumpScoreLog(seconds, silent)`, `clearLog` | FL's Dump score log. Maschine has nothing closer on this hardware. Novation's script calls it |
| Knob moves recorded as automation | `general.processRECEvent(id, value, REC_MIDIController)`, which includes `REC_Store`, on `getRecEventId(i) + REC_Chan_Vol` and so on, and `mixer.getTrackPluginId(t, 0) + REC_Mixer_Vol` | We set values with `setChannelVolume`, `setTrackVolume` and `setParamValue`, which may not record. Open in FL. docs/workflow.md's AUTO row |
| FPC's pads on PAD MODE or KEYBOARD: their notes and colours | `plugins.getPadInfo(i, -1, PAD_Count / PAD_Semitone / PAD_Color / PAD_Empty / PAD_Muted, pad)`, `plugins.getColor(i, -1, GC_Semitone, pad)` | Only for FPC. Novation's script calls `getPadInfo` |
| Erase a whole pattern, piano roll notes too | `patterns.clearPattern(i)` (API 44) | `setGridBit` can't reach piano roll notes |
| Other meters than 4/4 | `general.getRecPPB()` ÷ `getRecPPQ()` = the numerator, `setNumerator`, `setDenominator` (API 38) | Bars on the screens assume 4 beats |
| REC's other states | `ui.isStartOnInputEnabled`, `ui.isLoopRecEnabled`, `ui.getStepEditMode`, `OnWaitingForInput`, `FPT_WaitForInput`, `FPT_LoopRecord`, `FPT_Overdub`, `FPT_StepEdit` | FL's Rec button menu from the MK3 |
| NOTE REPEAT and ARP on FL's clock | `device.setMasterSync(1)` sends FL's MIDI clock out of the port | Worth it only if our timer ever drifts |
| Open the piano roll on the selected channel | `ui.openEventEditor(getRecEventId(i) + REC_Chan_PianoRoll, EE_PR)` | NAVIGATE's tile opens whichever channel FL last showed |
| FL's hints on a screen | `OnSendTempMsg(text, ms)`, `ui.getHintMsg()` | The manual's way to feed a controller's display. The owner's no-filler rule probably says no |
| Save state on FILE | `general.getChangedFlag()`, `getProjectTitle` (API 38) | A mark when there are unsaved changes |
| FL's own controller links | `device.linkToLastTweaked` (API 21), `findEventID`, `getLinkedValueString`, `getLinkedParamName`, `getLinkedInfo`, `HW_Dirty_RemoteLinks` | What MackieCU does; a different model from our pages |
| Pattern groups | `patterns.getActivePatternGroup`, `getPatternGroupCount`, `getPatternGroupName`, `getPatternsInGroup` (API 28) | PATTERN ignores FL's groups; nobody has asked |
| Smaller things | `patterns.getBlockSetStatus` (0 empty, 1 filled, 2 playing: a zoomed-out LIVE), `arrangement.liveSelection`, `transport.getSongLength` (LOOP's upper bound), `transport.setPlaybackSpeed`, `markerJumpJog`, `continuousMove`, `playlist.selectTool` (API 40), `incLive*`, `channels.getGridBitWithLoop`, `midi.pRepeat` (step parameter 8), renames and colours (`setChannelName`, `setChannelColor`, `mixer.setTrackName`, `setPatternName`) | |

Also from the manual, for setup rather than the MK3:

- `# supportedDevices=MK3 Bridge` in the script's header makes FL link the script to a device of that name by itself.
  The header has it since 2026-11-05. Not seen yet: try it on a machine where FL hasn't met the port, like the Windows PC.
- View → Script output → **Interpreter** runs any call by hand once a script is selected: the quickest way to settle
  an Open row above without adding code.
- A custom module's only documented place is FL's shared `Python/Lib`, which we can't write to. Scripts that keep
  modules next to `device_*.py` do exist (Novation's, Arturia's), and that's what splitting our script would rely on.
