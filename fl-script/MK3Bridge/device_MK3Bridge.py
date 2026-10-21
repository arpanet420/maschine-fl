# name=MK3 Bridge
# Bridge between FL Studio and the mk3d daemon (Maschine MK3), protocol v2 (docs/sysex.md).
#
# Notes on MIDI channel 1 pass straight through to the selected channel. Notes on MIDI channel 2
# are PAD MODE hits: the note number is a channel's group-local index and the script plays that
# channel itself. Transport commands arrive as CCs on MIDI channel 16. FL's state goes to the daemon as SysEx F0 7D 4D 33 <cmd> ... F7 and the daemon
# steers FL with SysEx commands (select, set volume/pan/mute, step grid, plugin parameter, ...).
#
# Rules (docs/sysex.md): every callback catches its own errors (an exception in a script
# callback can stall FL Studio); only changed payloads are sent; frames go through an ordered
# queue where a newer message with the same key replaces the old one, at most 8 frames per
# callback; dirty flags from OnRefresh/OnDirty*/OnProjectLoad plus a full re-read every 100 ms.
#
# The protocol codecs and the Bridge class do not depend on a running FL Studio apart from the
# built-in modules imported below, so fl-script/tests/test_bridge.py loads this file with fake
# modules. Keep this a single file: FL loads it through a symlink from its Hardware folder.
#
# FL API notes. Verified = checked against the IL-Group FL-Studio-API-Stubs clone in
# reference/FL-Studio-API-Stubs (names, argument order, defaults, "Included since API version")
# and FL's own midi.py. NOT VERIFIED = needs a live FL Studio test:
#   - mixer.getCurrentTempo(): seen in FL 26.1.5, getCurrentTempo(True) gives whole BPM (140),
#     not BPM x 1000. We read the float version and scale down anything above 1000 to be safe.
#   - transport.getSongPos(SONGLENGTH_BARS/STEPS/TICKS) bases (is the bar 1-based, is the step
#     0-based?). See SONGPOS_BAR_BASE / SONGPOS_STEP_BASE.
#   - patterns.getPatternLength is documented as "length in beats", but FL 26.1.5 returned 64 for
#     a 4-bar pattern: it is steps (STEPS_PER_UNIT = 1).
#   - plugins.getParamName for every index 0..getParamCount-1 (4240 for a VST, most unnamed at the end)
#     is read in slices of PARAM_SCAN_PER_PASS per OnIdle for PARAM_NAMES; how long a slice takes in
#     FL is NOT VERIFIED (lower the constant if OnIdle stutters).
#   - Touch strip (STRIP): all NOT VERIFIED in a live FL. channels.setChannelPitch on a VST channel
#     (FL does not apply raw pitch bend from this port, so the strip sets the channel pitch instead);
#     that parameter 4096 + 1 of a VST (FL's wrapper: 4096-4223 = MIDI CC 0-127) is the mod wheel;
#     and the PERFORM cutoff name match (a name with "cutoff", or "freq" with "vcf"/"filter"/"flt",
#     e.g. Diva's "VCF1: Frequency"; the choice is logged as a PROBE line).
#   - FL colors are 0x--BBGGRR (stubs); the wire format is 0xRRGGBB, so colors are swapped.
#   - channels.selectedChannel(True) returns -1 when nothing is selected (documented).
#   - muteChannel/muteTrack/soloTrack/armTrack are documented as toggles (the first three have
#     an optional value argument whose behaviour is not described well), so "set to value" is
#     done by comparing with the current state and toggling only when needed.
#   - general.undoUp() = undo, general.undoDown() = redo (documented as "like undo"/"like redo",
#     with a note that FL 21 and later may have flipped the visual order: undoUp could then move
#     "down" in the history list, i.e. redo). mk3d's UNDO_STATE (below) and the SHIFT + pad read-out
#     show what really happened; if the two are swapped in FL, swap them in run_ui.
#   - ui.up/down/left/right() are called without arguments (the value argument is undocumented).
#   - The event.sysex of OnSysEx includes the F0 ... F7 framing (as the v1 script assumed).
#   - Channel detail (CHANNEL_DETAIL). Verified in the stubs/midi.py: names, argument order and
#     modes of channels.getChannelPitch(index, mode) (0 = factor of range, 2 = range in semitones),
#     setChannelPitch(index, value, mode=0), getChannelType, getTargetFxTrack, setTargetFxTrack
#     (channelIndex, mixerIndex), getRecEventId, isChannelSolo, soloChannel (toggle) and
#     showEditor(index, value=-1) (toggle); midi.REC_Chan_FCut/FRes, REC_GetValue, REC_MIDIController
#     and FromMIDI_Max (2^30) exist in FL 2026's midi.py. All channel indexes are group-local
#     (useGlobalIndex stays False), like the rest of the script. NOT VERIFIED (live FL needed):
#       * the value range general.processRECEvent(id, 0, REC_GetValue) returns for the filter knobs.
#         We assume 0..FromMIDI_Max (REC_VALUE_MAX), the same scale REC_MIDIController writes use;
#         if FL answers in the control's own range the cutoff/resonance readings will be too big.
#       * writing the filter knobs with REC_MIDIController and round(value * REC_VALUE_MAX).
#       * getChannelPitch(index, 2) (stubs: "not guaranteed to be correct") and that pitch is
#         clamped to -1...1 by us (FL may report more when automated).
#       * soloChannel's effect on other channels (FL may un-solo them) and that isChannelSolo
#         reflects it right away, which the "set to value" compare relies on.
#       * showEditor toggles (no value is passed), so a repeated command closes the window.
#       * "editor follows selection" (SELECT_CHANNEL while a generator editor is focused):
#         - ui.getFocused(midi.widPluginGenerator) and ui.getFocusedFormID() (= channel rack index
#           for a generator window) behaving as the stubs say, and OnRefresh really delivering
#           midi.HW_Dirty_FocusedWindow when the focus moves.
#         - channels.showEditor(i, 1) on a window that is already open (should be a no-op) and
#           showEditor(i, 0) closing it (API v3+).
#         - channels.focusEditor(i) bringing that window to the front.
#         - follow_opened/seen_open only learn from focus changes and mk3d's SHOW_EDITOR, so a window
#           the user closes with the mouse stays in the set (stale entry): a later follow may then
#           skip closing it, or close a window that was opened by hand after all. Accepted.
#   - Pattern commands (CLONE_PATTERN, NEW_PATTERN) and CLEAR_STEPS. Verified in the stubs:
#     patterns.clonePattern(index=None) (API v25: clones the pattern at `index`, default the selected
#     one, and closes the piano roll), patterns.findFirstNextEmptyPat(flags, x=-1, y=-1) with
#     midi.FFNEP_DontPromptName, channels.setGridBit(index, position, value). NOT VERIFIED:
#       * that clonePattern takes the 1-based pattern number the other patterns.* functions use (the
#         stub only says "index of pattern");
#       * that FL selects the clone itself. If the selected pattern did not change and the pattern
#         count grew, the script jumps to number + 1 (assuming FL inserts the clone after its source);
#       * that findFirstNextEmptyPat(FFNEP_DontPromptName) creates and selects a new empty pattern
#         when every pattern has content, without asking for a name;
#       * that patterns.patternCount counts a fresh empty pattern (see "may count only patterns that
#         have content" in docs/sysex.md), which the clone fallback above relies on;
#       * CLEAR_STEPS: one setGridBit(channel, i, False) per step of getPatternLength(current) in one
#         callback (patterns are at most a few hundred steps); how long that takes in FL.
#   - PAD MODE notes (OnNoteOn/OnNoteOff on MIDI channel 2, see CHANNEL_NOTE_CHANNEL). Verified in
#     the stubs: channels.midiNoteOn(indexGlobal, note, velocity, channel=-1) (velocity 0 = note
#     off) and channels.getChannelIndex(index) (group index -> global index). Verified live in
#     FL 2026 by the owner (2026-10-19): OnNoteOn is called for notes on MIDI channel 2 from this
#     port, channels.midiNoteOn with the converted index plays the right channel, and root note 60
#     (CHANNEL_NOTE_ROOT) sounds right.
#   - CHANNELS flag 4 (solo) from channels.isChannelSolo(i); see also the soloChannel notes above.
#   - Quick edit, SHIFT + pads, NAVIGATE and GRID (SET_TEMPO, SET_SWING, SHOW_WINDOW, SET_SNAP, the
#     new UI actions, TRANSPORT swing and UI_STATE). Every call is wrapped in try/except. Names,
#     argument order and flags are verified in the stubs (ui.getVisible/getFocused/showWindow/
#     hideWindow/setFocused/getSnapMode/setSnapMode/cut/copy/paste, channels.quickQuantize(index,
#     startOnly=1), midi.REC_Tempo/REC_MainShuffle/REC_UpdateValue/REC_UpdateControl). NOT VERIFIED
#     (live FL needed):
#       * SET_TEMPO: processRECEvent(REC_Tempo, round(bpm * 1000), REC_UpdateValue | REC_UpdateControl)
#         changes the tempo and updates FL's tempo display (the stub's own example uses
#         REC_Control | REC_UpdateControl instead);
#       * swing: REC_MainShuffle is read with device.getLinkedValue like the filter knobs
#         (processRECEvent(REC_GetValue) read 0 for those in FL 26.1.5) and written with
#         REC_MIDIController | REC_UpdateControl on the 0..FromMIDI_Max scale, so we assume FL
#         maps that onto the whole 0...100 % range of the main swing knob;
#       * snap values: GRID sends the numbers of midi.__snap_modes. The stub lists Bar, Events and
#         Markers (14, 16, 17) with the same numbers as 1/6, 1/3 and 1/2 bar; mk3d uses 14/16/17
#         for Bar/Events/Markers. ui.setSnapMode(value) works through ui.snapMode(delta) in the
#         stub and may skip the "disabled" step around 2;
#       * quickQuantize's startOnly: 0 quantizes the whole note, 1 only its start (the stub says
#         "???", default 1); QUANTIZE sends 0 and QUANTIZE STARTS 1. Without a piano roll open FL
#         may do nothing or act on the channel's current pattern;
#       * cut/copy/paste no longer use ui.cut/copy/paste (they act on whatever window has the focus);
#         see "Undo, UNDO_STATE and the step clipboard" below;
#       * UI_STATE: ui.getFocused(5) is true when a plugin window has the focus (midi.widPlugin is
#         only listed for ui.getFocused in the stub); the windows 0..4 are tried first.
#       * main volume: REC_MainVol is read with device.getLinkedValue and written with
#         REC_MIDIController | REC_UpdateControl on the 0..FromMIDI_Max scale, exactly like the swing
#         (processRECEvent(REC_GetValue) may read 0), and that this is the "main volume" knob FL shows
#         in the toolbar and not the Master mixer fader. A failing read leaves mainVolume out of
#         TRANSPORT (mk3d then shows no value) instead of reporting 0.
#       * "restart" (CC 108) is stop() then start(): that start() begins playback from the
#         position stop() leaves, which FL normally resets to the start; not seen live.

# BROWSER presets (PRESETS, PRESET_STEP, the VIEW presets flag) and FILE (UI saveNew). Verified in the
# stubs: plugins.getPresetCount(index, slotIndex=-1), plugins.nextPreset/prevPreset(index, slotIndex=-1),
# plugins.getName(index, slotIndex=-1, flag=FPN_Param, paramIndex=0) with midi.FPN_Patch (3, "name of the
# patch defined by plugin?") and midi.FPN_Preset (6, "for plugins that support internal presets, the name
# of the preset at paramIndex"), and midi.FPT_Save (92) / FPT_SaveNew (93) for transport.globalTransport.
# PRESETS is only read while VIEW has the presets flag (the BROWSER page is shown). NOT VERIFIED (live FL
# needed):
#   * how FPN_Patch, FPN_Preset and getPresetCount behave for VST, VST3 and FL's own plugins: whether the
#     count is 0 for plugins without programs, whether the patch name equals one of the preset names, and
#     whether next/prevPreset wrap around at the ends (the script assumes they do when it guesses the
#     index after a step);
#   * how long reading the names of a bank takes: a bank of up to PRESET_SCAN_LIMIT (1024) presets is read
#     whole, once, in one callback (cached until the channel, plugin or count changes), and only the patch
#     name is read on later passes; for bigger banks the names are read only around the index the script
#     last knew (it starts at 0 and follows PRESET_STEP);
#   * that FL changes the patch name right after nextPreset/prevPreset; the script keeps its own index
#     PRESET_SETTLE_SECONDS after a step or load (the re-read after that checks it against FL);
#   * (hardware finding, Diva in mk3d's log) for a VST FPN_Patch does not match the preset names, but FL
#     names the channel after the VST's current program: channels.getChannelName(index) == the preset's
#     name. The current preset is therefore the one named like FPN_Patch, else like the channel, else the
#     last guess; a step from an unknown index is followed by a fresh read instead of a guess;
#   * PRESET_WINDOW / PRESET_LOAD (BROWSER's cursor and push): PRESET_LOAD steps next/prevPreset the short
#     way round from the current index, PRESET_STEPS_PER_PASS calls per service pass; whether FL
#     processes that many VST program changes in one callback without stalling is not verified;
#   * midi.FPT_SaveNew (UI saveNew) saves a new version of the project file ("save new version").

# TRANSPOSE (66, SHIFT + pads 13-16). One undo point ("MK3: transpose", UF_PR): every step that is on
# (getGridBit) of the channel gets getCurrentStepParam(channel, step, pPitch) + semitones written back
# with setStepParameterByIndex(channel, pattern, step, pPitch, value), clamped to 0...127. setGridBit is
# never called (it inserts notes on piano roll channels). KNOWN BUG (owner, 2026-10-19): FL reports
# piano roll notes as grid bits too, so on a piano roll channel this moves one note per step position
# and can split chords. The API has no way to select or move piano roll notes; the piano roll's arrow
# keys only scroll when nothing is selected (tried in f52c0b8, reverted). Left as is for now.
# Undo, UNDO_STATE and the step clipboard (all NOT VERIFIED, live FL needed). Verified in the stubs:
# general.saveUndo(undoName, flags, update=True), undoUp, undoDown, getUndoHistoryPos,
# getUndoHistoryCount, getUndoHistoryLast, getUndoLevelHint and midi.UF_* (UF_PR "piano roll,
# includes modifications to patterns"; UF_SS is the same value; UF_None "???"):
#   * every step edit of a batch (CLEAR_STEPS, paste, cut) calls general.saveUndo("MK3: <what>",
#     UF_PR) ONCE before the first setGridBit, so FL gets one undo entry instead of one per step.
#     Whether FL wants the point saved before or after the change is not known: if undo then
#     seems to lose the edit one entry late, move the call behind the loop in Bridge.batch;
#   * while a batch runs, service() reads nothing (FL may call OnRefresh/OnIdle from inside
#     saveUndo/setGridBit): the grid, the undo state and everything else are marked dirty after the
#     loop and go out once, never half done;
#   * UNDO_STATE sends position = getUndoHistoryPos(), count = getUndoHistoryCount() and the text
#     of getUndoLevelHint(). The stub says Pos "seems to behave the same as Count" and that
#     getUndoHistoryLast() is the current position (0 = newest), while the hint is built from
#     Last + 1 and Count: mk3d logs and shows all three so the owner can see which is which;
#   * the step clipboard: copy (UI 10) stores the selected channel's getGridBit for every step of
#     the current pattern (getPatternLength) in the script; paste (11) writes it back into the
#     selected channel of the current pattern, up to the shorter of the two lengths, as one batch;
#     cut (9) is copy + clear as one batch. The clipboard lives until the script is reloaded.

# ARRANGER and SCENE: playlist markers (MARKERS, JUMP_MARKER, ADD_MARKER, SET_LOOP_MODE, PLAYLIST_VIEW,
# REQUEST_MARKERS, SET_SONG_POS, TRANSPORT's song-mode flag). FL has no scenes; a marker stands for one.
# Verified in the stubs: arrangement.jumpToMarker(delta, select), getMarkerName(index) (absolute index),
# addAutoTimeMarker(time, name) (time in absolute ticks), transport.getSongPos/setSongPos(position, mode)
# with midi.SONGLENGTH_ABSTICKS (2), getLoopMode() (0 pattern, 1 song) and setLoopMode() (a toggle, no
# argument), ui.horZoom(value), ui.jog(value), general.getRecPPQ(), the OnUpdateBeatIndicator(value)
# callback (1 = bar, 2 = beat, 0 = off) and midi.UF_PLMarker (an undo flag). The API has no marker count
# and no marker time, so the list is built by SCANNING, and only while FL is stopped (a jump while playing
# is audible): remember the position, setSongPos(0), jumpToMarker(1, False) + getSongPos(ABSTICKS) until the
# position stops increasing (at most MAX_MARKERS = 127, `total` is a u7), name i = getMarkerName(i), then
# restore the position. NOT VERIFIED (live FL needed), and what the script assumes:
#   * marker kinds: every marker counts, whatever its kind (time, section, ...);
#   * index order = time order: getMarkerName(i) is the name of the i-th marker by time, and
#     jumpToMarker(1) goes to the next marker by time and stays where it is (or wraps to an earlier
#     tick) after the last one, which ends the scan either way;
#   * a jump at position 0: jumpToMarker(1, False) from tick 0 skips a marker AT tick 0, so the script first
#     tries jumpToMarker(0, False) at position 0. If that moves the position past 0 it is taken as the first
#     marker ahead; if it stays at 0, a marker at tick 0 is assumed to exist only when getMarkerName(n) for
#     the n markers found afterwards is not empty (that index would otherwise be one past the end). A marker
#     whose name is empty at tick 0 is therefore missed;
#   * the scan in pattern loop mode: getSongPos/setSongPos then address the pattern and the markers are
#     probably not reached; mk3d shows whatever comes back;
#   * setSongPos(ticks, SONGLENGTH_ABSTICKS) moves the position (also while playing) and ticks are the
#     same absolute ticks the markers use (PPQ ticks per quarter note, sent in MARKERS);
#   * JUMP_MARKER with `quantized` while playing is kept pending and run when OnUpdateBeatIndicator says
#     "bar" (1); while stopped it runs at once, also a pending one when FL stops. A bar beat that arrives
#     late makes the jump late by a callback;
#   * ADD_MARKER: saveUndo("MK3: add marker", UF_PLMarker) first, then addAutoTimeMarker(current abs
#     ticks, "MK3 n"); whether UF_PLMarker is the right undo flag for a playlist marker;
#   * SET_LOOP_MODE: setLoopMode() toggles, so it is only called when getLoopMode() differs;
#   * PLAYLIST_VIEW: ui.horZoom(delta) zooms the playlist and ui.jog(delta) scrolls it (jog is documented
#     as moving selections; moveJog or scrollWindow may be what scrolls) with the playlist focused first
#     (showWindow + setFocused when it is not); the units are not consistent.
# MARKERS goes out as chunks of at most 8, one chunk per service pass (never the whole list in one call).
# A scan is wanted on REQUEST_STATE, REQUEST_MARKERS, after ADD_MARKER and on project load; while FL plays
# the cached list is answered instead and the scan runs when FL stops.
#
# Marker names and times (the redo after the owner's hardware test): the probe showed that
# getMarkerName(i) lists the markers reliably (0-based) while the jump scan gave unstable positions (a
# marker alternately at 0 and at 1158). So the COUNT and the NAMES now come from getMarkerName(i) until it
# is empty (at most MAX_MARKERS; NOT VERIFIED: an unnamed marker would end the list early) and the scan is
# only used for the TIMES. When the scan found a different number of times than there are names, they
# cannot be matched up: the names are kept and every time is sent as unknown (MARKERS `ticks` =
# MARKER_TICKS_UNKNOWN = 0x1FFFFF, JSON null in the test vectors) instead of guessing, so a marker is
# never invented at tick 0. A marker AT tick 0 makes the scan find one time too few, so such a project
# has unknown times (names and the jump scan's probe at tick 0 can tell, but it no longer guesses). A
# marker with an unknown time cannot be jumped to (JUMP_MARKER does nothing for it).
#
# ARRANGER is the pattern overview (PATTERN_GRID 1B, VIEW flag 4 `patternGrid`): while the flag is set the
# script reads the current pattern's steps (`channels.getGridBit(channel, step)`) for the 16 channels of the
# VIEW's channel bank (channelOffset), the whole pattern up to MAX_PATTERN_STEPS = 256 steps, in chunks of
# 16 steps, and sends a chunk when it changed (the usual per-key cache: `PATTERN_GRID@channel@start`). The
# reading is paced like the parameter scan: at most PATTERN_GRID_CHUNKS_PER_PASS chunks per service pass
# (64 getGridBit calls and at most that many frames), the chunks of VIEW's step page first, so a full
# 16 x 256 re-read is spread over many passes and never comes out as a burst. A new scan starts when the
# last one is done (the 100 ms re-read just keeps it going) or restarts, visible page first, on a grid
# change (SET_STEP, a batch edit, OnRefresh/OnDirtyChannel flags that mark "grid") or a moved VIEW window.
# A pattern change (patterns.patternNumber) forgets the sent chunks, so every chunk of the new pattern is
# sent again after PATTERN (mk3d clears its steps when PATTERN's number changes); so does the flag going on.
# The channel is the same index CHANNELS and SELECTED_CHANNEL use (a `u7`: channels from 128 up get no
# row). The flags byte has bit 0 = the channel uses the step sequencer: channels.isGridBitAssigned(channel)
# (the stub says only "whether the grid bit is assigned"). NOT VERIFIED: that it tells a piano roll channel
# from a step channel. When the function is missing, raises, or returns True, the flag is 1 (mk3d then shows
# nothing special), so a wrong guess never hides steps.
#
# SET_PATTERN_LENGTH, SET_PATTERN_COLOR, SET_LOOP, REQUEST_LOOP, LOOP_STATE and FEATURES (PATTERN overlay knobs,
# the song loop). patterns.setPatternLength(pattern, length) and arrangement.selectionSet(start, end) /
# selectionClear() / selectionIsActive() are HIDDEN functions (docs/fl-ilmcp.md: found in FL 2026's
# engine; the getters answered in the owner's probe, the setters are untried), patterns.setPatternColor
# is in the stubs. Every call goes through getattr + try/except; a missing function is reported once in
# FEATURES (mk3d shows "Not available in this FL version") and nothing is called. NOT VERIFIED (live FL):
#   * setPatternLength's unit: assumed the one getPatternLength returns (steps in FL 26.1.5, see
#     STEPS_PER_UNIT), the pattern 1-based like the other patterns.* calls;
#   * selectionSet's unit: assumed absolute ticks (the unit of MARKERS), selectionStart/End read back
#     the same way; selectionClear() for start = end = 0;
#   * setPatternColor's byte order (the script passes the wire's 0xRRGGBB through unchanged, as it does
#     for the colors it reads).
# After EVERY set the script reads back and queues one PROBE frame (always, not only with MK3D_PROBE;
# mk3d logs it as `<- FL probe: ...`): `setPatternLength(3, 32) -> getPatternLength(3) = 32`,
# `selectionSet(0, 1536) -> active=1 start=0 end=1536`, `setPatternColor(3, 0xe0707a) -> getPatternColor(3)
# = 0xe0707a`, so the owner's first try shows the units. LOOP_STATE is read on every service pass (three
# cheap getters, like the snap mode) and sent when it changed, on REQUEST_LOOP and after SET_LOOP.
#
# BROWSE, UI_KEY, PICKER and BROWSER_NODE (the plug-in loader TRIAL, docs/fl-ilmcp.md): FL's script API has no
# "add plugin" call, so the BROWSER page's PLUG-INS and PICKER sources drive FL's browser (ui.navigateBrowser,
# toggleBrowserNode, selectBrowserMenuItem, previewBrowserMenuItem, closeActivePopupMenu, plain ui.up/down/...)
# and its plugin picker (ui.showPicker, hidden). One FL call per command, all through getattr + try/except; a
# missing function is reported in FEATURES (`browser`, `picker`) and in the PROBE line. After each command, on a
# later service pass (so FL has updated), the script sends BROWSER_NODE (caption, file type, popup, focus flags,
# focused form caption, hint) and one PROBE line with the same facts. NOT VERIFIED (live FL): all of it.
#
# RUN_PROBE (the playlist probe, a diagnostic; mk3d sends it only with MK3D_PROBE=1 in its environment). The script reads
# playlist.getPerformanceModeState/trackCount/getLiveStatus/getLiveBlockStatus/getLiveBlockColor/
# liveBlockNumToTime/liveTimeToBlockNum, the markers and the patterns, and sends the results as PROBE
# lines (at most 100 characters, one per service pass); mk3d only logs them. See probe_lines.

import contextlib
import math
import time
from collections import OrderedDict

import arrangement
import channels
import device
import general
import midi
import mixer
import patterns
import playlist
import plugins
import transport
import ui

PROTOCOL_VERSION = 2

SYSEX_HEADER = bytes([0xF0, 0x7D, 0x4D, 0x33])
SYSEX_END = 0xF7

# FL -> mk3d
CMD_HELLO = 0x01
CMD_TRANSPORT = 0x02
CMD_SONG_POS = 0x03
CMD_GOODBYE = 0x04
CMD_ALIVE = 0x05
CMD_CHANNELS = 0x08
CMD_SELECTED_CHANNEL = 0x09
CMD_CHANNEL_DETAIL = 0x0A
CMD_MIXER = 0x10
CMD_SELECTED_TRACK = 0x11
CMD_METERS = 0x12
CMD_UI_STATE = 0x13
CMD_UNDO_STATE = 0x14
CMD_PRESETS = 0x15
CMD_MARKERS = 0x16
CMD_PROBE = 0x17
CMD_PATTERN = 0x18
CMD_PATTERNS = 0x19
CMD_STEP_GRID = 0x1A
CMD_PATTERN_GRID = 0x1B
CMD_LOOP_STATE = 0x1C
CMD_FEATURES = 0x1D
CMD_BROWSER_NODE = 0x1E
CMD_PLUGIN = 0x20
CMD_PLUGIN_PARAMS = 0x21
CMD_PARAM_NAMES = 0x22
CMD_LIVE_GRID = 0x23
CMD_ACTIVITY = 0x24
CMD_LIVE_TRACK = 0x25

# mk3d -> FL
CMD_REQUEST_STATE = 0x41
CMD_VIEW = 0x42
CMD_SELECT_CHANNEL = 0x43
CMD_SET_CHANNEL = 0x44
CMD_SET_STEP = 0x45
CMD_SELECT_TRACK = 0x46
CMD_SET_TRACK = 0x47
CMD_SET_PARAM = 0x48
CMD_SELECT_PATTERN = 0x49
CMD_UI = 0x4A
CMD_SET_CHANNEL_TRACK = 0x4B
CMD_SHOW_EDITOR = 0x4C
CMD_CLONE_PATTERN = 0x4D
CMD_NEW_PATTERN = 0x4E
CMD_CLEAR_STEPS = 0x4F
CMD_SET_TEMPO = 0x50
CMD_SET_SWING = 0x51
CMD_SHOW_WINDOW = 0x52
CMD_SET_SNAP = 0x53
CMD_SET_MAIN_VOLUME = 0x54
CMD_PRESET_STEP = 0x55
CMD_JUMP_MARKER = 0x56
CMD_ADD_MARKER = 0x57
CMD_SET_LOOP_MODE = 0x58
CMD_PLAYLIST_VIEW = 0x59
CMD_REQUEST_MARKERS = 0x5A
CMD_SET_SONG_POS = 0x5B
CMD_RUN_PROBE = 0x5C
CMD_PRESET_WINDOW = 0x5D
CMD_PRESET_LOAD = 0x5E
CMD_SET_PATTERN_LENGTH = 0x5F
CMD_SET_LOOP = 0x60
CMD_REQUEST_LOOP = 0x61
CMD_SET_PATTERN_COLOR = 0x62
CMD_DOUBLE_PATTERN = 0x63
CMD_CREATE_PATTERN = 0x64
CMD_STRIP = 0x65
CMD_TRANSPOSE = 0x66
CMD_BROWSE = 0x67
CMD_UI_KEY = 0x68
CMD_PICKER = 0x69
CMD_TRIGGER_LIVE_CLIP = 0x6A

CONTROL_CHANNEL = 15  # MIDI channel 16, zero-based
CHANNEL_NOTE_CHANNEL = 1  # MIDI channel 2, zero-based: PAD MODE hits, note = group-local channel index
CHANNEL_NOTE_ROOT = 60  # the note every channel is played at (verified in FL 2026)

FLAG_PLAYING = 0x01
FLAG_RECORDING = 0x02
FLAG_METRONOME = 0x04
FLAG_COUNT_IN = 0x08
FLAG_SONG_MODE = 0x10  # the loop mode is song (transport.getLoopMode() == 1)

CHANNEL_FLAG_SELECTED = 0x01
CHANNEL_FLAG_MUTED = 0x02
CHANNEL_FLAG_SOLO = 0x04

NONE_INDEX = 0x3FFF
NORM_MAX = 16383
MAX_STRING = 32
MAX_PROBE_TEXT = 100  # characters per PROBE frame
PROBE_BLOCKS = 16  # live blocks / bars the playlist probe reads
PROBE_TRACKS = 12  # playlist tracks the probe reads (1-based, as FL numbers them)
PROBE_MARKERS = 16
PROBE_PATTERNS = 8
MAX_LIST_ENTRIES = 4  # entries per frame
MAX_FRAMES_PER_CALLBACK = 8

CHANNEL_WINDOW = 16
MIXER_WINDOW = 8
PATTERN_WINDOW = 16
STEP_WINDOW = 16
MAX_WATCHED_PARAMS = 8
MAX_PARAM_NAMES = 8  # names per PARAM_NAMES frame
MAX_PRESET_NAMES = 8  # names per PRESETS frame
PRESET_SCAN_LIMIT = 1024  # banks up to this size are read whole (once) to find the current preset
PRESET_STEPS_PER_PASS = 2  # next/prevPreset calls of a PRESET_LOAD per service pass (the script must not stall)
PRESET_SETTLE_SECONDS = 0.3  # after a step or load the script keeps its own index this long, then reads FL again
MAX_MARKERS = 127  # MARKERS `total` is a u7
MARKER_TICKS_UNKNOWN = 0x1FFFFF  # MARKERS `ticks` (the largest u21): the time could not be worked out
MARKERS_PER_FRAME = 8
PLAYLIST_WINDOW = 2  # ui.showWindow(2) / ui.getFocused(2): the playlist
PLAYLIST_VIEW_WHAT = ("zoom", "scroll")
VIEW_FLAG_METERS = 0x01
VIEW_FLAG_PRESETS = 0x02
VIEW_FLAG_PATTERN_GRID = 0x04
PATTERN_GRID_FLAG_STEP_SEQUENCER = 0x01
PATTERN_GRID_STEPS = 16  # steps per PATTERN_GRID frame
MAX_PATTERN_STEPS = 256  # steps of a pattern the overview reads (16 pages of 16)
MAX_PATTERN_GRID_CHANNEL = 127  # PATTERN_GRID names the channel with a u7
MAX_LIVE_BLOCKS = 16  # blocks per LIVE_GRID frame (the LIVE overlay's pad bank)
# LB_Status_Default bits of playlist.getLiveBlockStatus (the stubs' table; FL's own Akai Fire
# script reads the same bits): filled, scheduled (waiting for its trigger snap), playing.
LIVE_FILLED = 1
LIVE_SCHEDULED = 2
LIVE_PLAYING = 4
LIVE_TRACK_FLAG_MUTED = 0x01
LIVE_TRACK_FLAG_SOLO = 0x02
# Playlist tracks (1-based) LIVE_TRACK reports, one row each, and STOP stops; a press picks the
# first of them that is filled at the block as the clip it hands FL's scene trigger.
LIVE_TRACK_SCAN = 8
# playlist.triggerLiveClip flags (FL's midi.py; the stubs leave most undocumented). A scene is a
# flag, not a separate call: TLC_ColumnMode ("scene") on one clip makes FL fire that block on
# every track. Image-Line's Akai Fire script launches with MuteOthers | Fill (+ GlobalSnap while
# FL's snap is on, + ColumnMode for a scene), and sends the same call with TLC_Release when the
# pad comes up; the LIVE overlay does exactly that.
TLC_MUTE_OTHERS = getattr(midi, "TLC_MuteOthers", 1)
TLC_FILL = getattr(midi, "TLC_Fill", 1 << 1)
TLC_GLOBAL_SNAP = getattr(midi, "TLC_GlobalSnap", 1 << 3)
TLC_RELEASE = getattr(midi, "TLC_Release", 1 << 5)
TLC_COLUMN_MODE = getattr(midi, "TLC_ColumnMode", 1 << 7)
SNAP_NONE = getattr(midi, "Snap_None", 3)
MAX_PATTERN_LENGTH_STEPS = 512  # SET_PATTERN_LENGTH and DOUBLE_PATTERN: 32 bars of 16 steps
MAX_PATTERN_NUMBER = 999  # CREATE_PATTERN: FL's highest pattern number
DOUBLE_CHANNELS_PER_PASS = 4  # channels DOUBLE_PATTERN copies per service pass (the script must not stall)
STEP_PARAMS = (0, 1, 2, 3, 4, 5, 6, 7)  # midi.pPitch ... pShift: pitch, velocity, release, fine pitch, pan, mod X/Y, shift
MAX_LENGTH_PATTERN = 127  # SET_PATTERN_LENGTH names the pattern with a u7
FEATURE_MISSING_PATTERN_LENGTH = 0x01  # FEATURES bits: the hidden function is not in this FL
FEATURE_MISSING_LOOP = 0x02
FEATURE_MISSING_BROWSER = 0x04  # any browser function of the plug-in loader trial
FEATURE_MISSING_PICKER = 0x08  # ui.showPicker
# Plug-in loader trial (docs/sysex.md, docs/fl-ilmcp.md): BROWSE / UI_KEY / PICKER and BROWSER_NODE. NOT VERIFIED.
BROWSE_ACTIONS = ("show", "next", "prev", "toggle", "menu", "preview", "load", "itemMenu", "pluginPicker")
UI_KEYS = ("up", "down", "left", "right", "enter", "escape", "closePopup")
BROWSER_FUNCTIONS = (  # the ui functions the browser actions use; one missing = FEATURES `browser`
    "navigateBrowser",
    "toggleBrowserNode",
    "selectBrowserMenuItem",
    "previewBrowserMenuItem",
    "closeActivePopupMenu",
    "isInPopupMenu",
    "getFocusedNodeCaption",
    "getFocusedNodeFileType",
)
NODE_TEXT = 40  # BROWSER_NODE strings are cut to this many characters
NODE_TYPE_BIAS = 8192  # fileType travels as fileType + 8192 in a u14
NODE_NEXT = 41  # ui.navigateBrowser directions
NODE_PREV = 40
PICKER_NO_MODE = -1
PATTERN_GRID_CHUNKS_PER_PASS = 4  # chunks (of 16 steps of one channel) read and queued per service pass
PARAM_SCAN_PER_PASS = 1000  # getParamName calls per service pass; FL reports 4240 for every VST

FULL_REREAD_SECONDS = 0.1
SONG_POS_SECONDS = 0.05
ALIVE_SECONDS = 1.0  # mk3d treats FL as gone after 3.5 s of silence
METERS_SECONDS = 0.05
# FL calls OnIdle about every 10 ms (NI's Komplete Kontrol script counts "every 3 OnIdle calls
# (~30ms)"), and a LIVE read is ~200 FL calls: read LIVE and ACTIVITY at most this often between
# FL's own OnUpdateLiveMode callbacks, VIEW changes and triggers (which mark them at once).
LIVE_SECONDS = 0.05
ACTIVITY_SECONDS = 0.04

TEMPO_SCALE = 1000.0  # applied only when getCurrentTempo() reports more than 1000 (BPM x 1000)
SONGPOS_BAR_BASE = 0  # added to getSongPos(SONGLENGTH_BARS) (NOT VERIFIED)
SONGPOS_STEP_BASE = 1  # added to getSongPos(SONGLENGTH_STEPS) (NOT VERIFIED)
STEPS_PER_UNIT = 1  # getPatternLength is already in steps (verified in FL 26.1.5)

# Filter knobs are read and written as REC events on this 0..REC_VALUE_MAX scale (see header).
REC_VALUE_MAX = getattr(midi, "FromMIDI_Max", 1 << 30)

# Song positions and marker times are absolute ticks.
SONGLENGTH_ABSTICKS = getattr(midi, "SONGLENGTH_ABSTICKS", 2)
DEFAULT_PPQ = 96

STRIP_KINDS = ("pitch", "mod", "perform")
VST_CC_PARAM_BASE = 4096  # FL's VST wrapper: parameters 4096-4223 are MIDI CC 0-127
VST_CC_PARAM_COUNT = 4224  # a plugin with fewer parameters has no CC parameters
STRIP_MOD_CC = 1  # the mod wheel
STRIP_MOD_MAX = 127
STRIP_VALUE_MAX = 16383
PERFORM_SCAN_LIMIT = 4096  # the plugin's own parameters (the CC/aftertouch ones after that are not filters)
PERFORM_SKIP_WORDS = ("slop", "mod", "depth", "env", "key", "lfo", "amount", "drift", "fm")
PERFORM_FILTER_WORDS = ("vcf", "filter", "flt")

CHANNEL_WHAT = ("volume", "pan", "mute", "pitch", "cutoff", "resonance", "solo")
TRACK_WHAT = ("volume", "pan", "mute", "solo", "arm")
UI_ACTIONS = (
    "up",
    "down",
    "left",
    "right",
    "enter",
    "escape",
    "undo",
    "redo",
    "save",
    "cut",
    "copy",
    "paste",
    "quantize",
    "quantizeStarts",
    "saveNew",
)

UI_WINDOW_COUNT = 5  # mixer, channel rack, playlist, piano roll, browser (ui.getVisible(0..4))
FOCUS_PLUGIN = 5  # UI_STATE focused: a plugin window (ui.getFocused(5))
FOCUS_NONE = 127  # UI_STATE focused: none of them
TEMPO_MIN = 10  # BPM
TEMPO_MAX = 522

def _undo_flags():
    """The flags of the undo points the script saves: pattern changes (midi.UF_PR, = UF_SS)."""
    return getattr(midi, "UF_PR", 2)


_logged_errors = set()


def _log(*parts):
    print("MK3 Bridge:", *parts)


def _log_once(where, error):
    """Log an error the first time only, so a persistent failure does not flood FL's console."""
    key = (where, repr(error))
    if key in _logged_errors:
        return
    if len(_logged_errors) > 200:
        _logged_errors.clear()
    _logged_errors.add(key)
    _log(where, "failed:", error)


# ---------------------------------------------------------------------------------------------
# Field codecs (pure)
# ---------------------------------------------------------------------------------------------


def _round(x):
    """floor(x + 0.5), same as the TypeScript side (Python's round() rounds half to even)."""
    x = float(x)
    if x != x:  # NaN
        return 0
    if x in (float("inf"), float("-inf")):
        return 1 << 30 if x > 0 else -(1 << 30)
    return int(math.floor(x + 0.5))


def _clamp_int(x, maximum):
    return min(maximum, max(0, _round(x)))


def perform_score(name):
    """How likely a plugin parameter is the main filter cutoff (0 = not at all). The owner's Diva
    matched "CutoffSlop" (cutoff drift) by plain substring; prefer a filter's frequency or a plain
    cutoff, and skip modulation amounts, envelopes, key follow, drift and second filters."""
    lower = name.lower()
    if not lower or any(word in lower for word in PERFORM_SKIP_WORDS):
        return 0
    filtered = any(word in lower for word in PERFORM_FILTER_WORDS)
    second = any(tag in lower for tag in ("2", " b", "hpf", "highpass", "high pass"))
    if filtered and ("freq" in lower or "cutoff" in lower):
        score = 4
    elif lower.strip() in ("cutoff", "frequency", "freq", "filter cutoff", "filter frequency"):
        score = 3
    elif "cutoff" in lower:
        score = 2
    else:
        return 0
    return score - (1 if second else 0)


def _clamp01(x):
    x = float(x)
    if x != x or x <= 0:  # NaN or negative
        return 0.0
    return 1.0 if x > 1 else x


def enc_u7(value):
    return bytes([_clamp_int(value, 0x7F)])


def enc_u14(value):
    v = _clamp_int(value, 0x3FFF)
    return bytes([v >> 7, v & 0x7F])


def enc_u21(value):
    v = _clamp_int(value, 0x1FFFFF)
    return bytes([v >> 14, (v >> 7) & 0x7F, v & 0x7F])


def enc_index(value):
    """u14, or the none value for None."""
    return enc_u14(NONE_INDEX if value is None else value)


def enc_flag(on):
    return enc_u7(1 if on else 0)


def enc_norm(value):
    return enc_u14(_round(_clamp01(value) * NORM_MAX))


def enc_pan(value):
    """Pan -1...1 is sent as a norm of (pan + 1) / 2."""
    return enc_norm((float(value) + 1.0) / 2.0)


def enc_peak(value):
    return enc_u7(_round(_clamp01(value) * 127))


def enc_color(value):
    c = int(value) & 0xFFFFFF
    return bytes([(c >> 21) & 0x7F, (c >> 14) & 0x7F, (c >> 7) & 0x7F, c & 0x7F])


def enc_str(value, limit=MAX_STRING):
    # Cut to 32 characters first, then drop control characters (same order as sysex.ts).
    chars = [ch for ch in str(value)[:limit] if ord(ch) >= 0x20 and ord(ch) != 0x7F]
    out = bytearray()
    for b in "".join(chars).encode("utf-8"):
        if b < 0x7F:
            out.append(b)
        else:
            out.append(0x7F)
            out.append(b & 0x7F)
    out.append(0)
    return bytes(out)


def enc_list(entries, write):
    entries = list(entries)[:127]
    out = bytearray(enc_u7(len(entries)))
    for entry in entries:
        out += write(entry)
    return bytes(out)


def frame(command, payload=b""):
    return SYSEX_HEADER + bytes([command]) + bytes(payload) + bytes([SYSEX_END])


def encode(message):
    """Encode an FL -> mk3d message (same dict shapes as test/fixtures/sysex-vectors.json)."""
    kind = message["type"]
    if kind == "hello":
        return frame(CMD_HELLO, enc_u7(message["version"]))
    if kind == "goodbye":
        return frame(CMD_GOODBYE)
    if kind == "alive":
        return frame(CMD_ALIVE)
    if kind == "transport":
        s = message["state"]
        flags = (
            (FLAG_PLAYING if s["playing"] else 0)
            | (FLAG_RECORDING if s["recording"] else 0)
            | (FLAG_METRONOME if s["metronome"] else 0)
            | (FLAG_COUNT_IN if s["countIn"] else 0)
            | (FLAG_SONG_MODE if s.get("songMode") else 0)
        )
        payload = enc_u7(flags) + enc_u21(float(message["tempo"]) * 100) + enc_norm(message.get("swing", 0.0))
        if message.get("mainVolume") is not None:  # left out when FL could not be asked
            payload += enc_norm(message["mainVolume"])
        return frame(CMD_TRANSPORT, payload)
    if kind == "songPos":
        return frame(
            CMD_SONG_POS, enc_u14(message["bar"]) + enc_u7(message["step"]) + enc_u14(message["tick"])
        )
    if kind == "channels":
        return frame(
            CMD_CHANNELS,
            enc_u14(message["total"])
            + enc_u14(message["offset"])
            + enc_list(
                message["entries"],
                lambda e: enc_u7(
                    (CHANNEL_FLAG_SELECTED if e["selected"] else 0)
                    | (CHANNEL_FLAG_MUTED if e["muted"] else 0)
                    | (CHANNEL_FLAG_SOLO if e["solo"] else 0)
                )
                + enc_color(e["color"])
                + enc_str(e["name"]),
            ),
        )
    if kind == "selectedChannel":
        return frame(
            CMD_SELECTED_CHANNEL,
            enc_index(message["index"])
            + enc_color(message["color"])
            + enc_norm(message["volume"])
            + enc_pan(message["pan"])
            + enc_str(message["name"])
            + enc_str(message["plugin"]),
        )
    if kind == "channelDetail":
        return frame(
            CMD_CHANNEL_DETAIL,
            enc_index(message["index"])
            + enc_pan(message["pitch"])
            + enc_u7(message["pitchRange"])
            + enc_norm(message["cutoff"])
            + enc_norm(message["resonance"])
            + enc_u14(message["mixerTrack"])
            + enc_u7(message["channelType"]),
        )
    if kind == "mixer":
        return frame(
            CMD_MIXER,
            enc_u14(message["total"])
            + enc_u14(message["offset"])
            + enc_list(
                message["entries"],
                lambda e: enc_u7(
                    (1 if e["selected"] else 0)
                    | (2 if e["muted"] else 0)
                    | (4 if e["solo"] else 0)
                    | (8 if e["armed"] else 0)
                )
                + enc_color(e["color"])
                + enc_norm(e["volume"])
                + enc_pan(e["pan"])
                + enc_str(e["name"]),
            ),
        )
    if kind == "selectedTrack":
        return frame(CMD_SELECTED_TRACK, enc_u14(message["index"]))
    if kind == "uiState":
        bits = 0
        for i, on in enumerate(list(message["visible"])[:UI_WINDOW_COUNT]):
            if on:
                bits |= 1 << i
        return frame(CMD_UI_STATE, enc_u7(message["snap"]) + enc_u7(bits) + enc_u7(message["focused"]))
    if kind == "undoState":
        return frame(
            CMD_UNDO_STATE, enc_u14(message["position"]) + enc_u14(message["count"]) + enc_str(message["hint"])
        )
    if kind == "presets":
        names = list(message["names"])[:MAX_PRESET_NAMES]
        return frame(
            CMD_PRESETS,
            enc_u14(message["count"])
            + enc_index(message["current"])
            + enc_u7(len(names))
            + enc_u14(message["offset"])
            + b"".join(enc_str(name) for name in names),
        )
    if kind == "markers":
        return frame(
            CMD_MARKERS,
            enc_u7(message["total"])
            + enc_u7(message["offset"])
            + enc_list(
                message["entries"],
                lambda e: enc_u21(MARKER_TICKS_UNKNOWN if e["ticks"] is None else e["ticks"]) + enc_str(e["name"]),
            )
            + enc_u14(message["ppq"]),
        )
    if kind == "loopState":
        return frame(
            CMD_LOOP_STATE,
            enc_flag(message["active"]) + enc_u21(message["start"]) + enc_u21(message["end"]),
        )
    if kind == "features":
        missing = (
            (FEATURE_MISSING_PATTERN_LENGTH if message["patternLength"] else 0)
            | (FEATURE_MISSING_LOOP if message["loop"] else 0)
            | (FEATURE_MISSING_BROWSER if message.get("browser") else 0)
            | (FEATURE_MISSING_PICKER if message.get("picker") else 0)
        )
        return frame(CMD_FEATURES, enc_u7(missing))
    if kind == "browserNode":
        flags = (
            (1 if message["popup"] else 0)
            | (2 if message["browserFocused"] else 0)
            | (4 if message["otherFormFocused"] else 0)
        )
        return frame(
            CMD_BROWSER_NODE,
            enc_str(message["caption"], NODE_TEXT)
            + enc_u14(max(0, min(0x3FFF, message["fileType"] + NODE_TYPE_BIAS)))
            + enc_u7(flags)
            + enc_str(message["formCaption"], NODE_TEXT)
            + enc_str(message["hint"], NODE_TEXT),
        )
    if kind == "probe":
        return frame(CMD_PROBE, enc_str(message["text"], MAX_PROBE_TEXT))
    if kind == "meters":
        return frame(
            CMD_METERS,
            enc_u14(message["offset"])
            + enc_list(message["peaks"], lambda p: enc_peak(p[0]) + enc_peak(p[1])),
        )
    if kind == "pattern":
        return frame(
            CMD_PATTERN,
            enc_u14(message["number"])
            + enc_u14(message["count"])
            + enc_u14(message["length"])
            + enc_color(message["color"])
            + enc_str(message["name"]),
        )
    if kind == "patterns":
        return frame(
            CMD_PATTERNS,
            enc_u14(message["count"])
            + enc_u14(message["offset"])
            + enc_list(
                message["entries"],
                lambda e: enc_u7(1 if e["current"] else 0) + enc_color(e["color"]) + enc_str(e["name"]),
            ),
        )
    if kind == "stepGrid":
        bits = 0
        for i, on in enumerate(list(message["steps"])[:STEP_WINDOW]):
            if on:
                bits |= 1 << i
        return frame(
            CMD_STEP_GRID,
            enc_u14(message["channel"])
            + enc_u14(message["pattern"])
            + enc_u14(message["offset"])
            + enc_u7(len(message["steps"]))
            + enc_u21(bits),
        )
    if kind == "patternGrid":
        steps = list(message["steps"])[:PATTERN_GRID_STEPS]
        payload = enc_u7(message["channel"]) + enc_u14(message["start"]) + enc_u7(len(steps))
        for first in range(0, len(steps), 7):
            bits = 0
            for i, on in enumerate(steps[first : first + 7]):
                if on:
                    bits |= 1 << i
            payload += bytes([bits])
        flags = PATTERN_GRID_FLAG_STEP_SEQUENCER if message["stepSequencer"] else 0
        return frame(CMD_PATTERN_GRID, payload + enc_u7(flags))
    if kind == "plugin":
        return frame(
            CMD_PLUGIN,
            enc_index(message["channel"])
            + enc_flag(message["valid"])
            + enc_u14(message["paramCount"])
            + enc_str(message["name"]),
        )
    if kind == "pluginParams":
        return frame(
            CMD_PLUGIN_PARAMS,
            enc_list(
                message["params"],
                lambda p: enc_u14(p["index"])
                + enc_norm(p["value"])
                + enc_str(p["name"])
                + enc_str(p["valueText"]),
            ),
        )
    if kind == "paramNames":
        return frame(CMD_PARAM_NAMES, enc_u14(message["offset"]) + enc_list(message["names"], enc_str))
    if kind == "activity":
        return frame(CMD_ACTIVITY, enc_u14(message["first"]) + enc_list(message["active"], enc_flag))
    if kind == "liveGrid":
        return frame(CMD_LIVE_GRID, enc_u7(message["scanned"]) + enc_flag(message["perf"]))
    if kind == "liveTrack":
        blocks = list(message["blocks"])[:MAX_LIVE_BLOCKS]
        flags = (LIVE_TRACK_FLAG_MUTED if message["muted"] else 0) | (LIVE_TRACK_FLAG_SOLO if message["solo"] else 0)
        return frame(
            CMD_LIVE_TRACK,
            enc_u14(message["offset"])
            + enc_u7(message["track"])
            + enc_u7(flags)
            + enc_color(message["color"])
            + enc_u7(message["trigSnap"])
            + enc_str(message["name"])
            + enc_list(blocks, lambda b: enc_u7(b["status"]) + enc_color(b["color"])),
        )
    raise ValueError("unknown message type: %r" % (kind,))


class _Reader(object):
    """Reads fields from a payload. Raises ValueError when it is too short or not 7-bit."""

    def __init__(self, payload):
        self.payload = payload
        self.pos = 0

    def u7(self):
        if self.pos >= len(self.payload):
            raise ValueError("truncated payload")
        b = self.payload[self.pos]
        self.pos += 1
        if b > 0x7F:
            raise ValueError("non 7-bit byte")
        return b

    def u14(self):
        hi = self.u7()
        return (hi << 7) | self.u7()

    def u21(self):
        hi = self.u7()
        mid = self.u7()
        return (hi << 14) | (mid << 7) | self.u7()

    def s7(self):
        return self.u7() - 64

    def norm(self):
        return self.u14() / float(NORM_MAX)


def decode(data):
    """Decode an mk3d -> FL frame into a dict, or None for anything that is not a known command.

    Extra bytes after the known fields are ignored (the protocol allows appending fields).
    """
    data = bytes(data)
    if data[-1:] == bytes([SYSEX_END]):
        data = data[:-1]
    if len(data) < len(SYSEX_HEADER) + 1 or not data.startswith(SYSEX_HEADER):
        return None
    command = data[len(SYSEX_HEADER)]
    r = _Reader(data[len(SYSEX_HEADER) + 1 :])
    try:
        if command == CMD_REQUEST_STATE:
            return {"type": "requestState"}
        if command == CMD_VIEW:
            message = {
                "type": "view",
                "channelOffset": r.u14(),
                "mixerOffset": r.u14(),
                "patternOffset": r.u14(),
                "stepOffset": r.u14(),
            }
            flags = r.u7()
            count = r.u7()
            message["meters"] = bool(flags & VIEW_FLAG_METERS)
            message["presets"] = bool(flags & VIEW_FLAG_PRESETS)
            message["patternGrid"] = bool(flags & VIEW_FLAG_PATTERN_GRID)
            message["params"] = [r.u14() for _ in range(min(count, MAX_WATCHED_PARAMS))]
            if r.pos < len(r.payload):
                message["liveScenes"] = r.u7() != 0
                message["liveOffset"] = r.u14()
            else:
                message["liveScenes"] = False
                message["liveOffset"] = 0
            return message
        if command == CMD_SELECT_CHANNEL:
            return {"type": "selectChannel", "index": r.u14()}
        if command == CMD_SET_CHANNEL:
            index = r.u14()
            what = r.u7()
            if what >= len(CHANNEL_WHAT):
                return None
            return {"type": "setChannel", "index": index, "what": CHANNEL_WHAT[what], "value": r.norm()}
        if command == CMD_SET_CHANNEL_TRACK:
            return {"type": "setChannelTrack", "index": r.u14(), "track": r.u14()}
        if command == CMD_SHOW_EDITOR:
            return {"type": "showEditor", "index": r.u14()}
        if command == CMD_SET_STEP:
            return {"type": "setStep", "channel": r.u14(), "step": r.u14(), "on": r.u7() != 0}
        if command == CMD_SELECT_TRACK:
            return {"type": "selectTrack", "index": r.u14()}
        if command == CMD_SET_TRACK:
            index = r.u14()
            what = r.u7()
            if what >= len(TRACK_WHAT):
                return None
            return {"type": "setTrack", "index": index, "what": TRACK_WHAT[what], "value": r.norm()}
        if command == CMD_SET_PARAM:
            return {"type": "setParam", "param": r.u14(), "value": r.norm()}
        if command == CMD_SELECT_PATTERN:
            return {"type": "selectPattern", "number": r.u14()}
        if command == CMD_CLONE_PATTERN:
            return {"type": "clonePattern", "number": r.u14()}
        if command == CMD_NEW_PATTERN:
            return {"type": "newPattern"}
        if command == CMD_CLEAR_STEPS:
            return {"type": "clearSteps", "channel": r.u14()}
        if command == CMD_SET_TEMPO:
            return {"type": "setTempo", "bpm": r.u21() / 100.0}
        if command == CMD_SET_SWING:
            return {"type": "setSwing", "value": r.norm()}
        if command == CMD_SET_MAIN_VOLUME:
            return {"type": "setMainVolume", "value": r.norm()}
        if command == CMD_SHOW_WINDOW:
            return {"type": "showWindow", "window": r.u7()}
        if command == CMD_SET_SNAP:
            return {"type": "setSnap", "mode": r.u7()}
        if command == CMD_PRESET_STEP:
            return {"type": "presetStep", "dir": "next" if r.u7() else "prev"}
        if command == CMD_JUMP_MARKER:
            return {"type": "jumpMarker", "index": r.u7(), "quantized": r.u7() != 0}
        if command == CMD_ADD_MARKER:
            return {"type": "addMarker"}
        if command == CMD_SET_LOOP_MODE:
            return {"type": "setLoopMode", "song": r.u7() != 0}
        if command == CMD_PLAYLIST_VIEW:
            what = r.u7()
            if what >= len(PLAYLIST_VIEW_WHAT):
                return None
            return {"type": "playlistView", "what": PLAYLIST_VIEW_WHAT[what], "delta": r.s7()}
        if command == CMD_REQUEST_MARKERS:
            return {"type": "requestMarkers"}
        if command == CMD_SET_SONG_POS:
            return {"type": "setSongPos", "ticks": r.u21()}
        if command == CMD_RUN_PROBE:
            return {"type": "runProbe"}
        if command == CMD_PRESET_WINDOW:
            return {"type": "presetWindow", "offset": r.u14()}
        if command == CMD_PRESET_LOAD:
            return {"type": "presetLoad", "index": r.u14()}
        if command == CMD_SET_PATTERN_LENGTH:
            return {"type": "setPatternLength", "pattern": r.u7(), "length": r.u14()}
        if command == CMD_SET_LOOP:
            return {"type": "setLoop", "start": r.u21(), "end": r.u21()}
        if command == CMD_REQUEST_LOOP:
            return {"type": "requestLoop"}
        if command == CMD_STRIP:
            kind = r.u7()
            if kind >= len(STRIP_KINDS):
                return None
            return {"type": "strip", "kind": STRIP_KINDS[kind], "value": r.u14(), "release": r.u7() != 0}
        if command == CMD_TRANSPOSE:
            return {"type": "transpose", "channel": r.u14(), "semitones": r.s7()}
        if command == CMD_BROWSE:
            action = r.u7()
            if action >= len(BROWSE_ACTIONS):
                return None
            return {"type": "browse", "action": BROWSE_ACTIONS[action]}
        if command == CMD_UI_KEY:
            key = r.u7()
            if key >= len(UI_KEYS):
                return None
            return {"type": "uiKey", "key": UI_KEYS[key]}
        if command == CMD_PICKER:
            show = r.u7() != 0
            mode = r.u7() - 64
            return {"type": "picker", "show": show, "mode": None if mode == PICKER_NO_MODE else mode}
        if command == CMD_TRIGGER_LIVE_CLIP:
            block = r.u14()
            release = r.u7() != 0 if r.pos < len(r.payload) else False
            return {
                "type": "triggerLiveClip",
                "block": None if block == NONE_INDEX else block,
                "release": release,
            }
        if command == CMD_SET_PATTERN_COLOR:
            pattern = r.u14()
            return {
                "type": "setPatternColor",
                "pattern": pattern,
                "color": (r.u7() << 21) | (r.u7() << 14) | (r.u7() << 7) | r.u7(),
            }
        if command == CMD_DOUBLE_PATTERN:
            pattern = r.u7()
            if r.pos < len(r.payload) and r.u7() == 1:
                return {"type": "doublePattern", "pattern": pattern, "native": True}
            return {"type": "doublePattern", "pattern": pattern}
        if command == CMD_CREATE_PATTERN:
            return {"type": "createPattern", "number": r.u14()}
        if command == CMD_UI:
            action = r.u7()
            if action >= len(UI_ACTIONS):
                return None
            return {"type": "ui", "action": UI_ACTIONS[action]}
    except ValueError:
        return None
    return None


# ---------------------------------------------------------------------------------------------
# The playlist probe (pure reading; a diagnostic before the ARRANGER redesign)
# ---------------------------------------------------------------------------------------------
#
# FL's script API cannot read playlist clips, but the performance-mode functions (playlist.getLive*)
# may give a tracks x blocks grid outside performance mode too. RUN_PROBE reads them and sends the
# results as PROBE lines (docs/sysex.md); mk3d only logs them. Every FL call has its own try/except:
# a call that fails shows as `?` in its place and adds ` | <function>: error <message>` to the line.


class _ProbeLine(object):
    def __init__(self):
        self.errors = []

    def call(self, name, function, *args, **kwargs):
        """function(*args) formatted with `fmt` (default str), or `?` when it raises."""
        fmt = kwargs.get("fmt", str)
        try:
            return fmt(function(*args))
        except Exception as error:
            note = "%s: error %s" % (name, error)
            if note not in self.errors:
                self.errors.append(note)
            return "?"

    def text(self, body):
        return body + "".join(" | " + note for note in self.errors)


def _hex(value):
    return "%x" % int(value)


def _hex6(value):
    return "%06x" % (int(value) & 0xFFFFFF)


def split_probe_text(text, limit=MAX_PROBE_TEXT):
    """The PROBE texts of one line: pieces of at most `limit` characters, cut at spaces where it can
    be; a continuation starts with `+ `."""
    pieces = []
    text = str(text)
    prefix = ""
    while len(prefix) + len(text) > limit:
        room = limit - len(prefix)
        cut = text.rfind(" ", 0, room + 1)
        if cut <= 0:
            cut = room
        pieces.append(prefix + text[:cut])
        text = text[cut:].lstrip(" ")
        prefix = "+ "
    pieces.append(prefix + text)
    return pieces


def _probe_header():
    p = _ProbeLine()
    abs_ticks = SONGLENGTH_ABSTICKS
    bars = getattr(midi, "SONGLENGTH_BARS", 3)
    fields = (
        ("perf", "playlist.getPerformanceModeState", lambda: playlist.getPerformanceModeState()),
        ("tracks", "playlist.trackCount", lambda: playlist.trackCount()),
        ("ppq", "general.getRecPPQ", lambda: general.getRecPPQ()),
        ("songlen", "transport.getSongLength", lambda: transport.getSongLength(abs_ticks)),
        ("bars", "transport.getSongLength", lambda: transport.getSongLength(bars)),
        ("start", "playlist.getSongStartTickPos", lambda: playlist.getSongStartTickPos()),
        ("pos", "transport.getSongPos", lambda: transport.getSongPos(abs_ticks)),
        ("loop", "transport.getLoopMode", lambda: transport.getLoopMode()),
    )
    return p.text(" ".join("%s=%s" % (key, p.call(name, function)) for key, name, function in fields))


def _probe_ppq():
    try:
        ppq = int(general.getRecPPQ())
        return ppq if ppq > 0 else DEFAULT_PPQ
    except Exception:
        return DEFAULT_PPQ


def _probe_blocks():
    p = _ProbeLine()
    values = [p.call("playlist.liveBlockNumToTime", lambda b=b: playlist.liveBlockNumToTime(b)) for b in range(PROBE_BLOCKS)]
    return p.text("blocks: " + " ".join(values))


def _probe_time_to_block():
    p = _ProbeLine()
    ppq = _probe_ppq()
    values = [
        p.call("playlist.liveTimeToBlockNum", lambda t=ppq * 4 * bar: playlist.liveTimeToBlockNum(t))
        for bar in range(PROBE_BLOCKS)
    ]
    return p.text("t2b: " + " ".join(values))


def _probe_track(index, label):
    """One of the three lines of a track: `first` (name, status), the default status, the colors."""
    simplest = getattr(midi, "LB_Status_Simplest", 2)
    default = getattr(midi, "LB_Status_Default", 0)

    def line_status():
        p = _ProbeLine()
        name = p.call("playlist.getTrackName", lambda: playlist.getTrackName(index), fmt=str)
        status = p.call("playlist.getLiveStatus", lambda: playlist.getLiveStatus(index, simplest), fmt=_hex)
        blocks = "".join(
            p.call("playlist.getLiveBlockStatus", lambda b=b: playlist.getLiveBlockStatus(index, b, simplest), fmt=_hex)
            for b in range(PROBE_BLOCKS)
        )
        return p.text('%s "%s" st=%s %s' % (label, name, status, blocks))

    def line_default():
        p = _ProbeLine()
        values = [
            p.call("playlist.getLiveBlockStatus", lambda b=b: playlist.getLiveBlockStatus(index, b, default), fmt=_hex)
            for b in range(PROBE_BLOCKS)
        ]
        return p.text("%s def: %s" % (label, " ".join(values)))

    def line_colors():
        p = _ProbeLine()
        values = [
            p.call("playlist.getLiveBlockColor", lambda b=b: playlist.getLiveBlockColor(index, b), fmt=_hex6)
            for b in range(PROBE_BLOCKS)
        ]
        return p.text("%s col: %s" % (label, " ".join(values)))

    return [line_status, line_default, line_colors]


def _probe_markers():
    p = _ProbeLine()
    names = []
    for i in range(PROBE_MARKERS):
        name = p.call("arrangement.getMarkerName", lambda i=i: arrangement.getMarkerName(i), fmt=lambda v: str(v).strip())
        if name in ("", "?"):
            break
        names.append("%d=%s" % (i, name))
    return p.text("markers: " + (", ".join(names) if names else "(none)"))


def _probe_patterns():
    p = _ProbeLine()
    count = p.call("patterns.patternCount", lambda: patterns.patternCount(), fmt=int)
    entries = []
    if count != "?":
        for n in range(1, min(count, PROBE_PATTERNS) + 1):
            name = p.call("patterns.getPatternName", lambda n=n: patterns.getPatternName(n))
            length = p.call("patterns.getPatternLength", lambda n=n: patterns.getPatternLength(n))
            entries.append("%s/%s" % (name, length))
    return p.text("patterns: n=%s%s" % (count, " " + ", ".join(entries) if entries else ""))


def _ilmcp():
    """FL 2026's undocumented `ilmcp` module, or None. FL creates it only for the Python sessions of
    its MCP server (the Gopher assistant's tools, docs/fl-ilmcp.md), so a controller script finds it
    only if those sessions share this interpreter and one has run (it is then in sys.modules)."""
    import sys

    module = sys.modules.get("ilmcp")
    if module is not None:
        return module
    try:
        import ilmcp  # noqa: F401 (not in the API stubs)

        return ilmcp
    except Exception:
        return None


def _probe_ilmcp_dir():
    module = _ilmcp()
    if module is None:
        import sys

        error = ""
        try:
            import ilmcp  # noqa: F401
        except Exception as e:
            error = repr(e)
        names = sorted(n for n in sys.modules if not n.startswith("_") and "." not in n)
        return "ilmcp: import failed %s; modules: %s" % (error, " ".join(names))
    return "ilmcp: " + " ".join(name for name in dir(module) if not name.startswith("__"))


def _probe_browser(path):
    """One read-only listing of FL's browser tree: `ilmcp.getBrowserNames(path, False)`."""

    def line():
        module = _ilmcp()
        if module is None:
            return "browser %r: no ilmcp" % (path,)
        names = module.getBrowserNames(path, False)
        return "browser %r (%d): %s" % (path, len(names), ", ".join(str(n) for n in list(names)[:24]))

    return line


def _probe_browser_children():
    """The root's first entries one level down (built when the root is known)."""
    module = _ilmcp()
    if module is None:
        return []
    try:
        root = list(module.getBrowserNames("", False))[:6]
    except Exception:
        return []
    return [_probe_browser(str(name)) for name in root]


# A piano roll script that only reads: every note of the open piano roll goes into a shared module
# (if piano roll scripts share the interpreter with this script) and into a temp file.
PR_READ_SCRIPT = """
import flpianoroll as pr
import sys, os, tempfile
notes = []
for i in range(pr.score.noteCount):
    n = pr.score.getNote(i)
    notes.append((n.number, n.time, n.length, n.velocity))
shared = sys.modules.get("mk3_shared")
if shared is None:
    shared = type(sys)("mk3_shared")
    sys.modules["mk3_shared"] = shared
shared.notes = notes
shared.ppq = pr.score.PPQ
try:
    with open(os.path.join(tempfile.gettempdir(), "mk3_notes.txt"), "w") as f:
        f.write(repr(notes))
except Exception as e:
    shared.file_error = repr(e)
"""


def _probe_pr_script():
    """Run PR_READ_SCRIPT through ilmcp.runPRScript (opens the piano roll if closed; reads only) and
    report how the notes came back."""
    module = _ilmcp()
    if module is None or not hasattr(module, "runPRScript"):
        return "prscript: no ilmcp.runPRScript"
    import sys, os, tempfile

    sys.modules.pop("mk3_shared", None)
    result = module.runPRScript(PR_READ_SCRIPT)
    shared = sys.modules.get("mk3_shared")
    path = os.path.join(tempfile.gettempdir(), "mk3_notes.txt")
    exists = os.path.exists(path)
    notes = getattr(shared, "notes", None) if shared is not None else None
    return "prscript: ret=%r shared=%s file=%s first=%r err=%r" % (
        result,
        "missing" if notes is None else "%d notes ppq %s" % (len(notes), getattr(shared, "ppq", "?")),
        "%s %s" % (path, "exists" if exists else "missing"),
        (notes or [])[:3],
        getattr(shared, "file_error", None) if shared is not None else None,
    )


def _probe_getter(label, module, name, *args):
    """One hidden, read-only getter (found with REA; not in the stubs)."""

    def line():
        function = getattr(module, name, None)
        if function is None:
            return "%s: missing" % label
        return "%s%r = %r" % (label, args, function(*args))

    return line


def probe_lines():
    """The lines of the probe, as functions run one at a time (each returns its text): first the
    read-only `ilmcp` browser listing (a new instrument on an empty pad, PLAN.md), then the playlist."""
    lines = [_probe_ilmcp_dir, _probe_browser("")]
    lines += _probe_browser_children()
    lines += [_probe_browser("Plugin database"), _probe_browser("Plugin database/Generators")]
    lines += [
        _probe_getter("channels.getSwing", channels, "getSwing"),
        _probe_getter("general.getProjectTitle", general, "getProjectTitle"),
        _probe_getter("arrangement.selectionIsActive", arrangement, "selectionIsActive"),
        _probe_getter("mixer.getPluginMixLevel", mixer, "getPluginMixLevel", 1, 0),
        _probe_pr_script,
        # patterns.getBlockSetStatus(left, top, right, bottom): undocumented, unverified (NKS-style
        # research, 2026-10-20). Args are unknown; try a few plausible (track, block) rectangles to
        # see which (if any) return something other than 0. Track 1 has filled blocks 0-2 right now.
        _probe_getter("patterns.getBlockSetStatus(0,0,4,4)", patterns, "getBlockSetStatus", 0, 0, 4, 4),
        _probe_getter("patterns.getBlockSetStatus(1,1,4,4)", patterns, "getBlockSetStatus", 1, 1, 4, 4),
        _probe_getter("patterns.getBlockSetStatus(1,0,4,3)", patterns, "getBlockSetStatus", 1, 0, 4, 3),
        _probe_getter("patterns.getBlockSetStatus(0,1,3,4)", patterns, "getBlockSetStatus", 0, 1, 3, 4),
        _probe_getter("patterns.getBlockSetStatus(1,1,1,3)", patterns, "getBlockSetStatus", 1, 1, 1, 3),
    ]
    lines += [_probe_header, _probe_blocks, _probe_time_to_block]
    lines += _probe_track(0, "track0")
    for i in range(1, PROBE_TRACKS + 1):
        lines += _probe_track(i, "T%d" % i)
    lines += [_probe_markers, _probe_patterns]
    return lines


# ---------------------------------------------------------------------------------------------
# Reading FL state
# ---------------------------------------------------------------------------------------------


def fl_color(color):
    """FL colors are 0x--RRGGBB, possibly negative (FL's own utils.ColorToRGB reads them that way;
    the API stubs say 0x--BBGGRR, which disagrees). The wire format is 0xRRGGBB."""
    try:
        return int(color) & 0xFFFFFF
    except (TypeError, ValueError):
        return 0


def _safe(default, function, *args):
    """Call an FL function; on any failure return `default` so one bad item does not stop the rest."""
    try:
        return function(*args)
    except Exception as error:
        _log_once(getattr(function, "__name__", "FL call"), error)
        return default


def _general(default, name, *args):
    """Call general.<name>; `default` when this FL version has no such function or it fails."""
    function = getattr(general, name, None)
    if function is None:
        _log_once("general." + name, "missing in this FL version")
        return default
    return _safe(default, function, *args)


def _attr(default, module, name, *args):
    """Call module.<name>; `default` when this FL version lacks it or it fails."""
    function = getattr(module, name, None)
    if function is None:
        _log_once(getattr(module, "__name__", "module") + "." + name, "missing in this FL version")
        return default
    return _safe(default, function, *args)


def _step_param_functions():
    """(channels.getCurrentStepParam, channels.setStepParameterByIndex), None for a missing one."""
    names = ("getCurrentStepParam", "setStepParameterByIndex")
    found = [getattr(channels, name, None) for name in names]
    return tuple(function if callable(function) else None for function in found)


def _chunks(start, stop, size=MAX_LIST_ENTRIES):
    """(first, last_exclusive) ranges of at most `size` indexes covering start..stop, at least one."""
    if stop <= start:
        return [(start, start)]
    return [(i, min(i + size, stop)) for i in range(start, stop, size)]


ALL_READERS = (
    "transport",
    "song_pos",
    "selected_channel",
    "channel_detail",
    "channels",
    "plugin",
    "presets",
    "params",
    "grid",
    "mixer",
    "selected_track",
    "ui_state",
    "undo_state",
    "pattern",
    "pattern_grid",
    "patterns",
    "loop",
    "features",
    "live_grid",
    "activity",
)
CHANNEL_READERS = ("selected_channel", "channel_detail", "channels", "plugin", "presets", "params", "grid")
MIXER_READERS = ("mixer", "selected_track")
PATTERN_READERS = ("pattern", "patterns", "grid")


class View(object):
    """What mk3d watches (VIEW command). Defaults apply until the first VIEW."""

    def __init__(self):
        self.channel_offset = 0
        self.mixer_offset = 0
        self.pattern_offset = 0
        self.step_offset = 0
        self.meters = False
        self.presets = False
        self.pattern_grid = False
        self.params = list(range(MAX_WATCHED_PARAMS))
        self.live_scenes = False  # the LIVE overlay is open and watching
        self.live_offset = 0


class Bridge(object):
    def __init__(self, clock=None):
        self.clock = clock or time.monotonic
        self.view = View()
        self.sent = {}  # key -> last frame sent
        self.queue = OrderedDict()  # key -> frame, oldest first
        self.dirty = set(ALL_READERS)
        self.last_full = None
        self.last_song_pos = None
        self.last_meters = None
        self.last_alive = None
        self.last_snap = None  # the snap mode seen on the last service pass
        # Names of the selected channel's plugin parameters: {"key": (channel, name, count),
        # "names": [...], "done": bool}. Read in slices of PARAM_SCAN_PER_PASS per service pass.
        self.scan = None
        self.names_pending = False  # send the names (again) once the scan is done
        # The selected channel's presets, read while VIEW has the presets flag: {"key": (channel,
        # plugin name, count), "names": [...] or None (banks over PRESET_SCAN_LIMIT), "current": index
        # or None}. The names are read once per key; only the patch name is read on every pass.
        self.presets = None
        # Editor follows selection. follow_opened: channels whose editor this script opened while
        # following; seen_open: channels whose generator window was seen focused for other reasons
        # (or opened by the user through SHOW_EDITOR). Both reset when the channel count changes.
        self.follow_opened = set()
        self.seen_open = set()
        self.known_channel_count = None
        # Step edits (clear, paste, cut) run as one batch: service() waits until it is over.
        self.batching = 0
        # A DOUBLE_PATTERN being copied, a few channels per service pass (see double_pattern), or None.
        self.double_job = None
        # The step clipboard: the steps (booleans) of the channel last copied, or None.
        self.step_clipboard = None
        # LIVE scenes whose pad is still down: block -> (track, flags) of the triggerLiveClip that
        # launched it, so the release repeats the same call with TLC_Release (as FL's Fire script does).
        self.live_held = {}
        self.activity_lit = False  # the last ACTIVITY had a channel playing
        self.last_live = None  # when LIVE_GRID / LIVE_TRACK were last read (throttle)
        self.last_activity = None  # when ACTIVITY was last read (throttle)
        # The pattern overview (PATTERN_GRID): pg_todo = (channel, first step) chunks still to read, in
        # order; pg_pattern = the pattern number the sent chunks belong to; pg_restart = start over with
        # the visible step page first (something changed).
        self.pg_todo = []
        self.pg_pattern = None
        self.pg_restart = False
        # Playlist markers: [(ticks, name)] in time order from the last scan (or the last ADD_MARKER while
        # playing). A scan runs only while FL is stopped (see the header); marker_scan = one is wanted,
        # marker_stale = the list may be out of date, scan as soon as FL stops. marker_outbox = MARKERS
        # frames not yet sent, one per service pass. marker_pending = a quantized jump waits for the bar.
        self.markers = []
        self.marker_scan = False
        self.marker_stale = False
        self.marker_outbox = []
        self.marker_pending = None
        # The touch strip's PERFORM sweep while a touch is on: {"index", "param" (a plugin parameter or None
        # = the channel cutoff), "before"}, else None. strip_params caches the cutoff parameter per
        # (channel, plugin name): the parameter's index, or None for "none found".
        self.perform = None
        self.pitch_index = None  # the channel the strip's pitch is bent on, while a touch is on
        self.strip_params = {}
        # The playlist probe (a diagnostic, see probe_lines): lines not yet built (callables, one is
        # run per service pass) and PROBE texts built but not yet sent (a long line is cut up).
        self.probe_todo = []
        self.probe_texts = []
        self.probe_count = 0
        # Plug-in loader trial: the label of the browser / key / picker command whose answer (BROWSER_NODE
        # and a PROBE line) is due, and how many service passes to wait first so FL has updated.
        self.node_label = None
        self.node_wait = 0
        self.node_notes = []

    # -- queue ------------------------------------------------------------------------------

    def submit(self, key, message):
        """Queue a message unless it equals the last one sent under this key.

        A newer message with the same key replaces the queued one, keeping its place.
        """
        data = encode(message)
        if self.sent.get(key) == data:
            self.queue.pop(key, None)  # the queued one is stale; mk3d already has this state
            return
        self.queue[key] = data

    def flush(self, limit=MAX_FRAMES_PER_CALLBACK):
        sent = 0
        while self.queue and sent < limit:
            key, data = self.queue.popitem(last=False)
            try:
                device.midiOutSysex(data)
            except Exception as error:
                _log_once("midiOutSysex", error)
                continue
            self.sent[key] = data
            sent += 1
        return sent

    def drop_family(self, prefix):
        """Forget cached and queued frames whose key is `prefix` or `prefix@...`."""
        self.retain_family(prefix, ())

    def retain_family(self, prefix, keep):
        keep = set(keep)
        for store in (self.sent, self.queue):
            for key in [k for k in store if (k == prefix or k.startswith(prefix + "@")) and k not in keep]:
                del store[key]

    def reset_cache(self):
        self.sent.clear()
        self.queue.clear()

    def reset_follow(self):
        self.follow_opened.clear()
        self.seen_open.clear()

    # -- dirty flags and servicing -----------------------------------------------------------

    def mark(self, *readers):
        self.dirty.update(readers)
        if "grid" in readers or "pattern_grid" in readers:
            # A step changed (or the window moved): the overview starts over with the visible page.
            self.dirty.add("pattern_grid")
            self.pg_restart = True

    def mark_all(self):
        self.dirty.update(ALL_READERS)

    def focused_generator(self):
        """Channel index of the focused generator plugin window, or None (also on any error)."""
        try:
            if not ui.getFocused(midi.widPluginGenerator):
                return None
            index = ui.getFocusedFormID()
            if isinstance(index, bool) or not isinstance(index, int):
                return None
            return index if index >= 0 else None
        except Exception as error:
            _log_once("focused window", error)
            return None

    def note_focus(self):
        """A generator window got the focus: if we did not open it, the user had it open."""
        index = self.focused_generator()
        if index is not None and index not in self.follow_opened:
            self.seen_open.add(index)

    @contextlib.contextmanager
    def batch(self, undo_name):
        """One undo point (general.saveUndo, before the first change) for a run of edits, and no
        reading in between: whatever FL calls from inside (OnRefresh, OnIdle) cannot see a half
        done grid. The grid and the undo state are read once afterwards."""
        self.batching += 1
        try:
            _general(None, "saveUndo", undo_name, _undo_flags())
            yield
        finally:
            self.batching -= 1
            self.mark("grid", "undo_state")

    def mark_refresh(self, flags):
        """Map OnRefresh flags (midi.HW_Dirty_*) to what has to be read again."""
        try:
            if flags & midi.HW_Dirty_FocusedWindow:
                self.note_focus()
        except Exception as error:
            _log_once("note_focus", error)
        if flags & midi.HW_Dirty_FocusedWindow:
            self.mark("ui_state")
        self.mark("transport", "song_pos")
        mixer_flags = (
            midi.HW_Dirty_Mixer_Sel
            | midi.HW_Dirty_Mixer_Display
            | midi.HW_Dirty_Mixer_Controls
            | midi.HW_Dirty_Tracks
        )
        channel_flags = (
            midi.HW_Dirty_ChannelRack
            | midi.HW_Dirty_ChannelRackGroup
            | midi.HW_Dirty_GraphEditor
            | midi.HW_Dirty_ControlValues
            | midi.HW_Dirty_RemoteLinkValues
        )
        if flags & getattr(midi, "HW_Dirty_Undo", 0):
            self.mark("undo_state")
            self.mark_all()
            return
        if flags & (midi.HW_Dirty_Names | midi.HW_Dirty_Colors):
            self.mark_all()
            return
        if flags & mixer_flags:
            self.mark(*MIXER_READERS)
        if flags & channel_flags:
            self.mark(*CHANNEL_READERS)
        if flags & midi.HW_Dirty_Patterns:
            self.mark(*PATTERN_READERS)

    def service(self):
        """Read what is dirty (everything every 100 ms), queue what changed, send up to 8 frames."""
        if self.batching:
            return 0  # FL called us from inside a batch of edits: the grid is half done, wait
        try:
            self.service_double()
        except Exception as error:
            self.double_job = None
            self.batching = 0
            _log_once("service_double", error)
        now = self.clock()
        if self.last_full is None or now - self.last_full >= FULL_REREAD_SECONDS:
            self.last_full = now
            self.mark_all()
        if self.last_song_pos is None or now - self.last_song_pos >= SONG_POS_SECONDS:
            self.mark("song_pos")
        # Transport flags are four cheap calls; look at them on every pass.
        self.mark("transport")
        # So is the snap mode: send UI_STATE as soon as it changes (FL has no dirty flag for it).
        self.check_snap()
        # The loop range: three cheap getters, so it is looked at on every pass too (sent when it changes).
        self.mark("loop")
        # The live grid: FL has no dirty flag for performance-mode changes (OnUpdateLiveMode marks
        # it when FL says something changed), so also look every LIVE_SECONDS while LIVE is open.
        if self.view.live_scenes and (self.last_live is None or now - self.last_live >= LIVE_SECONDS):
            self.mark("live_grid")
        # Channel activity (the pads light when FL plays their channel): every ACTIVITY_SECONDS while
        # FL plays, and after it stops while a pad is still lit, so the last frame clears them.
        if (self.last_activity is None or now - self.last_activity >= ACTIVITY_SECONDS) and (
            self.activity_lit or self.is_playing()
        ):
            self.mark("activity")
        if self.last_alive is None or now - self.last_alive >= ALIVE_SECONDS:
            self.last_alive = now
            self.queue["ALIVE"] = encode({"type": "alive"})  # always sent, never deduplicated
        dirty = self.dirty
        self.dirty = set()
        if self.double_job is not None:
            dirty.discard("grid")  # a DOUBLE is half done: the grid goes out once, when it is over
            dirty.discard("pattern_grid")
            self.dirty.add("grid")
        for name in ALL_READERS:
            if name not in dirty:
                continue
            if name == "song_pos":
                self.last_song_pos = now
            try:
                getattr(self, "read_" + name)()
            except Exception as error:
                _log_once("read_" + name, error)
        try:
            if self.double_job is None:
                self.service_pattern_grid()
        except Exception as error:
            _log_once("service_pattern_grid", error)
        try:
            self.service_markers()
        except Exception as error:
            _log_once("service_markers", error)
        try:
            self.service_probe()
        except Exception as error:
            _log_once("service_probe", error)
        try:
            self.service_preset_load()
        except Exception as error:
            _log_once("service_preset_load", error)
        try:
            self.service_browser_node()
        except Exception as error:
            self.node_label = None
            _log_once("service_browser_node", error)
        sent = self.flush()
        # PROBE frames are never repeated, so there is nothing to compare the next one with.
        for key in [k for k in self.sent if k.startswith("PROBE@")]:
            del self.sent[key]
        return sent

    # -- readers -----------------------------------------------------------------------------

    def read_transport(self):
        state = {
            "playing": bool(_safe(False, transport.isPlaying)),
            "recording": bool(_safe(False, transport.isRecording)),
            "metronome": bool(_safe(False, ui.isMetronomeEnabled)),
            "countIn": bool(_safe(False, ui.isPrecountEnabled)),
            "songMode": self.loop_mode() == 1,
        }
        raw = float(_safe(0, mixer.getCurrentTempo))
        tempo = raw / TEMPO_SCALE if raw > 1000 else raw
        self.submit(
            "TRANSPORT",
            {
                "type": "transport",
                "state": state,
                "tempo": tempo,
                "swing": _safe(0.0, self.read_swing),
                "mainVolume": self.read_main_volume(),
            },
        )

    def loop_mode(self):
        """transport.getLoopMode(): 0 pattern, 1 song (0 when FL cannot say)."""
        return _attr(0, transport, "getLoopMode")

    def read_swing(self):
        """The main swing as 0...1 (see the NOT VERIFIED notes in the header)."""
        return self.read_rec_norm(midi.REC_MainShuffle)

    def read_main_volume(self):
        """FL's main volume (REC_MainVol) as 0...1, or None when FL cannot be asked (mk3d then
        shows no value instead of 0)."""
        raw = _safe(None, device.getLinkedValue, midi.REC_MainVol)
        if raw is None or float(raw) < 0:  # -1 = no such event
            return None
        return _clamp01(float(raw))

    def read_undo_state(self):
        """FL's undo history: position, count and FL's own hint text (see the header)."""
        self.submit(
            "UNDO_STATE",
            {
                "type": "undoState",
                "position": int(_general(0, "getUndoHistoryPos")),
                "count": int(_general(0, "getUndoHistoryCount")),
                "hint": str(_general("", "getUndoLevelHint")),
            },
        )

    def read_song_pos(self):
        bar = _safe(0, transport.getSongPos, midi.SONGLENGTH_BARS) + SONGPOS_BAR_BASE
        step = _safe(0, transport.getSongPos, midi.SONGLENGTH_STEPS) + SONGPOS_STEP_BASE
        tick = _safe(0, transport.getSongPos, midi.SONGLENGTH_TICKS)
        self.submit("SONG_POS", {"type": "songPos", "bar": bar, "step": step, "tick": tick})

    def channel_total(self):
        total = int(_safe(0, channels.channelCount))
        if total != self.known_channel_count:
            if self.known_channel_count is not None:
                self.reset_follow()  # indexes shift
            self.known_channel_count = total
        return total

    def selected_channel_index(self):
        """Group-local index of the selected channel, or None."""
        index = _safe(-1, channels.selectedChannel, True)
        if index is None or index < 0 or index >= self.channel_total():
            return None
        return index

    def read_channels(self):
        total = self.channel_total()
        offset = self.view.channel_offset
        stop = min(offset + CHANNEL_WINDOW, total)
        keys = []
        for first, last in _chunks(offset, stop):
            entries = []
            for i in range(first, last):
                entries.append(
                    {
                        "selected": bool(_safe(False, channels.isChannelSelected, i)),
                        "muted": bool(_safe(False, channels.isChannelMuted, i)),
                        "solo": bool(_safe(False, channels.isChannelSolo, i)),
                        "color": fl_color(_safe(0, channels.getChannelColor, i)),
                        "name": _safe("", channels.getChannelName, i),
                    }
                )
            key = "CHANNELS@%d" % first
            keys.append(key)
            self.submit(key, {"type": "channels", "total": total, "offset": first, "entries": entries})
        self.retain_family("CHANNELS", keys)

    def read_selected_channel(self):
        index = self.selected_channel_index()
        if index is None:
            message = {
                "type": "selectedChannel",
                "index": None,
                "color": 0,
                "volume": 0,
                "pan": -1,
                "name": "",
                "plugin": "",
            }
        else:
            valid = bool(_safe(False, plugins.isValid, index))
            message = {
                "type": "selectedChannel",
                "index": index,
                "color": fl_color(_safe(0, channels.getChannelColor, index)),
                "volume": _safe(0.0, channels.getChannelVolume, index),
                "pan": _safe(0.0, channels.getChannelPan, index),
                "name": _safe("", channels.getChannelName, index),
                "plugin": _safe("", plugins.getPluginName, index) if valid else "",
            }
        self.submit("SELECTED_CHANNEL", message)

    def read_rec_norm(self, event_id):
        """A REC event's current value as 0...1. processRECEvent(REC_GetValue) read 0 in FL 26.1.5;
        device.getLinkedValue is the documented normalized getter."""
        raw = _safe(None, device.getLinkedValue, event_id)
        if raw is None:
            return 0.0
        return _clamp01(float(raw))

    def read_channel_detail(self):
        index = self.selected_channel_index()
        if index is None:
            message = {
                "type": "channelDetail",
                "index": None,
                "pitch": 0.0,
                "pitchRange": 0,
                "cutoff": 0.0,
                "resonance": 0.0,
                "mixerTrack": 0,
                "channelType": 0,
            }
        else:
            rec = _safe(None, channels.getRecEventId, index)
            pitch = float(_safe(0.0, channels.getChannelPitch, index, 0))
            message = {
                "type": "channelDetail",
                "index": index,
                "pitch": max(-1.0, min(1.0, pitch)) if pitch == pitch else 0.0,
                "pitchRange": int(_safe(0, channels.getChannelPitch, index, 2)),
                "cutoff": self.read_rec_norm(rec + midi.REC_Chan_FCut) if rec is not None else 0.0,
                "resonance": self.read_rec_norm(rec + midi.REC_Chan_FRes) if rec is not None else 0.0,
                "mixerTrack": int(_safe(0, channels.getTargetFxTrack, index)),
                "channelType": int(_safe(0, channels.getChannelType, index)),
            }
        self.submit("CHANNEL_DETAIL", message)

    def read_plugin(self):
        index = self.selected_channel_index()
        valid = index is not None and bool(_safe(False, plugins.isValid, index))
        name = _safe("", plugins.getPluginName, index) if valid else ""
        count = int(_safe(0, plugins.getParamCount, index)) if valid else 0
        named = self.scan_param_names(index, name, count) if valid else self.forget_param_names()
        self.submit(
            "PLUGIN",
            {
                "type": "plugin",
                "channel": index,
                "valid": valid,
                # Index of the last named parameter + 1 (FL reports 4240 for every VST, most of
                # them unnamed); 0 while the names are still being read.
                "paramCount": named,
                "name": name,
            },
        )
        self.send_param_names()

    def preset_name(self, index, preset):
        """FL's name of preset `preset` of the plugin on channel `index`."""
        return str(_safe("", plugins.getName, index, -1, getattr(midi, "FPN_Preset", 6), preset)).strip()

    def read_presets(self):
        """PRESETS for the selected channel's plugin: the count, the current preset and up to 8 names
        (around the current preset, or at the offset mk3d asked for with PRESET_WINDOW). Only while
        VIEW asks (the BROWSER page is shown). NOT VERIFIED (header)."""
        if not self.view.presets:
            return
        index = self.selected_channel_index()
        valid = index is not None and bool(_safe(False, plugins.isValid, index))
        count = int(_safe(0, plugins.getPresetCount, index)) if valid else 0
        if count <= 0:
            self.presets = None
            self.submit("PRESETS", {"type": "presets", "count": 0, "current": None, "offset": 0, "names": []})
            return
        key = (index, _safe("", plugins.getPluginName, index), count)
        cache = self.presets
        if cache is None or cache["key"] != key:
            names = None
            if count <= PRESET_SCAN_LIMIT:
                names = [self.preset_name(index, k) for k in range(count)]
            cache = self.presets = {
                "key": key,
                "names": names,
                "known": {},
                "current": None,
                "window": None,  # offset of the names mk3d asked for, None = around the current preset
                "pending": None,  # a PRESET_LOAD still stepping: {"index", "dir", "left"}
                "hold_until": 0.0,  # until then the script's own index wins over what FL's names say
            }
        names = cache["names"]
        guess = cache["current"]  # the last known index (moved by steps): breaks ties, serves big banks
        if cache["pending"] is not None or self.clock() < cache["hold_until"]:
            current = guess  # steps are under way or just done: FL may not have renamed things yet
        elif names is not None:
            current = self.detect_preset(index, names, guess)
        else:
            current = guess  # a big bank: all we know is where the last step left us
        cache["current"] = current
        around = cache["window"]
        if around is None:
            around = 0 if current is None else current - 3
        offset = max(0, min(around, count - MAX_PRESET_NAMES))
        stop = min(count, offset + MAX_PRESET_NAMES)
        if names is not None:
            window = names[offset:stop]
        else:  # a big bank: read the names around the index once and keep them
            known = cache["known"]
            for k in range(offset, stop):
                if k not in known:
                    known[k] = self.preset_name(index, k)
            window = [known[k] for k in range(offset, stop)]
        self.submit(
            "PRESETS",
            {"type": "presets", "count": count, "current": current, "offset": offset, "names": window},
        )

    def detect_preset(self, index, names, guess):
        """The index of the current preset: the one whose name is FL's patch name, else the one named
        like the channel (FL names the channel after a VST's program: the patch name did not match
        for Diva), else the last guess (None when there is none). Equal names resolve to the one
        nearest the guess."""
        patch = str(_safe("", plugins.getName, index, -1, getattr(midi, "FPN_Patch", 3))).strip()
        matches = [k for k, name in enumerate(names) if name == patch] if patch else []
        if not matches:
            channel = str(_safe("", channels.getChannelName, index)).strip()
            matches = [k for k, name in enumerate(names) if name == channel] if channel else []
        if not matches:
            return guess
        if guess is None:
            return matches[0]
        return min(matches, key=lambda k: abs(k - guess))

    def preset_cache(self, index, count):
        """The preset cache if it belongs to this channel and bank, else None."""
        cache = self.presets
        if cache is None or cache["key"][0] != index or cache["key"][2] != count:
            return None
        return cache

    def preset_target(self):
        """(channel index, preset count) of the selected channel's plugin, or None without presets."""
        index = self.selected_channel_index()
        if index is None or not _safe(False, plugins.isValid, index):
            return None
        count = int(_safe(0, plugins.getPresetCount, index))
        if count <= 0:
            return None
        return index, count

    def step_preset(self, direction):
        """Load the previous or next preset of the selected channel's plugin (PRESET_STEP)."""
        target = self.preset_target()
        if target is None:
            return
        index, count = target
        _safe(None, plugins.nextPreset if direction == "next" else plugins.prevPreset, index)
        cache = self.preset_cache(index, count)
        if cache is None:
            return
        cache["pending"] = None
        cache["window"] = None  # the list follows the loaded preset again
        if cache["current"] is None:
            cache["hold_until"] = 0.0  # unknown: read FL again after the step instead of staying lost
        else:
            cache["current"] = (cache["current"] + (1 if direction == "next" else -1)) % count
            cache["hold_until"] = self.clock() + PRESET_SETTLE_SECONDS

    def window_presets(self, offset):
        """PRESET_WINDOW: the next PRESETS carry the names from `offset` on (`current` is unchanged)."""
        target = self.preset_target()
        cache = None if target is None else self.preset_cache(*target)
        if cache is not None:
            cache["window"] = max(0, int(offset))

    def load_preset(self, wanted):
        """PRESET_LOAD: load preset `wanted` by stepping next/prev the short way round from the
        current one. service_preset_load does the steps, a few per pass. While the current preset is
        unknown there is no way to tell how far to step: refuse, and send PRESETS again so mk3d can
        show why."""
        target = self.preset_target()
        if target is None:
            return
        index, count = target
        cache = self.preset_cache(index, count)
        if cache is None or cache["current"] is None or not 0 <= wanted < count:
            if cache is not None:
                cache["pending"] = None
            self.sent.pop("PRESETS", None)
            return
        forward = (wanted - cache["current"]) % count
        backward = count - forward
        cache["window"] = None
        if forward == 0:
            cache["pending"] = None
        elif forward <= backward:
            cache["pending"] = {"index": index, "dir": "next", "left": forward}
        else:
            cache["pending"] = {"index": index, "dir": "prev", "left": backward}

    def service_preset_load(self):
        """Do up to PRESET_STEPS_PER_PASS steps of a PRESET_LOAD, then read PRESETS again."""
        cache = self.presets
        if cache is None or cache["pending"] is None:
            return
        pending = cache["pending"]
        index, count = cache["key"][0], cache["key"][2]
        if pending["index"] != index or self.selected_channel_index() != index:
            cache["pending"] = None
            return
        sign = 1 if pending["dir"] == "next" else -1
        for _ in range(PRESET_STEPS_PER_PASS):
            if pending["left"] <= 0:
                break
            _safe(None, plugins.nextPreset if sign > 0 else plugins.prevPreset, index)
            pending["left"] -= 1
            if cache["current"] is not None:
                cache["current"] = (cache["current"] + sign) % count
        if pending["left"] <= 0:
            cache["pending"] = None
            cache["hold_until"] = self.clock() + PRESET_SETTLE_SECONDS
        self.mark("presets")

    def forget_param_names(self):
        if self.scan is not None:
            self.scan = None
            self.drop_family("PARAM_NAMES")
        return 0

    def scan_param_names(self, index, name, count):
        """Read the parameter names of a plugin in slices. Returns the count of named parameters
        (last non-empty name + 1) once done, 0 while still reading."""
        key = (index, name, count)
        if self.scan is None or self.scan["key"] != key:
            self.drop_family("PARAM_NAMES")
            self.scan = {"key": key, "names": [], "done": False, "named": 0}
            self.names_pending = True
        scan = self.scan
        if scan["done"]:
            return scan["named"]
        names = scan["names"]
        stop = min(count, len(names) + PARAM_SCAN_PER_PASS)
        for param in range(len(names), stop):
            names.append(str(_safe("", plugins.getParamName, param, index)).strip())
        if len(names) < count:
            self.mark("plugin")  # carry on in the next service pass
            return 0
        while names and not names[-1]:
            names.pop()
        scan["done"] = True
        scan["named"] = len(names)
        return scan["named"]

    def send_param_names(self):
        """Queue the names in frames of 8 (all-empty ranges are skipped) once the scan is done."""
        scan = self.scan
        if not self.names_pending or scan is None or not scan["done"]:
            return
        self.names_pending = False
        names = scan["names"]
        keys = []
        for first in range(0, len(names), MAX_PARAM_NAMES):
            chunk = names[first : first + MAX_PARAM_NAMES]
            if not any(chunk):
                continue
            key = "PARAM_NAMES@%d" % first
            keys.append(key)
            self.submit(key, {"type": "paramNames", "offset": first, "names": chunk})
        self.retain_family("PARAM_NAMES", keys)

    def read_params(self):
        index = self.selected_channel_index()
        valid = index is not None and bool(_safe(False, plugins.isValid, index))
        if not valid:
            self.drop_family("PLUGIN_PARAMS")
            return
        count = int(_safe(0, plugins.getParamCount, index))
        entries = []
        for param in self.view.params:
            if param >= count:
                continue
            entries.append(
                {
                    "index": param,
                    "value": _safe(0.0, plugins.getParamValue, param, index),
                    "name": _safe("", plugins.getParamName, param, index),
                    "valueText": _safe("", plugins.getParamValueString, param, index),
                }
            )
        keys = []
        for first in range(0, len(entries), MAX_LIST_ENTRIES):
            key = "PLUGIN_PARAMS@%d" % first
            keys.append(key)
            self.submit(key, {"type": "pluginParams", "params": entries[first : first + MAX_LIST_ENTRIES]})
        self.retain_family("PLUGIN_PARAMS", keys)

    def read_grid(self):
        index = self.selected_channel_index()
        if index is None:
            self.drop_family("STEP_GRID")
            return
        pattern = int(_safe(1, patterns.patternNumber))
        offset = self.view.step_offset
        steps = [bool(_safe(False, channels.getGridBit, index, offset + i)) for i in range(STEP_WINDOW)]
        self.submit(
            "STEP_GRID",
            {"type": "stepGrid", "channel": index, "pattern": pattern, "offset": offset, "steps": steps},
        )

    # -- pattern overview (PATTERN_GRID) -------------------------------------------------------

    def pattern_grid_channels(self):
        """The channels of the VIEW's bank that get a row: at most 16, at most 128 (a `u7`)."""
        offset = self.view.channel_offset
        stop = min(offset + CHANNEL_WINDOW, self.channel_total(), MAX_PATTERN_GRID_CHANNEL + 1)
        return list(range(offset, stop))

    def pattern_grid_work(self, old):
        """The chunks to read now: (channel, first step) for every channel of the bank and every 16 steps
        of the pattern (at most 256), the visible step page first, then the pages by distance. On a
        restart the chunks still waiting keep their place behind the visible page."""
        channels_in_view = self.pattern_grid_channels()
        length = min(self.pattern_length(), MAX_PATTERN_STEPS)
        starts = list(range(0, length, PATTERN_GRID_STEPS))
        visible = (self.view.step_offset // PATTERN_GRID_STEPS) * PATTERN_GRID_STEPS
        starts.sort(key=lambda start: (abs(start - visible), start))
        full = [(channel, start) for start in starts for channel in channels_in_view]
        if not old or not self.pg_restart:
            return full
        # Restart: the visible page first, then what was still waiting, then the rest is for later.
        front = [item for item in full if item[1] == (starts[0] if starts else 0)]
        valid = set(full)
        waiting = [item for item in old if item in valid and item not in front]
        return front + waiting

    def read_pattern_grid(self):
        """Plan the reading of the overview (PATTERN_GRID); the chunks go out from service_pattern_grid,
        a few per pass. Nothing is read while VIEW does not have the patternGrid flag."""
        if not self.view.pattern_grid:
            self.pg_todo = []
            self.pg_restart = False
            return
        pattern = int(_safe(1, patterns.patternNumber))
        if pattern != self.pg_pattern:
            # Another pattern: mk3d clears its steps on PATTERN; send every chunk of this one again.
            self.pg_pattern = pattern
            self.drop_family("PATTERN_GRID")
            self.pg_todo = []
        if self.pg_restart or not self.pg_todo:
            self.pg_todo = self.pattern_grid_work(self.pg_todo)
        self.pg_restart = False

    def service_pattern_grid(self):
        """Read and queue the next PATTERN_GRID_CHUNKS_PER_PASS chunks of the plan."""
        if not self.view.pattern_grid or not self.pg_todo:
            return
        pattern = int(_safe(1, patterns.patternNumber))
        if pattern != self.pg_pattern:
            self.mark("pattern", "pattern_grid")  # plan again from the new pattern, before sending
            return
        for _ in range(PATTERN_GRID_CHUNKS_PER_PASS):
            if not self.pg_todo:
                break
            channel, start = self.pg_todo.pop(0)
            self.submit_pattern_chunk(channel, start)

    def submit_pattern_chunk(self, channel, start):
        length = min(self.pattern_length(), MAX_PATTERN_STEPS)
        count = min(PATTERN_GRID_STEPS, length - start)
        if count <= 0 or not 0 <= channel < min(self.channel_total(), MAX_PATTERN_GRID_CHANNEL + 1):
            return
        steps = [bool(_safe(False, channels.getGridBit, channel, start + i)) for i in range(count)]
        # Unknown (no such function, or it fails) counts as "uses the step sequencer".
        uses_steps = bool(_attr(True, channels, "isGridBitAssigned", channel))
        self.submit(
            "PATTERN_GRID@%d@%d" % (channel, start),
            {
                "type": "patternGrid",
                "channel": channel,
                "start": start,
                "steps": steps,
                "stepSequencer": uses_steps,
            },
        )

    def mixer_total(self):
        """Master and the inserts: `mixer.trackCount()` also counts FL's hidden "current" track, the
        last one (the stub says so; it showed on the Mixer page as an unnamed full-volume track)."""
        return max(0, int(_safe(0, mixer.trackCount)) - 1)

    def read_mixer(self):
        total = self.mixer_total()
        offset = self.view.mixer_offset
        stop = min(offset + MIXER_WINDOW, total)
        selected = _safe(-1, mixer.trackNumber)
        keys = []
        for first, last in _chunks(offset, stop):
            entries = []
            for i in range(first, last):
                entries.append(
                    {
                        "selected": i == selected,
                        "muted": bool(_safe(False, mixer.isTrackMuted, i)),
                        "solo": bool(_safe(False, mixer.isTrackSolo, i)),
                        "armed": bool(_safe(False, mixer.isTrackArmed, i)),
                        "color": fl_color(_safe(0, mixer.getTrackColor, i)),
                        "volume": _safe(0.0, mixer.getTrackVolume, i),
                        "pan": _safe(0.0, mixer.getTrackPan, i),
                        "name": _safe("", mixer.getTrackName, i),
                    }
                )
            key = "MIXER@%d" % first
            keys.append(key)
            self.submit(key, {"type": "mixer", "total": total, "offset": first, "entries": entries})
        self.retain_family("MIXER", keys)

    def read_selected_track(self):
        index = _safe(-1, mixer.trackNumber)
        if index < 0:
            return
        self.submit("SELECTED_TRACK", {"type": "selectedTrack", "index": index})

    def snap_mode(self):
        """ui.getSnapMode() clamped to 0...127 (it is a u7 on the wire)."""
        return max(0, min(127, int(_safe(0, ui.getSnapMode))))

    def check_snap(self):
        """Mark UI_STATE when the snap mode changed since the last service pass."""
        snap = self.snap_mode()
        if self.last_snap is not None and snap != self.last_snap:
            self.mark("ui_state")
        self.last_snap = snap

    def read_ui_state(self):
        visible = [bool(_safe(False, ui.getVisible, i)) for i in range(UI_WINDOW_COUNT)]
        focused = FOCUS_NONE
        for window in range(UI_WINDOW_COUNT):
            if _safe(False, ui.getFocused, window):
                focused = window
                break
        else:
            if _safe(False, ui.getFocused, FOCUS_PLUGIN):
                focused = FOCUS_PLUGIN
        snap = self.snap_mode()
        self.last_snap = snap
        self.submit("UI_STATE", {"type": "uiState", "snap": snap, "visible": visible, "focused": focused})

    def pattern_count(self):
        current = int(_safe(1, patterns.patternNumber))
        return max(int(_safe(0, patterns.patternCount)), current)

    def read_pattern(self):
        number = int(_safe(1, patterns.patternNumber))
        beats = int(_safe(0, patterns.getPatternLength, number))  # really steps
        self.submit(
            "PATTERN",
            {
                "type": "pattern",
                "number": number,
                "count": self.pattern_count(),
                "length": beats * STEPS_PER_UNIT,
                "color": fl_color(_safe(0, patterns.getPatternColor, number)),
                "name": _safe("", patterns.getPatternName, number),
            },
        )

    def read_patterns(self):
        count = self.pattern_count()
        current = int(_safe(1, patterns.patternNumber))
        offset = self.view.pattern_offset
        stop = min(offset + PATTERN_WINDOW, count)
        keys = []
        for first, last in _chunks(offset, stop):
            entries = []
            for i in range(first, last):
                number = i + 1  # entry 0 = pattern 1
                entries.append(
                    {
                        "current": number == current,
                        "color": fl_color(_safe(0, patterns.getPatternColor, number)),
                        "name": _safe("", patterns.getPatternName, number),
                    }
                )
            key = "PATTERNS@%d" % first
            keys.append(key)
            self.submit(key, {"type": "patterns", "count": count, "offset": first, "entries": entries})
        self.retain_family("PATTERNS", keys)

    def read_loop(self):
        """LOOP_STATE: the song loop range (the playlist time selection)."""
        active = bool(_attr(False, arrangement, "selectionIsActive"))
        start = end = 0
        if active:
            start = int(_attr(0, arrangement, "selectionStart"))
            end = int(_attr(0, arrangement, "selectionEnd"))
        self.submit("LOOP_STATE", {"type": "loopState", "active": active, "start": start, "end": end})

    def read_live_grid(self):
        """LIVE_GRID (the header: how many tracks, performance mode on) and one LIVE_TRACK per
        playlist track 1...LIVE_TRACK_SCAN: its name, color, mute/solo, getLiveTrigSnap and the
        LB_Status_Default bits (LIVE_FILLED / LIVE_SCHEDULED / LIVE_PLAYING) and color of the
        MAX_LIVE_BLOCKS blocks of the window (LIVE overlay, SHIFT + SCENE). Each row is its own key,
        so only the rows that changed go out. The default status mode is the one that tells
        scheduled (queued for its trigger snap) apart from playing; LB_Status_Simplest reports both
        as 2. `getLiveBlockStatus`/`getLiveBlockColor` only report real data while FL's performance
        mode is on (docs/workflow.md, "Playlist probe, 2026-10-20"); off, they read as empty, which
        the overlay shows as a hint to turn it on."""
        if not self.view.live_scenes:
            return
        self.last_live = self.clock()
        offset = self.view.live_offset
        default = getattr(midi, "LB_Status_Default", 0)
        scanned = min(LIVE_TRACK_SCAN, int(_attr(0, playlist, "trackCount")))
        self.submit(
            "LIVE_GRID",
            {"type": "liveGrid", "scanned": scanned, "perf": bool(_attr(False, playlist, "getPerformanceModeState"))},
        )
        keys = []
        for track in range(1, scanned + 1):
            blocks = []
            for i in range(MAX_LIVE_BLOCKS):
                block = offset + i
                status = int(_attr(0, playlist, "getLiveBlockStatus", track, block, default)) & 0x7
                color = 0
                if status & LIVE_FILLED:
                    color = int(_attr(0, playlist, "getLiveBlockColor", track, block)) & 0xFFFFFF
                blocks.append({"status": status, "color": color})
            key = "LIVE_TRACK@%d" % track
            keys.append(key)
            self.submit(
                key,
                {
                    "type": "liveTrack",
                    "offset": offset,
                    "track": track,
                    "name": str(_attr("", playlist, "getTrackName", track)),
                    "color": int(_attr(0, playlist, "getTrackColor", track)) & 0xFFFFFF,
                    "muted": bool(_attr(False, playlist, "isTrackMuted", track)),
                    "solo": bool(_attr(False, playlist, "isTrackSolo", track)),
                    "trigSnap": max(0, min(127, int(_attr(0, playlist, "getLiveTrigSnap", track)))),
                    "blocks": blocks,
                },
            )
        self.retain_family("LIVE_TRACK", keys)

    def read_activity(self):
        """ACTIVITY: which channels of the selected channel's bank (CHANNEL_WINDOW channels, the
        pads' bank in PAD MODE) FL is playing now: channels.getActivityLevel(i) > 0, the same test
        Image-Line's Akai Fire script uses to light its channel pads with FL's own notes."""
        self.last_activity = self.clock()
        selected = self.selected_channel_index()
        first = 0 if selected is None else selected - selected % CHANNEL_WINDOW
        stop = min(first + CHANNEL_WINDOW, self.channel_total())
        active = [float(_attr(0.0, channels, "getActivityLevel", i)) > 0 for i in range(first, stop)]
        self.activity_lit = any(active)
        self.submit("ACTIVITY", {"type": "activity", "first": first, "active": active})

    def read_features(self):
        """FEATURES: which of the hidden functions this FL version does not have."""
        self.submit(
            "FEATURES",
            {
                "type": "features",
                "patternLength": not callable(getattr(patterns, "setPatternLength", None)),
                "loop": not (
                    callable(getattr(arrangement, "selectionSet", None))
                    and callable(getattr(arrangement, "selectionClear", None))
                ),
                "browser": not all(callable(getattr(ui, name, None)) for name in BROWSER_FUNCTIONS),
                "picker": not callable(getattr(ui, "showPicker", None)),
            },
        )

    def queue_probe(self, text):
        """One PROBE frame per piece of `text`, always (the verification lines of the setters)."""
        for piece in split_probe_text(text):
            self.probe_count += 1
            self.queue["PROBE@%d" % self.probe_count] = encode({"type": "probe", "text": piece})

    def set_pattern_length(self, number, length):
        """SET_PATTERN_LENGTH: patterns.setPatternLength(number, length), then read it back (PROBE)."""
        function = getattr(patterns, "setPatternLength", None)
        if not callable(function):
            _log_once("patterns.setPatternLength", "missing in this FL version")
            return
        current = int(_safe(1, patterns.patternNumber))
        if not 1 <= number <= max(self.pattern_count(), current):
            return
        length = max(1, min(MAX_PATTERN_LENGTH_STEPS, int(length)))
        argument = max(1, length // STEPS_PER_UNIT)
        try:
            function(number, argument)
            result = "getPatternLength(%d) = %s" % (number, _safe("?", patterns.getPatternLength, number))
        except Exception as error:
            _log_once("patterns.setPatternLength", error)
            result = "error: %s" % (error,)
        self.queue_probe("setPatternLength(%d, %d) -> %s" % (number, argument, result))
        self.mark(*PATTERN_READERS)
        self.mark("pattern_grid")

    def create_pattern(self, number):
        """CREATE_PATTERN: make the (not yet existing) pattern `number` and select it. jumpToPattern creates
        a missing pattern (stub note, NOT VERIFIED live); if FL then did not select `number`, fall back to
        findFirstNextEmptyPat. A PROBE line says what happened."""
        count = self.pattern_count()
        before = int(_safe(1, patterns.patternNumber))
        if not count < number <= MAX_PATTERN_NUMBER:
            return
        _safe(None, patterns.jumpToPattern, number)
        after = int(_safe(before, patterns.patternNumber))
        if after == number:
            self.queue_probe(
                "createPattern(%d): jumpToPattern -> patternNumber %d, patternCount %d -> %d"
                % (number, after, count, self.pattern_count())
            )
        else:
            _safe(None, patterns.findFirstNextEmptyPat, midi.FFNEP_DontPromptName)
            got = int(_safe(after, patterns.patternNumber))
            self.queue_probe(
                "createPattern(%d): jump left %d; findFirstNextEmptyPat -> pattern %d, count %d -> %d"
                % (number, after, got, count, self.pattern_count())
            )
        self.mark(*PATTERN_READERS)

    def double_pattern(self, number):
        """DOUBLE_PATTERN: one undo point, the pattern's length doubled (patterns.setPatternLength), then the
        grid bits of steps 0 ... L-1 of every channel copied to L ... 2L-1, with their step parameters when
        FL lets the script read and write them. The copying runs a few channels per service pass
        (service_double); the grid is sent once when it is over. Only the current pattern: the grid
        functions act on it."""
        function = getattr(patterns, "setPatternLength", None)
        if not callable(function):
            _log_once("patterns.setPatternLength", "missing in this FL version")
            return
        current = int(_safe(1, patterns.patternNumber))
        if self.double_job is not None or number != current or not 1 <= number <= self.pattern_count():
            return
        length = int(_safe(0, patterns.getPatternLength, number)) * STEPS_PER_UNIT
        if length < 1 or length * 2 > MAX_PATTERN_LENGTH_STEPS:
            self.queue_probe("doublePattern(%d) %d -> skipped (at most %d steps)" % (number, length, MAX_PATTERN_LENGTH_STEPS))
            return
        _general(None, "saveUndo", "MK3: double pattern", _undo_flags())
        native = getattr(patterns, "duplicatePatternData", None)
        if callable(native):
            # FL's own (hidden) duplicate: it copies every note, piano roll notes included (owner's
            # try, 2026-10-18), but leaves the length at whatever its content spans; set 2L after it.
            try:
                native(number)
                function(number, length * 2)
                after = int(_safe(0, patterns.getPatternLength, number)) * STEPS_PER_UNIT
                self.queue_probe("doublePattern(%d) %d -> %d (duplicatePatternData)" % (number, length, after))
                self.mark(*PATTERN_READERS)
                self.mark("grid", "undo_state")
                return
            except Exception as error:
                _log_once("patterns.duplicatePatternData", error)
                self.queue_probe("duplicatePatternData(%d) -> error: %s; copying the steps" % (number, error))
        try:
            function(number, length * 2)
        except Exception as error:
            _log_once("patterns.setPatternLength", error)
            self.queue_probe("doublePattern(%d) %d -> error: %s" % (number, length, error))
            return
        self.double_job = {
            "pattern": number,
            "length": length,
            "next": 0,
            "copied_channels": 0,
            "steps": 0,
            "params": _step_param_functions(),
        }
        self.mark(*PATTERN_READERS)

    def pattern_snapshot(self, number):
        """patternCount, the pattern's length (steps) and each channel's grid as a short string (PROBE)."""
        count = self.pattern_count()
        length = int(_safe(0, patterns.getPatternLength, number)) * STEPS_PER_UNIT
        grids = []
        for channel in range(min(self.channel_total(), 8)):
            bits = "".join(
                "x" if _safe(False, channels.getGridBit, channel, step) else "." for step in range(min(length, 64))
            )
            if "x" in bits:
                grids.append("%d:%s" % (channel, bits))
        return "count %d len %d %s" % (count, length, " ".join(grids))

    def double_pattern_native(self, number):
        """SHIFT + DOUBLE, a trial: FL's hidden patterns.duplicatePatternData(number) (one `i` argument,
        found with REA; what it does is NOT VERIFIED), with an undo point first, and a PROBE line with
        the pattern before and after so the owner's first try shows what it does."""
        function = getattr(patterns, "duplicatePatternData", None)
        if not callable(function):
            self.queue_probe("duplicatePatternData: missing in this FL version")
            return
        before = self.pattern_snapshot(number)
        _general(None, "saveUndo", "MK3: duplicate pattern data", _undo_flags())
        try:
            result = function(number)
        except Exception as error:
            self.queue_probe("duplicatePatternData(%d) -> error: %s" % (number, error))
            return
        after = self.pattern_snapshot(int(_safe(number, patterns.patternNumber)))
        self.queue_probe(
            "duplicatePatternData(%d) -> %r; before %s; after (pattern %d) %s"
            % (number, result, before, int(_safe(0, patterns.patternNumber)), after)
        )
        self.mark(*PATTERN_READERS)
        self.mark("grid", "undo_state")

    def service_double(self):
        """Copy the next DOUBLE_CHANNELS_PER_PASS channels of a DOUBLE_PATTERN; at the end read the length
        back, queue the PROBE line and let the grid go out. batching keeps nested service() calls out."""
        job = self.double_job
        if job is None:
            return
        total = self.channel_total()
        self.batching += 1
        try:
            for _ in range(DOUBLE_CHANNELS_PER_PASS):
                if job["next"] >= total:
                    break
                self.double_channel(job, job["next"])
                job["next"] += 1
        finally:
            self.batching -= 1
        if job["next"] < total:
            return
        self.double_job = None
        after = int(_safe(0, patterns.getPatternLength, job["pattern"])) * STEPS_PER_UNIT
        self.queue_probe(
            "doublePattern(%d) %d -> %d, channels %d" % (job["pattern"], job["length"], after, job["copied_channels"])
        )
        self.mark(*PATTERN_READERS)
        self.mark("grid", "undo_state")

    def double_channel(self, job, channel):
        """Copy the steps (and their parameters) of one channel into the second half of the pattern."""
        length, pattern = job["length"], job["pattern"]
        get_param, set_param = job["params"]
        copied = False
        for step in range(length):
            on = bool(_safe(False, channels.getGridBit, channel, step))
            target = length + step
            if bool(_safe(False, channels.getGridBit, channel, target)) != on:
                _safe(None, channels.setGridBit, channel, target, on)
            if not on:
                continue
            copied = True
            job["steps"] += 1
            if get_param is None or set_param is None:
                continue
            for param in STEP_PARAMS:
                try:
                    value = get_param(channel, step, param)
                    set_param(channel, pattern, target, param, value)
                except Exception as error:
                    _log_once("step parameter %d" % param, error)
        if copied:
            job["copied_channels"] += 1

    def set_pattern_color(self, number, color):
        """SET_PATTERN_COLOR: patterns.setPatternColor(number, color), then read it back (PROBE)."""
        function = getattr(patterns, "setPatternColor", None)
        if not callable(function):
            _log_once("patterns.setPatternColor", "missing in this FL version")
            return
        current = int(_safe(1, patterns.patternNumber))
        if not 1 <= number <= max(self.pattern_count(), current):
            return
        color = int(color) & 0xFFFFFF
        try:
            function(number, color)
            got = int(_safe(0, patterns.getPatternColor, number)) & 0xFFFFFF
            result = "getPatternColor(%d) = 0x%06x" % (number, got)
        except Exception as error:
            _log_once("patterns.setPatternColor", error)
            result = "error: %s" % (error,)
        self.queue_probe("setPatternColor(%d, 0x%06x) -> %s" % (number, color, result))
        self.mark(*PATTERN_READERS)

    def set_loop(self, start, end):
        """SET_LOOP: arrangement.selectionSet(start, end) (ticks), or selectionClear() for 0, 0; then
        read it back (PROBE)."""
        clear = start == 0 and end == 0
        function = getattr(arrangement, "selectionClear" if clear else "selectionSet", None)
        if not callable(function):
            _log_once("arrangement.selection", "missing in this FL version")
            return
        if not clear and end <= start:
            return
        label = "selectionClear()" if clear else "selectionSet(%d, %d)" % (start, end)
        try:
            if clear:
                function()
            else:
                function(start, end)
            active = bool(_attr(False, arrangement, "selectionIsActive"))
            got_start = int(_attr(0, arrangement, "selectionStart")) if active else 0
            got_end = int(_attr(0, arrangement, "selectionEnd")) if active else 0
            result = "active=%d start=%d end=%d" % (1 if active else 0, got_start, got_end)
        except Exception as error:
            _log_once("arrangement.selection", error)
            result = "error: %s" % (error,)
        self.queue_probe("%s -> %s" % (label, result))
        self.mark("loop")

    def request_loop(self):
        """REQUEST_LOOP: send LOOP_STATE again, even when it is the same as the last one."""
        self.drop_family("LOOP_STATE")
        self.mark("loop")

    def read_meters(self):
        """Peaks for the mixer window (only called while VIEW has meters on)."""
        total = self.mixer_total()
        offset = self.view.mixer_offset
        stop = min(offset + MIXER_WINDOW, total)
        keys = []
        for first, last in _chunks(offset, stop):
            peaks = [
                [_safe(0.0, mixer.getTrackPeaks, i, 0), _safe(0.0, mixer.getTrackPeaks, i, 1)]
                for i in range(first, last)
            ]
            key = "METERS@%d" % first
            keys.append(key)
            self.submit(key, {"type": "meters", "offset": first, "peaks": peaks})
        self.retain_family("METERS", keys)

    # -- playlist probe ----------------------------------------------------------------------

    def run_probe(self):
        """mk3d asks (ARRANGER opened): read what the performance-mode functions return and send it as
        PROBE lines, one per service pass. Nothing here changes anything in FL."""
        self.probe_todo = probe_lines()
        self.probe_texts = []

    def service_probe(self):
        """Queue one PROBE frame: the next piece of text, building the next line when none is left."""
        if not self.probe_texts and self.probe_todo:
            build = self.probe_todo.pop(0)
            try:
                text = build()
            except Exception as error:
                text = "probe: error %s" % (error,)
            self.probe_texts = split_probe_text(text)
        if not self.probe_texts:
            return
        self.probe_count += 1
        text = self.probe_texts.pop(0)
        self.queue["PROBE@%d" % self.probe_count] = encode({"type": "probe", "text": text})

    # -- playlist markers --------------------------------------------------------------------

    def is_playing(self):
        return bool(_safe(False, transport.isPlaying))

    def marker_name(self, index):
        return str(_attr("", arrangement, "getMarkerName", index)).strip()

    def marker_names(self):
        """The names of the markers, by index, until getMarkerName(i) is empty (at most MAX_MARKERS)."""
        names = []
        while len(names) < MAX_MARKERS:
            name = self.marker_name(len(names))
            if name == "":
                break
            names.append(name)
        return names

    def service_markers(self):
        """Run what is due for the markers: a pending jump when FL has stopped, a scan (only while FL
        is stopped), and one MARKERS frame of the outbox."""
        playing = self.is_playing()
        if self.marker_pending is not None and not playing:
            index, self.marker_pending = self.marker_pending, None
            self.go_to_marker(index)
        if self.marker_stale and not playing:
            self.marker_stale = False
            self.marker_scan = True
        if self.marker_scan:
            self.marker_scan = False
            if playing:
                # A jump while playing is audible: answer with the cache and scan when FL stops.
                self.marker_stale = True
                self.publish_markers()
            else:
                self.scan_markers()
        if self.marker_outbox:
            key, message = self.marker_outbox.pop(0)
            self.submit(key, message)

    def scan_markers(self):
        """Build the marker list by jumping through it (FL must be stopped), then restore the position
        and queue the list for sending. See the header for what is assumed."""
        names = self.marker_names()
        found = []
        if names:  # no names, no markers: nothing to jump through
            start = int(_safe(0, transport.getSongPos, SONGLENGTH_ABSTICKS))
            try:
                transport.setSongPos(0, SONGLENGTH_ABSTICKS)
                arrangement.jumpToMarker(0, False)
                last = int(transport.getSongPos(SONGLENGTH_ABSTICKS))
                if last > 0:
                    found.append(last)  # jumpToMarker(0) took us to the first marker ahead
                while len(found) < MAX_MARKERS:
                    arrangement.jumpToMarker(1, False)
                    position = int(transport.getSongPos(SONGLENGTH_ABSTICKS))
                    if position <= last:
                        break
                    found.append(position)
                    last = position
            except Exception as error:
                _log_once("marker scan", error)
            finally:
                _safe(None, transport.setSongPos, start, SONGLENGTH_ABSTICKS)
                self.mark("song_pos")
        if len(found) != len(names):
            # The scan and the names disagree (a marker at tick 0 is not reached by a jump, or a jump
            # went wrong): which time belongs to which name is unknown, so the times are.
            if names:
                _log_once("marker scan", "%d times for %d names: times unknown" % (len(found), len(names)))
            found = [None] * len(names)
        self.markers = list(zip(found, names))
        self.publish_markers()

    def publish_markers(self):
        """Queue the cached list as MARKERS frames of at most 8 entries; one goes out per service pass."""
        ppq = int(_general(DEFAULT_PPQ, "getRecPPQ"))
        total = len(self.markers)
        chunks = []
        for first, last in _chunks(0, total, MARKERS_PER_FRAME):
            entries = [{"ticks": t, "name": n} for t, n in self.markers[first:last]]
            message = {"type": "markers", "total": total, "offset": first, "entries": entries, "ppq": ppq}
            chunks.append(("MARKERS@%d" % first, message))
        self.retain_family("MARKERS", [key for key, _ in chunks])
        self.marker_outbox = chunks

    def request_markers(self):
        """mk3d asks (ARRANGER or SCENE opened): send the list again, scanned afresh when stopped."""
        self.drop_family("MARKERS")
        self.marker_scan = True

    def go_to_marker(self, index):
        # A marker whose time is unknown cannot be jumped to.
        if 0 <= index < len(self.markers) and self.markers[index][0] is not None:
            _safe(None, transport.setSongPos, self.markers[index][0], SONGLENGTH_ABSTICKS)
            self.mark("song_pos")

    def jump_marker(self, index, quantized):
        """JUMP_MARKER: now, or (while playing, `quantized`) at the next bar from OnUpdateBeatIndicator."""
        if not 0 <= index < len(self.markers):
            return
        if quantized and self.is_playing():
            self.marker_pending = index
            return
        self.marker_pending = None
        self.go_to_marker(index)

    def on_beat(self, value):
        """OnUpdateBeatIndicator: value 1 is a bar. A quantized jump that waits runs now."""
        if value != 1 or self.marker_pending is None:
            return
        index, self.marker_pending = self.marker_pending, None
        self.go_to_marker(index)
        self.service()

    def add_marker(self):
        """ADD_MARKER: a marker `MK3 n` at the play position, one undo step."""
        ticks = int(_safe(0, transport.getSongPos, SONGLENGTH_ABSTICKS))
        name = "MK3 %d" % (len(self.markers) + 1)
        _general(None, "saveUndo", "MK3: add marker", getattr(midi, "UF_PLMarker", 1 << 11))
        _attr(None, arrangement, "addAutoTimeMarker", ticks, name)
        self.mark("undo_state")
        if self.is_playing():
            # No scan while playing: show the new marker from what we know and scan when FL stops.
            self.markers.append((ticks, name))
            if all(marker[0] is not None for marker in self.markers):
                self.markers.sort(key=lambda marker: marker[0])
            self.marker_stale = True
            self.publish_markers()
        else:
            self.marker_scan = True

    def set_loop_mode(self, song):
        """SET_LOOP_MODE: setLoopMode() only toggles, so call it when the mode differs."""
        if int(self.loop_mode()) != (1 if song else 0):
            _attr(None, transport, "setLoopMode")

    def playlist_view(self, what, delta):
        """PLAYLIST_VIEW: zoom (ui.horZoom) or scroll (ui.jog) the playlist, focused first."""
        try:
            if not ui.getFocused(PLAYLIST_WINDOW):
                ui.showWindow(PLAYLIST_WINDOW)
                ui.setFocused(PLAYLIST_WINDOW)
            if what == "zoom":
                ui.horZoom(delta)
            else:
                ui.jog(delta)
        except Exception as error:
            _log_once("playlist view", error)

    def set_song_pos(self, ticks):
        _safe(None, transport.setSongPos, ticks, SONGLENGTH_ABSTICKS)
        self.mark("song_pos")

    # -- commands from mk3d ------------------------------------------------------------------

    def handle(self, message):
        """Run a decoded mk3d -> FL command. Returns True when it was a known command."""
        kind = message["type"]
        if kind == "requestState":
            self.reset_cache()
            self.reset_follow()
            self.pg_todo = []
            self.pg_pattern = None
            self.names_pending = True  # mk3d forgets everything on HELLO
            self.marker_outbox = []
            self.marker_scan = True  # scanned when FL is stopped, else the cache is sent
            self.submit("HELLO", {"type": "hello", "version": PROTOCOL_VERSION})
            self.mark_all()
            self.last_full = None
        elif kind == "view":
            self.apply_view(message)
        elif kind == "selectChannel":
            index = message["index"]
            if 0 <= index < self.channel_total():
                old = self.follow_source(index)
                channels.selectOneChannel(index)
                if old is not None:
                    self.follow_editor(old, index)
            self.mark(*CHANNEL_READERS)
        elif kind == "setChannel":
            self.set_channel(message["index"], message["what"], message["value"])
            self.mark("channels", "selected_channel", "channel_detail")
        elif kind == "setChannelTrack":
            if 0 <= message["index"] < self.channel_total() and 0 <= message["track"] < self.mixer_total():
                channels.setTargetFxTrack(message["index"], message["track"])
            self.mark("channel_detail")
        elif kind == "showEditor":
            if 0 <= message["index"] < self.channel_total():
                channels.showEditor(message["index"])
                self.seen_open.add(message["index"])  # the user's explicit open
        elif kind == "setStep":
            if 0 <= message["channel"] < self.channel_total():
                channels.setGridBit(message["channel"], message["step"], bool(message["on"]))
            self.mark("grid")
        elif kind == "selectTrack":
            if 0 <= message["index"] < self.mixer_total():
                mixer.setTrackNumber(message["index"])
            self.mark(*MIXER_READERS)
        elif kind == "setTrack":
            self.set_track(message["index"], message["what"], message["value"])
            self.mark(*MIXER_READERS)
        elif kind == "setParam":
            self.set_param(message["param"], message["value"])
            self.mark("params")
        elif kind == "selectPattern":
            number = message["number"]
            current = int(_safe(1, patterns.patternNumber))
            # jumpToPattern creates patterns that do not exist; do not let a bad number do that.
            if 1 <= number <= max(self.pattern_count(), current):
                patterns.jumpToPattern(number)
            self.mark(*PATTERN_READERS)
        elif kind == "clonePattern":
            self.clone_pattern(message["number"])
            self.mark(*PATTERN_READERS)
        elif kind == "newPattern":
            patterns.findFirstNextEmptyPat(midi.FFNEP_DontPromptName)
            self.mark(*PATTERN_READERS)
        elif kind == "clearSteps":
            self.clear_steps(message["channel"])
            self.mark("grid", "undo_state")
        elif kind == "setTempo":
            self.set_tempo(message["bpm"])
            self.mark("transport")
        elif kind == "setSwing":
            self.set_swing(message["value"])
            self.mark("transport")
        elif kind == "setMainVolume":
            self.set_main_volume(message["value"])
            self.mark("transport")
        elif kind == "showWindow":
            self.show_window(message["window"])
            self.mark("ui_state")
        elif kind == "setSnap":
            self.set_snap(message["mode"])
            self.mark("ui_state")
        elif kind == "presetStep":
            self.step_preset(message["dir"])
            self.mark("presets")
        elif kind == "presetWindow":
            self.window_presets(message["offset"])
            self.mark("presets")
        elif kind == "presetLoad":
            self.load_preset(message["index"])
            self.mark("presets")
        elif kind == "jumpMarker":
            self.jump_marker(message["index"], message["quantized"])
        elif kind == "addMarker":
            self.add_marker()
        elif kind == "setLoopMode":
            self.set_loop_mode(message["song"])
            self.mark("transport")
        elif kind == "playlistView":
            self.playlist_view(message["what"], message["delta"])
        elif kind == "requestMarkers":
            self.request_markers()
        elif kind == "setSongPos":
            self.set_song_pos(message["ticks"])
        elif kind == "runProbe":
            self.run_probe()
        elif kind == "setPatternLength":
            self.set_pattern_length(message["pattern"], message["length"])
        elif kind == "setPatternColor":
            self.set_pattern_color(message["pattern"], message["color"])
        elif kind == "doublePattern":
            if message.get("native"):
                self.double_pattern_native(message["pattern"])
            else:
                self.double_pattern(message["pattern"])
        elif kind == "createPattern":
            self.create_pattern(message["number"])
        elif kind == "setLoop":
            self.set_loop(message["start"], message["end"])
        elif kind == "requestLoop":
            self.request_loop()
        elif kind == "strip":
            self.set_strip(message["kind"], message["value"], message["release"])
        elif kind == "transpose":
            self.transpose(message["channel"], message["semitones"])
            self.mark("grid", "undo_state")
        elif kind == "browse":
            self.browse(message["action"])
        elif kind == "uiKey":
            self.ui_key(message["key"])
        elif kind == "picker":
            self.picker(message["show"], message["mode"])
        elif kind == "triggerLiveClip":
            self.trigger_live_clip(message["block"], message.get("release", False))
        elif kind == "ui":
            self.run_ui(message["action"])
            self.mark_all()
            self.mark("undo_state")
        else:
            return False
        return True

    def trigger_live_clip(self, block, release=False):
        """Fire scene `block` the way Image-Line's Akai Fire script launches one: a single
        playlist.triggerLiveClip(track, block, TLC_MuteOthers | TLC_Fill | TLC_ColumnMode
        [| TLC_GlobalSnap while FL's snap is on]) on the first LIVE_TRACK_SCAN track that is filled
        at `block` (checked fresh); ColumnMode makes FL fire that block on every track. `release`
        (the pad came up) repeats the press's call with TLC_Release. Block None stops every
        scanned track: triggerLiveClip(track, -1, TLC_MuteOthers | TLC_Fill), as the Fire's track
        stop buttons do. Needs FL's performance mode on to do anything audible."""
        scanned = min(LIVE_TRACK_SCAN, int(_attr(0, playlist, "trackCount")))
        if block is None:
            self.live_held.clear()
            for track in range(1, scanned + 1):
                _attr(None, playlist, "triggerLiveClip", track, -1, TLC_MUTE_OTHERS | TLC_FILL)
            self.mark("live_grid")
            return
        if release:
            held = self.live_held.pop(block, None)
            if held is not None:
                track, flags = held
                _attr(None, playlist, "triggerLiveClip", track, block, flags | TLC_RELEASE)
            return
        default = getattr(midi, "LB_Status_Default", 0)
        for track in range(1, scanned + 1):
            if int(_attr(0, playlist, "getLiveBlockStatus", track, block, default)) & LIVE_FILLED:
                break
        else:
            return  # nothing at this block on the scanned tracks
        flags = TLC_MUTE_OTHERS | TLC_FILL | TLC_COLUMN_MODE
        if int(_safe(SNAP_NONE, ui.getSnapMode)) != SNAP_NONE:
            flags |= TLC_GLOBAL_SNAP
        _attr(None, playlist, "triggerLiveClip", track, block, flags)
        self.live_held[block] = (track, flags)
        self.mark("live_grid")

    def clone_pattern(self, number):
        """Clone pattern `number` (1-based) and make sure the clone is the selected pattern."""
        current = int(_safe(1, patterns.patternNumber))
        count = self.pattern_count()
        if not 1 <= number <= max(count, current):
            return
        patterns.clonePattern(number)
        # FL selects the clone itself (NOT VERIFIED). If it did not, and a pattern was added, take
        # the one after the source, where FL is assumed to insert it.
        selected = int(_safe(current, patterns.patternNumber))
        if selected == current and self.pattern_count() > count:
            patterns.jumpToPattern(min(number + 1, self.pattern_count()))

    def pattern_length(self):
        """Steps in the current pattern."""
        number = int(_safe(1, patterns.patternNumber))
        return int(_safe(0, patterns.getPatternLength, number)) * STEPS_PER_UNIT

    def clear_steps(self, channel, undo_name="MK3: clear steps"):
        """Turn off every step of `channel` in the current pattern: one undo point, one batch."""
        if not 0 <= channel < self.channel_total():
            return
        length = self.pattern_length()
        with self.batch(undo_name):
            for step in range(length):
                channels.setGridBit(channel, step, False)

    def transpose(self, channel, semitones):
        """TRANSPOSE: the step notes of `channel` in the current pattern by `semitones` (one undo point)."""
        if not 0 <= channel < self.channel_total() or semitones == 0:
            return
        changed = self.transpose_steps(channel, semitones)
        self.queue_probe("transpose(ch %d, %+d): steps %d changed" % (channel, semitones, changed))

    def transpose_steps(self, channel, semitones):
        """The step path: pitch + semitones (0...127) for every step that is on. Returns how many steps
        changed. One undo point (the batch), setGridBit is not called."""
        get_param, set_param = _step_param_functions()
        pitch = getattr(midi, "pPitch", 0)
        uses_steps = bool(_attr(True, channels, "isGridBitAssigned", channel))
        pattern = int(_safe(1, patterns.patternNumber))
        length = self.pattern_length()
        changed = 0
        with self.batch("MK3: transpose"):
            if get_param is None or set_param is None or not uses_steps:
                return 0
            for step in range(length):
                if not _safe(False, channels.getGridBit, channel, step):
                    continue
                try:
                    value = int(get_param(channel, step, pitch))
                    target = max(0, min(127, value + semitones))
                    if target != value:
                        set_param(channel, pattern, step, pitch, target)
                        changed += 1
                except Exception as error:
                    _log_once("transpose step", error)
        return changed

    def copy_steps(self):
        """Step clipboard: remember the selected channel's steps of the current pattern."""
        index = self.selected_channel_index()
        if index is None:
            return
        self.step_clipboard = [
            bool(_safe(False, channels.getGridBit, index, step)) for step in range(self.pattern_length())
        ]

    def paste_steps(self):
        """Write the step clipboard into the selected channel of the current pattern, up to the
        shorter of the two lengths. One undo point, one batch."""
        index = self.selected_channel_index()
        clip = self.step_clipboard
        if index is None or clip is None:
            return
        count = min(len(clip), self.pattern_length())
        with self.batch("MK3: paste steps"):
            for step in range(count):
                channels.setGridBit(index, step, clip[step])

    def cut_steps(self):
        """Copy, then clear the selected channel's steps (one undo point)."""
        index = self.selected_channel_index()
        if index is None:
            return
        self.copy_steps()
        self.clear_steps(index, "MK3: cut steps")

    def follow_source(self, new):
        """The currently selected channel when the editor should follow the selection to `new`:
        a generator window is focused and it belongs to that channel. None otherwise or on error."""
        try:
            old = self.selected_channel_index()
            if old is None or old == new:
                return None
            if self.focused_generator() != old:
                return None
            return old
        except Exception as error:
            _log_once("follow check", error)
            return None

    def follow_editor(self, old, new):
        """Open and focus the editor of `new` (just selected), close `old` if we opened it."""
        try:
            claimed = new not in self.seen_open and new not in self.follow_opened
            if claimed:
                self.follow_opened.add(new)  # before the focus change arrives in OnRefresh
            try:
                channels.showEditor(new, 1)
                channels.focusEditor(new)
            except Exception:
                if claimed:
                    self.follow_opened.discard(new)
                raise
            if old in self.follow_opened:
                channels.showEditor(old, 0)
                self.follow_opened.discard(old)
            _log("editor follows: channel %d -> %d" % (old, new))
        except Exception as error:
            _log_once("editor follow", error)

    def apply_view(self, message):
        old = self.view
        new = View()
        new.channel_offset = message["channelOffset"]
        new.mixer_offset = message["mixerOffset"]
        new.pattern_offset = message["patternOffset"]
        new.step_offset = message["stepOffset"]
        new.meters = bool(message["meters"])
        new.presets = bool(message.get("presets", False))
        new.pattern_grid = bool(message.get("patternGrid", False))
        new.params = list(message["params"])[:MAX_WATCHED_PARAMS]
        new.live_scenes = bool(message.get("liveScenes", False))
        new.live_offset = message.get("liveOffset", 0)
        self.view = new
        # The cache is per key; after a window moves, mk3d has dropped the old window, so forget
        # what was sent for that family.
        if new.channel_offset != old.channel_offset:
            self.drop_family("CHANNELS")
            self.mark("channels")
        if new.mixer_offset != old.mixer_offset:
            self.drop_family("MIXER")
            self.drop_family("METERS")
            self.mark("mixer")
        if new.pattern_offset != old.pattern_offset:
            self.drop_family("PATTERNS")
            self.mark("patterns")
        if new.step_offset != old.step_offset:
            self.mark("grid")
        if new.params != old.params:
            self.drop_family("PLUGIN_PARAMS")
            self.mark("params")
        if new.meters != old.meters:
            self.drop_family("METERS")
            self.last_meters = None
        if new.pattern_grid != old.pattern_grid:
            # mk3d keeps the steps it was sent: when the overview comes back, send every chunk again.
            self.drop_family("PATTERN_GRID")
            self.pg_todo = []
            self.pg_pattern = None
            self.mark("pattern_grid")
        elif new.pattern_grid and (
            new.channel_offset != old.channel_offset or new.step_offset != old.step_offset
        ):
            self.mark("pattern_grid")  # another bank or page: its chunks first
        if new.presets != old.presets:
            # mk3d keeps the last PRESETS it saw: send them again when it starts to watch, and read
            # the names afresh (the plugin may have changed meanwhile).
            self.drop_family("PRESETS")
            self.presets = None
            self.mark("presets")
        if new.live_scenes != old.live_scenes or new.live_offset != old.live_offset:
            # Opened, closed or a different window: mk3d has dropped the old one, send fresh.
            self.drop_family("LIVE_GRID")
            self.mark("live_grid")

    def set_channel(self, index, what, value):
        if not 0 <= index < self.channel_total():
            return
        if what == "volume":
            channels.setChannelVolume(index, value)
        elif what == "pan":
            channels.setChannelPan(index, value * 2.0 - 1.0)
        elif what == "mute":
            want = value > 0.5
            if bool(channels.isChannelMuted(index)) != want:
                channels.muteChannel(index)  # toggles
        elif what == "pitch":
            channels.setChannelPitch(index, value * 2.0 - 1.0, 0)  # mode 0: factor of the range
        elif what == "cutoff" or what == "resonance":
            event = midi.REC_Chan_FCut if what == "cutoff" else midi.REC_Chan_FRes
            amount = _clamp_int(_clamp01(value) * REC_VALUE_MAX, REC_VALUE_MAX)
            general.processRECEvent(channels.getRecEventId(index) + event, amount, midi.REC_MIDIController)
        elif what == "solo":
            if bool(channels.isChannelSolo(index)) != (value > 0.5):
                channels.soloChannel(index)  # toggles

    # -- touch strip -------------------------------------------------------------------------

    def set_strip(self, kind, value, release):
        """STRIP: the touch strip's pitch, mod or perform value for the selected channel."""
        index = self.selected_channel_index()
        if kind == "perform":
            if release:
                self.end_perform()
            elif index is not None:
                self.sweep_perform(index, value)
            return
        if index is None:
            return
        if kind == "pitch":
            # The bend belongs to the channel the touch started on: a release after a channel change
            # (or the first value on another channel) resets that one.
            old = self.pitch_index
            if release:
                channels.setChannelPitch(index if old is None else old, 0.0, 0)
                self.pitch_index = None
            else:
                if old is not None and old != index:
                    channels.setChannelPitch(old, 0.0, 0)
                bend = max(-1.0, min(1.0, (value - 8192) / 8192.0))
                channels.setChannelPitch(index, bend, 0)  # mode 0: factor of the pitch bend range
                self.pitch_index = index
        elif kind == "mod":
            # Only VSTs have the CC parameters; mk3d sends a raw CC 1 for the others.
            if bool(_safe(False, plugins.isValid, index)) and int(_safe(0, plugins.getParamCount, index)) >= VST_CC_PARAM_COUNT:
                plugins.setParamValue(_clamp01(value / float(STRIP_MOD_MAX)), VST_CC_PARAM_BASE + STRIP_MOD_CC, index)

    def perform_param(self, index):
        """The index of the selected channel's plugin filter cutoff parameter, None for "use the channel
        cutoff". Decided once per (channel, plugin) from the parameter names and logged as a PROBE line."""
        valid = bool(_safe(False, plugins.isValid, index))
        name = str(_safe("", plugins.getPluginName, index)) if valid else ""
        key = (index, name)
        if key in self.strip_params:
            return self.strip_params[key]
        names = None
        if valid and self.scan is not None and self.scan["done"] and self.scan["key"][:2] == key:
            names = self.scan["names"]
        if names is None:
            # The names are not read yet (or not for this plugin): sweep the channel cutoff this once.
            return None
        found = None
        best = 0
        for param, param_name in enumerate(names[:PERFORM_SCAN_LIMIT]):
            score = perform_score(param_name)
            if score > best:
                found, best = param, score
        self.strip_params[key] = found
        if found is None:
            self.queue_probe("perform: %s -> channel cutoff" % (name or "no plugin"))
        else:
            self.queue_probe('perform: %s -> param %d "%s"' % (name, found, names[found]))
        return found

    def sweep_perform(self, index, value):
        """PERFORM: remember the filter's value at the start of a touch, then follow the finger."""
        norm = _clamp01(value / float(STRIP_VALUE_MAX))
        if self.perform is not None and self.perform["index"] != index:
            self.end_perform()  # the channel changed under the finger: give the old one back
        if self.perform is None:
            param = self.perform_param(index)
            if param is not None:
                before = float(_safe(0.0, plugins.getParamValue, param, index))
            else:
                rec = _safe(None, channels.getRecEventId, index)
                before = self.read_rec_norm(rec + midi.REC_Chan_FCut) if rec is not None else 0.0
            self.perform = {"index": index, "param": param, "before": before}
        self.write_perform(self.perform, norm)

    def write_perform(self, sweep, norm):
        if sweep["param"] is not None:
            plugins.setParamValue(norm, sweep["param"], sweep["index"])
        else:
            self.set_channel(sweep["index"], "cutoff", norm)

    def end_perform(self):
        """The touch ended (or must not count any more): put the value from before the touch back."""
        sweep = self.perform
        self.perform = None
        if sweep is not None:
            self.write_perform(sweep, sweep["before"])

    def set_track(self, index, what, value):
        if not 0 <= index < self.mixer_total():
            return
        want = value > 0.5
        if what == "volume":
            mixer.setTrackVolume(index, value)
        elif what == "pan":
            mixer.setTrackPan(index, value * 2.0 - 1.0)
        elif what == "mute":
            if bool(mixer.isTrackMuted(index)) != want:
                mixer.muteTrack(index)  # toggles
        elif what == "solo":
            if bool(mixer.isTrackSolo(index)) != want:
                mixer.soloTrack(index)  # toggles
        elif what == "arm":
            if bool(mixer.isTrackArmed(index)) != want:
                mixer.armTrack(index)  # toggles

    def set_tempo(self, bpm):
        """Set the project tempo (BPM, clamped to FL's 10...522) through its REC event."""
        bpm = max(TEMPO_MIN, min(TEMPO_MAX, float(bpm)))
        try:
            flags = midi.REC_UpdateValue | midi.REC_UpdateControl
            general.processRECEvent(midi.REC_Tempo, _round(bpm * 1000), flags)
        except Exception as error:
            _log_once("set tempo", error)

    def set_swing(self, value):
        """Set the main swing (0...1 of its range) through its REC event."""
        try:
            amount = _clamp_int(_clamp01(value) * REC_VALUE_MAX, REC_VALUE_MAX)
            flags = midi.REC_MIDIController | midi.REC_UpdateControl
            general.processRECEvent(midi.REC_MainShuffle, amount, flags)
        except Exception as error:
            _log_once("set swing", error)

    def set_main_volume(self, value):
        """Set FL's main volume (0...1 of its range) through its REC event, like the swing."""
        try:
            amount = _clamp_int(_clamp01(value) * REC_VALUE_MAX, REC_VALUE_MAX)
            flags = midi.REC_MIDIController | midi.REC_UpdateControl
            general.processRECEvent(midi.REC_MainVol, amount, flags)
        except Exception as error:
            _log_once("set main volume", error)

    def show_window(self, window):
        """A focused window is hidden; any other is shown and given the focus."""
        if not 0 <= window < UI_WINDOW_COUNT:
            return
        try:
            if ui.getFocused(window):
                ui.hideWindow(window)
            else:
                ui.showWindow(window)
                ui.setFocused(window)
        except Exception as error:
            _log_once("show window", error)

    # -- plug-in loader trial ------------------------------------------------------------------
    # BROWSE, UI_KEY and PICKER (docs/sysex.md): ONE FL call each, through getattr and try/except. The answer
    # (BROWSER_NODE and one PROBE line with the same facts) goes out on a later service pass, so FL has
    # updated. NOT VERIFIED in a live FL.

    def trial_call(self, label, module, name, *args):
        """module.<name>(*args) for a trial command; returns (ok, result, note). Never raises."""
        function = getattr(module, name, None)
        if not callable(function):
            _log_once("ui." + name, "missing in this FL version")
            self.node_notes.append("ui." + name)
            return False, None, None
        try:
            return True, function(*args), None
        except Exception as error:
            _log_once("ui." + name, error)
            self.node_notes.append("error ui.%s: %s" % (name, error))
            return False, None, str(error)

    def trial_begin(self, label):
        self.node_label = label
        self.node_wait = 1
        self.node_notes = []
        self.node_result = None

    def browse(self, action):
        """BROWSE: one FL browser call."""
        self.trial_begin("browse(%s)" % action)
        if action == "show":
            window = getattr(midi, "widBrowser", 4)
            self.trial_call("show", ui, "showWindow", window)
            self.trial_call("show", ui, "setFocused", window)
        elif action in ("next", "prev"):
            # Round 2 (owner's try 2026-10-19: the caption never moved and the browser never had the focus):
            # focus the browser first, and log what navigateBrowser itself returns.
            window = getattr(midi, "widBrowser", 4)
            self.trial_call("focus", ui, "setFocused", window)
            ok, result, _ = self.trial_call(
                action, ui, "navigateBrowser", NODE_NEXT if action == "next" else NODE_PREV, False
            )
            if ok:
                self.node_result = result
        elif action == "toggle":
            self.trial_call(action, ui, "toggleBrowserNode", -1)
        elif action == "load":
            # Round 3: FL's browser sends the highlighted item to the focused plugin, or the selected channel
            # if none, on Enter (FL release notes: "F5/F6 ... or ENTER or middle click now sends to the focused
            # plugin (or the selected Channel if there's none)"). selectBrowserMenuItem opens FL's File menu.
            window = getattr(midi, "widBrowser", 4)
            self.trial_call("focus", ui, "setFocused", window)
            self.trial_call(action, ui, "enter")
        elif action == "itemMenu":
            # Round 4: the focused browser item's own menu (right click: "Open in new channel", ...) through
            # FL's item-menu transport command (midi.FPT_ItemMenu = 91).
            window = getattr(midi, "widBrowser", 4)
            self.trial_call("focus", ui, "setFocused", window)
            self.trial_call(action, transport, "globalTransport", getattr(midi, "FPT_ItemMenu", 91), 1)
        elif action == "pluginPicker":
            # Round 4: FL's Plugin picker (the toolbar's plug button, F8): midi.FPT_F8 = 67. Picking a generator
            # there adds it as a new channel.
            self.trial_call(action, transport, "globalTransport", getattr(midi, "FPT_F8", 67), 1)
        elif action == "menu":
            self.trial_call(action, ui, "selectBrowserMenuItem")
        elif action == "preview":
            self.trial_call(action, ui, "previewBrowserMenuItem")

    def ui_key(self, key):
        """UI_KEY: a plain FL key (or closing the popup menu) for whatever has the focus."""
        self.trial_begin("key(%s)" % key)
        name = {"closePopup": "closeActivePopupMenu"}.get(key, key)
        self.trial_call(key, ui, name)
        if key in ("up", "down", "left", "right"):
            # Plugin picker browsing sends these at ~15 per second: no BROWSER_NODE / PROBE answer (too chatty).
            self.node_label = None

    def picker(self, show, mode):
        """PICKER: ui.showPicker(show) or ui.showPicker(show, mode)."""
        shown = 1 if show else 0
        if mode is None:
            self.trial_begin("picker(%d)" % shown)
            self.trial_call("picker", ui, "showPicker", shown)
        else:
            self.trial_begin("picker(%d, %d)" % (shown, mode))
            self.trial_call("picker", ui, "showPicker", shown, mode)

    @staticmethod
    def node_text(value):
        text = "" if value is None else str(value)
        return "".join(ch for ch in text if ord(ch) >= 0x20 and ord(ch) != 0x7F)[:NODE_TEXT]

    def service_browser_node(self):
        """Answer a trial command: BROWSER_NODE and a PROBE line with what FL says now."""
        label = self.node_label
        if label is None:
            return
        if self.node_wait > 0:
            self.node_wait -= 1
            return
        self.node_label = None
        missing = list(self.node_notes)

        def ask(name, default, *args):
            function = getattr(ui, name, None)
            if not callable(function):
                if "ui." + name not in missing:
                    missing.append("ui." + name)
                return default
            try:
                return function(*args)
            except Exception as error:
                _log_once("ui." + name, error)
                missing.append("error ui.%s: %s" % (name, error))
                return default

        caption = self.node_text(ask("getFocusedNodeCaption", ""))
        try:
            file_type = int(ask("getFocusedNodeFileType", 0))
        except (TypeError, ValueError):
            file_type = 0
        popup = bool(ask("isInPopupMenu", False))
        browser_focused = bool(ask("getFocused", False, getattr(midi, "widBrowser", 4)))
        form = self.node_text(ask("getFocusedFormCaption", ""))
        hint = self.node_text(ask("getHintMsg", ""))
        form_id = ask("getFocusedFormID", "?")
        self.queue["BROWSER_NODE"] = encode(
            {
                "type": "browserNode",
                "caption": caption,
                "fileType": file_type,
                "popup": popup,
                "browserFocused": browser_focused,
                "otherFormFocused": (not browser_focused) and form != "",
                "formCaption": form,
                "hint": hint,
            }
        )
        if getattr(self, "node_result", None) is not None:
            label = '%s returned "%s"' % (label, self.node_text(self.node_result))
        text = '%s -> %s"%s" type %d popup %d form "%s" id %s hint "%s"' % (
            label,
            ("missing: " + ", ".join(missing) + "; ") if missing else "",
            caption,
            file_type,
            1 if popup else 0,
            form,
            form_id,
            hint,
        )
        self.queue_probe(text)

    def set_snap(self, mode):
        try:
            ui.setSnapMode(mode)
        except Exception as error:
            _log_once("set snap", error)

    def quantize(self, start_only):
        index = self.selected_channel_index()
        if index is None:
            return
        try:
            channels.quickQuantize(index, start_only)
        except Exception as error:
            _log_once("quantize", error)

    def set_param(self, param, value):
        index = self.selected_channel_index()
        if index is None or not plugins.isValid(index):
            return
        if param >= plugins.getParamCount(index):
            return
        plugins.setParamValue(value, param, index)

    def run_step_edit(self, function):
        """A clipboard action: an error in FL is logged, never raised."""
        try:
            function()
        except Exception as error:
            _log_once("step clipboard", error)

    def run_ui(self, action):
        if action == "up":
            ui.up()
        elif action == "down":
            ui.down()
        elif action == "left":
            ui.left()
        elif action == "right":
            ui.right()
        elif action == "enter":
            ui.enter()
        elif action == "escape":
            ui.escape()
        elif action == "undo":
            general.undoUp()
        elif action == "redo":
            general.undoDown()
        elif action == "save":
            transport.globalTransport(midi.FPT_Save, 1)
        elif action == "saveNew":
            transport.globalTransport(getattr(midi, "FPT_SaveNew", 93), 1)
        elif action == "cut":
            self.run_step_edit(self.cut_steps)
        elif action == "copy":
            self.run_step_edit(self.copy_steps)
        elif action == "paste":
            self.run_step_edit(self.paste_steps)
        elif action == "quantize":
            self.quantize(0)
        elif action == "quantizeStarts":
            self.quantize(1)

    # -- callbacks ---------------------------------------------------------------------------

    def meters_callback(self):
        if not self.view.meters:
            return
        now = self.clock()
        if self.last_meters is not None and now - self.last_meters < METERS_SECONDS:
            return
        self.last_meters = now
        self.read_meters()
        self.flush()


_bridge = Bridge()


# ---------------------------------------------------------------------------------------------
# Control CCs (mk3d -> FL, channel 16, value 127 = trigger)
# ---------------------------------------------------------------------------------------------

def _restart_transport():
    transport.stop()
    transport.start()


CONTROL_ACTIONS = {
    102: lambda: transport.start(),  # play / pause
    103: lambda: transport.stop(),
    104: lambda: transport.record(),  # toggle record arm
    105: lambda: transport.globalTransport(midi.FPT_CountDown, 1),  # toggle count-in
    106: lambda: transport.globalTransport(midi.FPT_Metronome, 1),  # toggle metronome
    107: lambda: transport.globalTransport(midi.FPT_TapTempo, 1),
    108: _restart_transport,  # stop, then start again
}


# ---------------------------------------------------------------------------------------------
# FL callbacks
# ---------------------------------------------------------------------------------------------


def OnInit():
    try:
        device.setHasMeters()
    except Exception as error:
        _log("setHasMeters failed:", error)
    try:
        _bridge.submit("HELLO", {"type": "hello", "version": PROTOCOL_VERSION})
        _bridge.mark_all()
        _bridge.service()
        _log("ready, port", device.getPortNumber())
    except Exception as error:
        _log("OnInit failed:", error)


def OnDeInit():
    try:
        _bridge.end_perform()
    except Exception as error:
        _log("OnDeInit end_perform failed:", error)
    try:
        device.midiOutSysex(encode({"type": "goodbye"}))
    except Exception as error:
        _log("OnDeInit failed:", error)


def _play_channel(index, velocity):
    """PAD MODE: play (velocity > 0) or release (0) the channel with this group-local index."""
    if not 0 <= index < _bridge.channel_total():
        return
    channels.midiNoteOn(channels.getChannelIndex(index), CHANNEL_NOTE_ROOT, velocity)


def OnNoteOn(event):
    try:
        if event.midiChan != CHANNEL_NOTE_CHANNEL:
            event.handled = False  # keyboard mode: the note goes to the selected channel
            return
        event.handled = True
        _play_channel(event.data1, event.data2)  # velocity 0 is a note off
    except Exception as error:
        _log("OnNoteOn failed:", error)


def OnNoteOff(event):
    try:
        if event.midiChan != CHANNEL_NOTE_CHANNEL:
            event.handled = False
            return
        event.handled = True
        _play_channel(event.data1, 0)
    except Exception as error:
        _log("OnNoteOff failed:", error)


def OnKeyPressure(event):
    try:
        # Poly aftertouch on the PAD MODE channel has nothing to act on: swallow it. Aftertouch on
        # channel 1 (keyboard mode) goes on to FL untouched.
        event.handled = event.midiChan == CHANNEL_NOTE_CHANNEL
    except Exception as error:
        _log("OnKeyPressure failed:", error)


def OnPitchBend(event):
    try:
        event.handled = False  # the touch strip's pitch bend goes straight to FL
    except Exception as error:
        _log("OnPitchBend failed:", error)


def OnControlChange(event):
    try:
        # Only our own CCs on channel 16 are ours; every other CC (e.g. the mod wheel from the touch
        # strip on channel 1) goes on to FL untouched.
        action = CONTROL_ACTIONS.get(event.data1) if event.midiChan == CONTROL_CHANNEL else None
        if action is None:
            event.handled = False
            return
        event.handled = True
        if event.data2 > 0:
            action()
            _bridge.mark("transport")
            _bridge.service()
    except Exception as error:
        _log("OnControlChange failed:", error)


def OnSysEx(event):
    try:
        data = bytes(event.sysex)
        if not data.startswith(SYSEX_HEADER):
            return
        event.handled = True
        message = decode(data)
        if message is None:
            return
        _bridge.handle(message)
        _bridge.service()
    except Exception as error:
        _log("OnSysEx failed:", error)


def OnRefresh(flags):
    try:
        _bridge.mark_refresh(flags)
        _bridge.service()
    except Exception as error:
        _log("OnRefresh failed:", error)


def OnDirtyChannel(index):
    try:
        _bridge.mark(*CHANNEL_READERS)
    except Exception as error:
        _log("OnDirtyChannel failed:", error)


def OnDirtyMixerTrack(index):
    try:
        _bridge.mark(*MIXER_READERS)
    except Exception as error:
        _log("OnDirtyMixerTrack failed:", error)


def OnProjectLoad(status):
    try:
        _bridge.mark_all()
        if status not in (midi.PL_Start, getattr(midi, "PL_LoadError", -1)):
            _bridge.marker_stale = True  # a new project: scan its markers as soon as FL is stopped
        if status != midi.PL_Start:
            _bridge.service()
    except Exception as error:
        _log("OnProjectLoad failed:", error)


def OnIdle():
    try:
        _bridge.service()
    except Exception as error:
        _log("OnIdle failed:", error)


def OnUpdateBeatIndicator(value):
    try:
        _bridge.on_beat(value)
    except Exception as error:
        _log("OnUpdateBeatIndicator failed:", error)


def OnUpdateLiveMode(*args):
    """FL: performance-mode state changed (the Fire's signature is OnUpdateLiveMode(LastTrackNum)).
    Read LIVE on the next service pass instead of waiting for the throttle."""
    try:
        _bridge.mark("live_grid")
    except Exception as error:
        _log("OnUpdateLiveMode failed:", error)


def OnUpdateMeters():
    try:
        _bridge.meters_callback()
    except Exception as error:
        _log("OnUpdateMeters failed:", error)
