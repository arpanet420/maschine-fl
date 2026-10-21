"""Tests for fl-script/MK3Bridge/device_MK3Bridge.py with fake FL modules (no FL Studio needed).

Run: npm run test:fl  (python3 -I -m unittest discover -s fl-script/tests -v)
Works on Python 3.9 and 3.12.
"""

import importlib.util
import json
import os
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SCRIPT_PATH = os.path.join(ROOT, "fl-script", "MK3Bridge", "device_MK3Bridge.py")
VECTORS_PATH = os.path.join(ROOT, "test", "fixtures", "sysex-vectors.json")
FL_MIDI_PATH = "/Applications/FL Studio 2026.app/Contents/Resources/FL/Shared/Python/Lib/midi.py"

FAKE_MODULE_NAMES = (
    "arrangement",
    "device",
    "midi",
    "transport",
    "ui",
    "channels",
    "mixer",
    "patterns",
    "playlist",
    "plugins",
    "general",
)


def load_vectors():
    with open(VECTORS_PATH, "r", encoding="utf-8") as handle:
        return json.load(handle)


def make_midi_module():
    """FL's own midi.py when it is installed, else a module with the constants the script uses."""
    if os.path.exists(FL_MIDI_PATH):
        try:
            spec = importlib.util.spec_from_file_location("midi", FL_MIDI_PATH)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
        except Exception:
            pass
    module = types.ModuleType("midi")
    for name, value in dict(
        HW_Dirty_FocusedWindow=32,
        HW_Dirty_Mixer_Sel=1,
        HW_Dirty_Mixer_Display=2,
        HW_Dirty_Mixer_Controls=4,
        HW_Dirty_Patterns=1024,
        HW_Dirty_Tracks=2048,
        HW_Dirty_ControlValues=4096,
        HW_Dirty_Colors=8192,
        HW_Dirty_Names=16384,
        HW_Dirty_ChannelRackGroup=32768,
        HW_Dirty_RemoteLinkValues=512,
        HW_Dirty_Undo=131072,
        HW_Dirty_ChannelRack=262144,
        HW_Dirty_GraphEditor=524288,
        widMixer=0,
        widPluginGenerator=7,
        SONGLENGTH_BARS=3,
        SONGLENGTH_STEPS=4,
        SONGLENGTH_ABSTICKS=2,
        SONGLENGTH_TICKS=5,
        LB_Status_Default=0,
        LB_Status_Simple=1,
        LB_Status_Simplest=2,
        REC_Chan_FCut=2,
        REC_Chan_FRes=3,
        REC_GetValue=2,
        REC_MIDIController=0x1F5,
        REC_InvalidID=0x7FFFFFFF,
        FromMIDI_Max=1073741824,
        REC_Tempo=1073741829,
        REC_MainVol=1073741824,
        REC_MainShuffle=1073741825,
        REC_UpdateValue=1,
        REC_UpdateControl=16,
        widPlugin=5,
        FFNEP_DontPromptName=2,
        UF_None=0,
        UF_PR=2,
        UF_PLMarker=2048,
        FPT_Save=92,
        FPT_SaveNew=93,
        FPN_Patch=3,
        FPN_Preset=6,
        FPT_TapTempo=106,
        FPT_Metronome=110,
        FPT_CountDown=115,
        PL_Start=0,
        PL_LoadOk=100,
        PL_LoadError=101,
    ).items():
        setattr(module, name, value)
    return module


class FakeFL(object):
    """A tiny model of FL's state plus fake versions of the API modules the script imports."""

    def __init__(self, channel_count=24, track_count=127, pattern_count=5):
        self.calls = []  # (function name, args)
        self.sysex_out = []  # frames passed to device.midiOutSysex
        self.raise_on = {}  # function name -> exception to raise
        self.playing = False
        self.activity = {}  # channel index -> channels.getActivityLevel
        self.recording = False
        self.metronome = False
        self.precount = False
        self.tempo_raw = 128500
        self.song_pos = {3: 12, 4: 2, 5: 0}
        self.channels = []
        for i in range(channel_count):
            self.channels.append(
                dict(
                    name="Ch %d" % i,
                    color=0x0000FF if i % 2 == 0 else 0x00FF00,
                    muted=False,
                    selected=(i == 0),
                    volume=0.78125,
                    pan=0.0,
                    pitch=0.0,
                    pitch_range=12,
                    cutoff=1.0,
                    resonance=0.0,
                    solo=False,
                    mixer_track=0,
                    channel_type=2,
                    plugin=dict(
                        name="Plug%d" % i,
                        params=[dict(name="P%d" % p, value=p / 100.0, text="%d%%" % p) for p in range(300)],
                        presets=[],  # preset names; empty = a plugin without programs
                        preset=0,  # the current preset (FPN_Patch is its name)
                    ),
                    grid=set(),
                    step_row=True,  # channels.isGridBitAssigned: uses the step sequencer
                )
            )
        self.tracks = []
        for i in range(track_count):
            self.tracks.append(
                dict(
                    name="Track %d" % i,
                    color=0x123456,
                    volume=0.8,
                    pan=0.0,
                    muted=False,
                    solo=False,
                    armed=False,
                    peaks=(0.0, 0.0),
                )
            )
        self.selected_track = 0
        self.script_midi = None  # set in modules()
        self.rec_writes = []  # (event id, value, flags) passed to general.processRECEvent
        self.pattern_count = pattern_count
        self.pattern = 1
        self.pattern_names = {}
        self.pattern_len_steps = 16
        self.patch_name = None  # what plugins.getName(FPN_Patch) says instead of the current preset
        self.focused_widget = None  # midi.wid* of the focused FL window
        self.focused_form_id = -1  # channel rack index for a generator window
        self.node_caption = "Diva"  # the browser's focused node (plug-in loader trial)
        self.node_type = -1
        self.in_popup = False
        self.form_caption = "Browser"
        self.hint = "Plugin database"
        self.open_editors = set()  # channels whose plugin window is open
        self.group_base = 0  # global index of group-local channel 0 (getChannelIndex adds it)
        self.notes = []  # (global channel index, note, velocity) passed to channels.midiNoteOn
        self.clone_selects = True  # does patterns.clonePattern select the clone, like FL's UI?
        self.swing = 0.0  # main swing, 0...1 (REC_MainShuffle on the 0..FromMIDI_Max scale)
        self.main_volume = 0.8  # FL's main volume, 0...1 (REC_MainVol on the same scale)
        self.undo_names = []  # names passed to general.saveUndo
        self.undo_pos = 0  # general.getUndoHistoryPos()
        self.undo_count = 0  # general.getUndoHistoryCount()
        self.undo_hint = "-"  # general.getUndoLevelHint()
        self.on_set_grid_bit = None  # called after every setGridBit (FL may call back into the script)
        self.snap = 8  # ui.getSnapMode()
        self.marker_ticks = []  # playlist markers (absolute ticks, sorted)
        self.marker_names = {}  # index -> name (default "Marker i")
        self.marker_wrap = False  # does jumpToMarker(1) wrap to the first marker after the last?
        self.loop_mode = 0  # transport.getLoopMode(): 0 pattern, 1 song
        self.ppq = 96
        self.song_pos[2] = 0  # the position in absolute ticks
        self.added_markers = []  # (ticks, name) passed to arrangement.addAutoTimeMarker
        self.visible = set()  # midi.wid* windows that are shown
        self.playlist_tracks = 500  # playlist.trackCount()
        self.perf_mode = False  # playlist.getPerformanceModeState()
        self.muted_tracks = set()  # playlist tracks isTrackMuted reports
        self.solo_tracks = set()
        self.live_blocks = None  # {(track, block): LB_Status_Default bits}; None = the formula fake
        self.song_length = {2: 3840, 3: 10}  # transport.getSongLength(mode)
        self.selection = None  # the playlist time selection (start, end) in ticks, or None
        self.pattern_colors = {}  # pattern number -> color set with patterns.setPatternColor
        self.jump_creates = True  # does patterns.jumpToPattern(n) create a missing pattern n, like FL's docs say?
        self.step_params = {}  # (channel, step, param) -> value of the current pattern's step parameters

    # -- helpers -----------------------------------------------------------------------------

    def rec(self, name, *args):
        self.calls.append((name, args))
        error = self.raise_on.get(name)
        if error is not None:
            raise error

    def called(self, name):
        return [args for (n, args) in self.calls if n == name]

    def channel(self, index):
        if not 0 <= index < len(self.channels):
            raise IndexError("channel %d" % index)
        return self.channels[index]

    def track(self, index):
        if not 0 <= index < len(self.tracks):
            raise IndexError("track %d" % index)
        return self.tracks[index]

    def plugin(self, index):
        return self.channel(index)["plugin"]

    # -- module construction -----------------------------------------------------------------

    def modules(self):
        fl = self
        mods = {}

        def module(name, **functions):
            m = types.ModuleType(name)
            for fname, func in functions.items():
                setattr(m, fname, self._wrap(name + "." + fname, func))
            mods[name] = m
            return m

        def selected_channel(canBeNone=False, offset=0, indexGlobal=False):
            for i, c in enumerate(fl.channels):
                if c["selected"]:
                    return i
            return -1 if canBeNone else 0

        def select_one(index, useGlobalIndex=False):
            fl.channel(index)
            for i, c in enumerate(fl.channels):
                c["selected"] = i == index

        def set_step_param(index, pattern, step, param, value, useGlobalIndex=False):
            fl.step_params[(index, step, param)] = value

        def set_grid_bit(index, position, value, useGlobalIndex=False):
            grid = fl.channel(index)["grid"]
            if value:
                grid.add(position)
            else:
                grid.discard(position)
            if fl.on_set_grid_bit is not None:
                fl.on_set_grid_bit(index, position, value)

        def save_undo(name, flags, update=True):
            fl.undo_names.append(name)
            fl.undo_count += 1
            fl.undo_pos = fl.undo_count
            fl.undo_hint = name

        def undo_up():
            fl.undo_pos = max(0, fl.undo_pos - 1)
            fl.undo_hint = "undo %d/%d" % (fl.undo_pos, fl.undo_count)
            return 0

        def undo_down():
            fl.undo_pos = min(fl.undo_count, fl.undo_pos + 1)
            fl.undo_hint = "redo %d/%d" % (fl.undo_pos, fl.undo_count)
            return 0

        def toggle(store_name, key):
            def func(index, *rest):
                item = getattr(fl, store_name)(index)
                item[key] = not item[key]

            return func

        module(
            "device",
            midiOutSysex=lambda data: fl.sysex_out.append(bytes(data)),
            setHasMeters=lambda: None,
            getPortNumber=lambda: 3,
            # Like FL: 0...1, and -1 for an event ID that doesn't exist.
            getLinkedValue=lambda event_id: (
                lambda raw: -1.0
                if raw == fl.script_midi.REC_InvalidID
                else raw / float(fl.script_midi.FromMIDI_Max)
            )(process_rec(event_id, 0, fl.script_midi.REC_GetValue)),
        )
        mods["midi"] = fl.script_midi = make_midi_module()
        module(
            "transport",
            isPlaying=lambda: fl.playing,
            isRecording=lambda: fl.recording,
            start=lambda: None,
            stop=lambda: None,
            record=lambda: None,
            globalTransport=lambda command, value, *rest: 0,
            getSongPos=lambda mode=-1: fl.song_pos[mode],
            setSongPos=lambda position, mode=-1: fl.song_pos.__setitem__(mode, int(position)),
            getLoopMode=lambda: fl.loop_mode,
            setLoopMode=lambda: setattr(fl, "loop_mode", 1 - fl.loop_mode),
            getSongLength=lambda mode: fl.song_length[mode],
        )

        def jump_to_marker(delta, select=False):
            ticks = fl.marker_ticks
            position = fl.song_pos[2]
            if delta > 0:
                ahead = [t for t in ticks if t > position]
                if ahead:
                    fl.song_pos[2] = ahead[min(delta, len(ahead)) - 1]
                elif fl.marker_wrap and ticks:
                    fl.song_pos[2] = ticks[0]
            elif delta < 0:
                behind = [t for t in ticks if t < position]
                if behind:
                    fl.song_pos[2] = behind[-min(-delta, len(behind))]

        def add_auto_time_marker(time, name):
            fl.added_markers.append((time, name))
            fl.marker_ticks.append(time)
            fl.marker_ticks.sort()
            fl.marker_names[fl.marker_ticks.index(time)] = name

        module(
            "arrangement",
            jumpToMarker=jump_to_marker,
            getMarkerName=lambda index: fl.marker_names.get(
                index, "Marker %d" % index if 0 <= index < len(fl.marker_ticks) else ""
            ),
            addAutoTimeMarker=add_auto_time_marker,
            selectionSet=lambda start, end: setattr(fl, "selection", (start, end)),
            selectionClear=lambda: setattr(fl, "selection", None),
            selectionIsActive=lambda: fl.selection is not None,
            selectionStart=lambda: fl.selection[0] if fl.selection else 0,
            selectionEnd=lambda: fl.selection[1] if fl.selection else 0,
        )
        def live_status(index, block, mode=0):
            if fl.live_blocks is not None:
                return fl.live_blocks.get((index, block), 0) if mode == 0 else 0
            return (index + block) % 3 if mode == 2 else index * 16 + block

        module(
            "playlist",
            getPerformanceModeState=lambda: fl.perf_mode,
            trackCount=lambda: fl.playlist_tracks,
            getSongStartTickPos=lambda: 0,
            getTrackName=lambda index: "Track %d" % index,
            getTrackColor=lambda index: 0x100000 + index,
            isTrackMuted=lambda index: index in fl.muted_tracks,
            isTrackSolo=lambda index: index in fl.solo_tracks,
            getLiveTrigSnap=lambda index: 3,
            getLiveStatus=lambda index, mode=0: index if mode == 2 else index * 256,
            getLiveBlockStatus=live_status,
            getLiveBlockColor=lambda index, block: -1 if block == 15 else 0x123456 + block,
            liveBlockNumToTime=lambda block: block * 384,
            liveTimeToBlockNum=lambda time: time // 96,
            triggerLiveClip=lambda index, subNum, flags, velocity=-1: None,
        )
        module(
            "ui",
            isMetronomeEnabled=lambda: fl.metronome,
            isPrecountEnabled=lambda: fl.precount,
            up=lambda value=1: 0,
            down=lambda value=1: 0,
            left=lambda value=1: 0,
            right=lambda value=1: 0,
            enter=lambda: 0,
            escape=lambda: 0,
            # widget 5 = any plugin window (FL's widPlugin; the generator window is widget 7)
            getFocused=lambda widget: (
                fl.focused_widget in (5, 6, 7) if widget == 5 else fl.focused_widget == widget
            ),
            getFocusedFormID=lambda: fl.focused_form_id,
            getVisible=lambda widget: widget in fl.visible,
            showWindow=lambda widget: fl.visible.add(widget),
            hideWindow=lambda widget: fl.visible.discard(widget),
            setFocused=lambda widget: setattr(fl, "focused_widget", widget),
            navigateBrowser=lambda direction, shift=False: fl.node_caption,
            toggleBrowserNode=lambda value=-1: 0,
            selectBrowserMenuItem=lambda: 0,
            previewBrowserMenuItem=lambda: 0,
            closeActivePopupMenu=lambda: 0,
            isInPopupMenu=lambda: fl.in_popup,
            getFocusedNodeCaption=lambda: fl.node_caption,
            getFocusedNodeFileType=lambda: fl.node_type,
            getFocusedFormCaption=lambda: fl.form_caption,
            getHintMsg=lambda: fl.hint,
            showPicker=lambda show, mode=-1: 0,
            getSnapMode=lambda: fl.snap,
            setSnapMode=lambda value: setattr(fl, "snap", value),
            horZoom=lambda value: 0,
            jog=lambda value: 0,
            cut=lambda: 0,
            copy=lambda: 0,
            paste=lambda: 0,
        )
        def rec_block(index):
            return 0x10000 * (index + 1)  # distinct per channel, like FL's REC_ItemRange blocks

        def rec_base(index, g=False):
            fl.channel(index)
            return rec_block(index)

        def process_rec(event_id, value, flags):
            midi_ = fl.script_midi
            if event_id == midi_.REC_Tempo:
                if flags & midi_.REC_GetValue:
                    return fl.tempo_raw
                fl.rec_writes.append((event_id, value, flags))
                fl.tempo_raw = value
                return 0
            if event_id == midi_.REC_MainVol:
                if flags & midi_.REC_GetValue:
                    return int(fl.main_volume * midi_.FromMIDI_Max)
                fl.rec_writes.append((event_id, value, flags))
                fl.main_volume = value / float(midi_.FromMIDI_Max)
                return 0
            if event_id == midi_.REC_MainShuffle:
                if flags & midi_.REC_GetValue:
                    return int(fl.swing * midi_.FromMIDI_Max)
                fl.rec_writes.append((event_id, value, flags))
                fl.swing = value / float(midi_.FromMIDI_Max)
                return 0
            for i, c in enumerate(fl.channels):
                base = rec_block(i)
                knobs = (
                    (fl.script_midi.REC_Chan_FCut, "cutoff"),
                    (fl.script_midi.REC_Chan_FRes, "resonance"),
                )
                for offset, key in knobs:
                    if event_id != base + offset:
                        continue
                    if flags & fl.script_midi.REC_GetValue:
                        return int(c[key] * fl.script_midi.FromMIDI_Max)
                    fl.rec_writes.append((event_id, value, flags))
                    c[key] = value / float(fl.script_midi.FromMIDI_Max)
                    return 0
            return fl.script_midi.REC_InvalidID

        def get_pitch(index, mode=0, g=False):
            c = fl.channel(index)
            return c["pitch_range"] if mode == 2 else c["pitch"]

        def set_pitch(index, value, mode=0, p=0, g=False):
            fl.channel(index)["pitch"] = value

        def set_target(index, track, g=False):
            fl.channel(index)["mixer_track"] = track

        def show_editor(index, value=-1, g=False):
            fl.channel(index)
            if value == 0 or (value == -1 and index in fl.open_editors):
                fl.open_editors.discard(index)
            else:
                fl.open_editors.add(index)

        def focus_editor(index, g=False):
            fl.channel(index)
            fl.focused_widget = fl.script_midi.widPluginGenerator
            fl.focused_form_id = index

        module(
            "channels",
            channelCount=lambda globalCount=False: len(fl.channels),
            selectedChannel=selected_channel,
            isChannelSelected=lambda i, g=False: fl.channel(i)["selected"],
            isChannelMuted=lambda i, g=False: fl.channel(i)["muted"],
            getChannelColor=lambda i, g=False: fl.channel(i)["color"],
            getActivityLevel=lambda i, g=False: fl.activity.get(i, 0.0),
            getChannelName=lambda i, g=False: fl.channel(i)["name"],
            getChannelVolume=lambda i, mode=False, g=False: fl.channel(i)["volume"],
            getChannelPan=lambda i, g=False: fl.channel(i)["pan"],
            selectOneChannel=select_one,
            setChannelVolume=lambda i, v, p=0, g=False: fl.channel(i).__setitem__("volume", v),
            setChannelPan=lambda i, v, p=0, g=False: fl.channel(i).__setitem__("pan", v),
            muteChannel=toggle("channel", "muted"),
            isChannelSolo=lambda i, g=False: fl.channel(i)["solo"],
            soloChannel=toggle("channel", "solo"),
            getChannelPitch=get_pitch,
            setChannelPitch=set_pitch,
            getRecEventId=rec_base,
            getTargetFxTrack=lambda i, g=False: fl.channel(i)["mixer_track"],
            setTargetFxTrack=set_target,
            getChannelType=lambda i, g=False: fl.channel(i)["channel_type"],
            showEditor=show_editor,
            focusEditor=focus_editor,
            getChannelIndex=lambda i: i + fl.group_base,
            midiNoteOn=lambda i, note, velocity, channel=-1: fl.notes.append((i, note, velocity)),
            getGridBit=lambda i, pos, g=False: pos in fl.channel(i)["grid"],
            isGridBitAssigned=lambda i, g=False: fl.channel(i)["step_row"],
            setGridBit=set_grid_bit,
            quickQuantize=lambda i, startOnly=1, g=False: None,
            getCurrentStepParam=lambda i, step, param, g=False: fl.step_params.get((i, step, param), 0),
            setStepParameterByIndex=set_step_param,
        )
        module(
            "mixer",
            getCurrentTempo=lambda asInt=False: fl.tempo_raw if asInt else fl.tempo_raw / 1000.0,
            trackCount=lambda: len(fl.tracks),
            trackNumber=lambda: fl.selected_track,
            setTrackNumber=lambda n, flags=0: setattr(fl, "selected_track", n),
            isTrackMuted=lambda i: fl.track(i)["muted"],
            isTrackSolo=lambda i: fl.track(i)["solo"],
            isTrackArmed=lambda i: fl.track(i)["armed"],
            getTrackColor=lambda i: fl.track(i)["color"],
            getTrackVolume=lambda i, mode=0: fl.track(i)["volume"],
            getTrackPan=lambda i: fl.track(i)["pan"],
            getTrackName=lambda i: fl.track(i)["name"],
            getTrackPeaks=lambda i, mode: fl.track(i)["peaks"][mode],
            muteTrack=toggle("track", "muted"),
            soloTrack=toggle("track", "solo"),
            armTrack=toggle("track", "armed"),
            setTrackVolume=lambda i, v, p=0: fl.track(i).__setitem__("volume", v),
            setTrackPan=lambda i, v, p=0: fl.track(i).__setitem__("pan", v),
        )
        def clone_pattern(index=None):
            fl.pattern_count += 1
            source = fl.pattern if index is None else index
            if fl.clone_selects:
                fl.pattern = source + 1  # the clone sits right after its source

        def new_pattern(flags, x=-1, y=-1):
            fl.pattern_count += 1
            fl.pattern = fl.pattern_count

        def jump_to_pattern(n):
            if n > fl.pattern_count:
                if not fl.jump_creates:
                    return
                fl.pattern_count = n
            fl.pattern = n

        module(
            "patterns",
            patternNumber=lambda: fl.pattern,
            patternCount=lambda: fl.pattern_count,
            getPatternLength=lambda n: fl.pattern_len_steps,
            getPatternColor=lambda n: fl.pattern_colors.get(n, 0x0C2957),
            setPatternColor=lambda n, color: fl.pattern_colors.__setitem__(n, color),
            setPatternLength=lambda n, length: setattr(fl, "pattern_len_steps", length),
            getPatternName=lambda n: fl.pattern_names.get(n, "Pattern %d" % n),
            jumpToPattern=jump_to_pattern,
            clonePattern=clone_pattern,
            findFirstNextEmptyPat=new_pattern,
        )

        def is_valid(index, slotIndex=-1, useGlobalIndex=False):
            return fl.channel(index)["plugin"] is not None

        def get_name(index, slotIndex=-1, flag=0, paramIndex=0, useGlobalIndex=False):
            plugin = fl.plugin(index)
            if flag == fl.script_midi.FPN_Preset:
                return plugin["presets"][paramIndex]
            if flag == fl.script_midi.FPN_Patch:
                if fl.patch_name is not None:
                    return fl.patch_name
                return plugin["presets"][plugin["preset"]] if plugin["presets"] else ""
            return plugin["name"]

        def step_preset(delta):
            def step(index, slotIndex=-1, useGlobalIndex=False):
                plugin = fl.plugin(index)
                if plugin["presets"]:
                    plugin["preset"] = (plugin["preset"] + delta) % len(plugin["presets"])

            return step

        module(
            "plugins",
            isValid=is_valid,
            getPresetCount=lambda i, s=-1, g=False: len(fl.plugin(i)["presets"]),
            getName=get_name,
            nextPreset=step_preset(1),
            prevPreset=step_preset(-1),
            getPluginName=lambda i, s=-1, u=False, g=False: fl.plugin(i)["name"],
            getParamCount=lambda i, s=-1, g=False: len(fl.plugin(i)["params"]),
            getParamName=lambda p, i, s=-1, g=False: fl.plugin(i)["params"][p]["name"],
            getParamValue=lambda p, i, s=-1, g=False: fl.plugin(i)["params"][p]["value"],
            getParamValueString=lambda p, i, s=-1, pm=0, g=False: fl.plugin(i)["params"][p]["text"],
            setParamValue=lambda v, p, i, s=-1, pm=0, g=False: fl.plugin(i)["params"][p].__setitem__("value", v),
        )
        module(
            "general",
            undoUp=undo_up,
            undoDown=undo_down,
            processRECEvent=process_rec,
            saveUndo=save_undo,
            getUndoHistoryPos=lambda: fl.undo_pos,
            getUndoHistoryCount=lambda: fl.undo_count,
            getUndoLevelHint=lambda: fl.undo_hint,
            getRecPPQ=lambda: fl.ppq,
        )
        return mods

    def _wrap(self, qualified, func):
        """Record the call (module.function, args) and run it; raise_on can force an error."""
        fl = self

        def wrapper(*args):
            fl.rec(qualified, *args)
            return func(*args)

        wrapper.__name__ = qualified
        return wrapper


class Event(object):
    def __init__(self, sysex=None, midiChan=0, data1=0, data2=0):
        self.sysex = sysex
        self.midiChan = midiChan
        self.data1 = data1
        self.data2 = data2
        self.handled = None


class Clock(object):
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class BridgeTestCase(unittest.TestCase):
    channel_count = 24

    def setUp(self):
        self.fl = FakeFL(channel_count=self.channel_count)
        self._saved = dict((name, sys.modules.get(name)) for name in FAKE_MODULE_NAMES)
        sys.modules.update(self.fl.modules())
        spec = importlib.util.spec_from_file_location("device_MK3Bridge_under_test", SCRIPT_PATH)
        self.script = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.script)
        self.clock = Clock()
        self.script._bridge.clock = self.clock
        self.script._logged_errors.clear()
        self.addCleanup(self._restore_modules)

    def _restore_modules(self):
        for name, module in self._saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    # -- helpers -----------------------------------------------------------------------------

    @property
    def bridge(self):
        return self.script._bridge

    def drain(self):
        """Run OnIdle until nothing is left to send; returns all frames sent meanwhile."""
        frames = []
        for _ in range(200):
            before = len(self.fl.sysex_out)
            self.script.OnIdle()
            sent = self.fl.sysex_out[before:]
            frames.extend(sent)
            if not sent and not self.bridge.queue and not self.bridge.dirty and not self.bridge.pg_todo:
                return frames
        self.fail("queue never drained")

    def take(self):
        frames = self.fl.sysex_out[:]
        del self.fl.sysex_out[:]
        return frames

    def start(self):
        """OnInit and drain; returns everything sent."""
        self.script.OnInit()
        self.drain()
        return self.take()

    def settle(self):
        """Advance past the 100 ms re-read, drain, and return what was sent."""
        self.clock.advance(0.2)
        self.drain()
        return self.take()

    def send(self, message_hex_or_bytes):
        data = message_hex_or_bytes
        if isinstance(data, str):
            data = bytes.fromhex(data)
        event = Event(sysex=data)
        self.script.OnSysEx(event)
        return event

    @staticmethod
    def command(frame):
        return frame[4]

    def frames_with(self, frames, command):
        return [f for f in frames if self.command(f) == command]


class CodecTests(BridgeTestCase):
    def test_every_from_fl_vector_encodes_to_its_hex(self):
        vectors = [v for v in load_vectors() if v["direction"] == "fromFl"]
        self.assertGreater(len(vectors), 10)
        for vector in vectors:
            with self.subTest(vector["name"]):
                self.assertEqual(self.script.encode(vector["message"]).hex(), vector["hex"])

    def test_every_to_fl_vector_decodes(self):
        vectors = [v for v in load_vectors() if v["direction"] == "toFl"]
        self.assertGreater(len(vectors), 5)
        for vector in vectors:
            with self.subTest(vector["name"]):
                decoded = self.script.decode(bytes.fromhex(vector["hex"]))
                expected = vector["message"]
                self.assertIsNotNone(decoded)
                self.assertEqual(sorted(decoded), sorted(expected))
                for key, want in expected.items():
                    got = decoded[key]
                    if isinstance(want, float) and not isinstance(want, bool):
                        self.assertAlmostEqual(got, want, delta=0.001, msg=key)
                    else:
                        self.assertEqual(got, want, key)

    def test_rounding_is_floor_plus_half(self):
        self.assertEqual(self.script._round(0.5), 1)
        self.assertEqual(self.script._round(2.5), 3)
        self.assertEqual(self.script._round(3.5), 4)
        self.assertEqual(self.script.enc_u21(0.005 * 100 + 0.0), bytes([0, 0, 1]))  # 0.5 -> 1
        self.assertEqual(self.script.enc_u7(126.5), bytes([127]))

    def test_norm_clamps_and_pan_maps(self):
        s = self.script
        self.assertEqual(s.enc_norm(-3), bytes([0, 0]))
        self.assertEqual(s.enc_norm(7), bytes([0x7F, 0x7F]))
        self.assertEqual(s.enc_norm(float("nan")), bytes([0, 0]))
        self.assertEqual(s.enc_pan(-1), bytes([0, 0]))
        self.assertEqual(s.enc_pan(1), bytes([0x7F, 0x7F]))

    def test_string_encoding(self):
        s = self.script
        self.assertEqual(s.enc_str("ab\x01c\x7f"), b"abc\x00")
        self.assertEqual(s.enc_str("ö"), bytes([0x7F, 0x43, 0x7F, 0x36, 0]))
        long = s.enc_str("x" * 40)
        self.assertEqual(long, b"x" * 32 + b"\x00")
        self.assertTrue(all(b < 0x80 for b in s.enc_str("Hö hat ☃")))

    def test_color_mask(self):
        s = self.script
        self.assertEqual(s.fl_color(0xFF0000), 0xFF0000)
        self.assertEqual(s.fl_color(0xFF9800), 0xFF9800)
        self.assertEqual(s.fl_color(-1), 0xFFFFFF)
        self.assertEqual(s.fl_color(0x12345678), s.fl_color(0x345678))

    def test_decode_ignores_unknown_extra_and_truncated(self):
        s = self.script
        self.assertIsNone(s.decode(bytes.fromhex("f07d4d337ff7")))  # unknown command
        self.assertIsNone(s.decode(bytes.fromhex("f07d4d3343 01 f7".replace(" ", ""))))  # truncated
        self.assertIsNone(s.decode(bytes.fromhex("f0414d3343 01 02 f7".replace(" ", ""))))  # wrong header
        extra = s.decode(bytes.fromhex("f07d4d33430102 0505f7"))
        self.assertEqual(extra, {"type": "selectChannel", "index": 130})
        self.assertIsNone(s.decode(bytes.fromhex("f07d4d33440002090000f7")))  # unknown 'what'

    def test_view_decode_caps_params_at_eight(self):
        params = []
        for i in range(10):
            params += [0, i]
        raw = bytes([0xF0, 0x7D, 0x4D, 0x33, 0x42, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10] + params + [0xF7])
        decoded = self.script.decode(raw)
        self.assertEqual(len(decoded["params"]), 8)


class ChannelDetailTests(BridgeTestCase):
    channel_count = 200

    def detail_frames(self, frames):
        return self.frames_with(frames, 0x0A)

    def decoded(self, frame):
        p = frame[5:-1]
        u14 = lambda i: (p[i] << 7) | p[i + 1]
        return dict(
            index=None if u14(0) == 0x3FFF else u14(0),
            pitch=u14(2) / 16383.0 * 2 - 1,
            pitchRange=p[4],
            cutoff=u14(5) / 16383.0,
            resonance=u14(7) / 16383.0,
            mixerTrack=u14(9),
            channelType=p[11],
        )

    def test_init_sends_detail_for_the_selected_channel(self):
        c = self.fl.channels[0]
        c.update(pitch=-0.5, pitch_range=2, cutoff=1.0, resonance=0.25, mixer_track=5, channel_type=2)
        frames = self.start()
        details = self.detail_frames(frames)
        self.assertEqual(len(details), 1)
        got = self.decoded(details[0])
        self.assertEqual((got["index"], got["pitchRange"], got["mixerTrack"], got["channelType"]), (0, 2, 5, 2))
        self.assertAlmostEqual(got["pitch"], -0.5, delta=0.001)
        self.assertAlmostEqual(got["cutoff"], 1.0, delta=0.001)
        self.assertAlmostEqual(got["resonance"], 0.25, delta=0.001)

    def test_reader_uses_the_documented_fl_calls(self):
        self.start()
        self.fl.calls[:] = []
        self.bridge.read_channel_detail()
        self.assertEqual(self.fl.called("channels.getChannelPitch"), [(0, 0), (0, 2)])
        self.assertEqual(self.fl.called("channels.getRecEventId"), [(0,)])
        midi = self.script.midi
        ids = [args[0] for args in self.fl.called("device.getLinkedValue")]
        base = 0x10000
        self.assertEqual(ids, [base + midi.REC_Chan_FCut, base + midi.REC_Chan_FRes])
        self.assertEqual(self.fl.called("channels.getTargetFxTrack"), [(0,)])
        self.assertEqual(self.fl.called("channels.getChannelType"), [(0,)])

    def test_no_selection_sends_the_none_frame(self):
        self.fl.channels[0]["selected"] = False
        frames = self.start()
        self.assertEqual(
            self.detail_frames(frames)[0].hex(), "f07d4d330a7f7f40000000000000000000f7"
        )

    def test_pitch_is_clamped_and_values_are_normalised(self):
        self.fl.channels[0].update(pitch=3.0, cutoff=5.0, resonance=-1.0)
        got = self.decoded(self.detail_frames(self.start())[0])
        self.assertAlmostEqual(got["pitch"], 1.0, delta=0.001)
        self.assertAlmostEqual(got["cutoff"], 1.0, delta=0.001)
        self.assertEqual(got["resonance"], 0.0)

    def test_failing_calls_fall_back_to_zero(self):
        for name in ("channels.getRecEventId", "channels.getChannelPitch", "channels.getTargetFxTrack"):
            self.fl.raise_on[name] = RuntimeError("boom")
        got = self.decoded(self.detail_frames(self.start())[0])
        self.assertEqual(got["index"], 0)
        self.assertEqual((got["cutoff"], got["resonance"], got["mixerTrack"], got["pitchRange"]), (0, 0, 0, 0))

    def test_invalid_rec_id_reads_as_zero(self):
        self.start()
        self.assertEqual(self.bridge.read_rec_norm(0x7FFFFFFE), 0.0)

    def test_detail_follows_the_selection_and_resends_only_on_change(self):
        self.start()
        self.assertEqual(self.settle(), [])
        self.fl.channels[0]["pitch"] = 0.5
        frames = self.settle()
        self.assertEqual([self.command(f) for f in frames], [0x0A])
        self.script.OnDirtyChannel(0)
        self.fl.channels[0]["selected"] = False
        self.fl.channels[7]["selected"] = True
        self.fl.channels[7]["mixer_track"] = 9
        self.script.OnDirtyChannel(7)
        self.script.OnIdle()
        details = self.detail_frames(self.take())
        self.assertEqual(self.decoded(details[0])["index"], 7)
        self.assertEqual(self.decoded(details[0])["mixerTrack"], 9)

    def test_set_channel_pitch(self):
        self.start()
        self.fl.calls[:] = []
        event = self.send(self.script.frame(0x44, self.script.enc_u14(3) + bytes([3]) + self.script.enc_norm(0.75)))
        self.assertTrue(event.handled)
        args = self.fl.called("channels.setChannelPitch")
        self.assertEqual(len(args), 1)
        self.assertEqual((args[0][0], args[0][2]), (3, 0))
        self.assertAlmostEqual(args[0][1], 0.5, delta=0.001)
        self.assertAlmostEqual(self.fl.channels[3]["pitch"], 0.5, delta=0.001)

    def test_set_channel_pitch_vector(self):
        self.start()
        vector = [v for v in load_vectors() if v["name"] == "setChannelPitch"][0]
        self.send(bytes.fromhex(vector["hex"]))
        args = self.fl.called("channels.setChannelPitch")
        self.assertEqual(args[0][0], 0)
        self.assertAlmostEqual(args[0][1], 0.5, delta=0.001)

    def test_set_cutoff_and_resonance_write_rec_events(self):
        self.start()
        s = self.script
        midi = s.midi
        frame = lambda what, value: s.frame(0x44, s.enc_u14(4) + bytes([what]) + s.enc_norm(value))
        self.fl.calls[:] = []
        self.send(frame(4, 1.0))
        self.send(frame(5, 0.5))
        writes = self.fl.rec_writes
        base = 0x10000 * 5
        self.assertEqual(writes[0], (base + midi.REC_Chan_FCut, s.REC_VALUE_MAX, midi.REC_MIDIController))
        self.assertEqual(writes[1][0], base + midi.REC_Chan_FRes)
        self.assertEqual(writes[1][2], midi.REC_MIDIController)
        self.assertAlmostEqual(writes[1][1] / float(s.REC_VALUE_MAX), 0.5, delta=0.0001)
        ids = [a for a in self.fl.called("channels.getRecEventId") if a == (4,)]  # the rest is re-reads
        self.assertEqual(ids, [(4,), (4,)])

    def test_set_solo_sets_to_value_by_comparing(self):
        self.start()
        s = self.script
        frame = lambda value: s.frame(0x44, s.enc_u14(6) + bytes([6]) + s.enc_norm(value))
        self.send(frame(1.0))
        self.assertTrue(self.fl.channels[6]["solo"])
        self.send(frame(1.0))  # already solo: no toggle
        self.assertTrue(self.fl.channels[6]["solo"])
        self.assertEqual(self.fl.called("channels.soloChannel"), [(6,)])
        self.send(frame(0.0))
        self.assertFalse(self.fl.channels[6]["solo"])
        self.send(frame(0.0))
        self.assertEqual(len(self.fl.called("channels.soloChannel")), 2)

    def test_set_channel_track(self):
        self.start()
        vector = [v for v in load_vectors() if v["name"] == "setChannelTrack"][0]
        event = self.send(bytes.fromhex(vector["hex"]))
        self.assertTrue(event.handled)
        self.assertEqual(self.fl.called("channels.setTargetFxTrack"), [(3, 12)])
        self.assertEqual(self.fl.channels[3]["mixer_track"], 12)

    def test_set_channel_track_selected_channel_updates_detail(self):
        self.start()
        s = self.script
        self.send(s.frame(0x4B, s.enc_u14(0) + s.enc_u14(20)))
        details = self.detail_frames(self.take() + self.drain())
        self.assertEqual(self.decoded(details[-1])["mixerTrack"], 20)

    def test_set_channel_track_is_range_checked(self):
        self.start()
        s = self.script
        self.send(s.frame(0x4B, s.enc_u14(5000) + s.enc_u14(1)))
        self.send(s.frame(0x4B, s.enc_u14(1) + s.enc_u14(5000)))
        self.assertEqual(self.fl.called("channels.setTargetFxTrack"), [])

    def test_show_editor(self):
        self.start()
        vector = [v for v in load_vectors() if v["name"] == "showEditor"][0]
        event = self.send(bytes.fromhex(vector["hex"]))
        self.assertTrue(event.handled)
        self.assertEqual(self.fl.called("channels.showEditor"), [(3,)])

    def test_show_editor_is_range_checked(self):
        self.start()
        self.send(self.script.frame(0x4C, self.script.enc_u14(5000)))
        self.assertEqual(self.fl.called("channels.showEditor"), [])

    def test_new_set_channel_commands_survive_fl_errors(self):
        self.start()
        s = self.script
        for name in ("channels.setChannelPitch", "general.processRECEvent", "channels.soloChannel"):
            self.fl.raise_on[name] = RuntimeError("boom")
        for what in (3, 4, 5, 6):
            event = self.send(s.frame(0x44, s.enc_u14(1) + bytes([what]) + s.enc_norm(1.0)))
            self.assertTrue(event.handled)


class ToFlCommandTests(BridgeTestCase):
    channel_count = 200

    def vector(self, name):
        for v in load_vectors():
            if v["name"] == name:
                return bytes.fromhex(v["hex"])
        raise KeyError(name)

    def run_vector(self, name):
        self.start()
        self.fl.calls[:] = []
        event = self.send(self.vector(name))
        self.assertTrue(event.handled)
        return self.fl.calls

    def test_select_channel(self):
        self.run_vector("selectChannel")
        self.assertEqual(self.fl.called("channels.selectOneChannel"), [(130,)])
        self.assertTrue(self.fl.channels[130]["selected"])

    def test_set_channel_pan(self):
        self.run_vector("setChannel")
        args = self.fl.called("channels.setChannelPan")
        self.assertEqual(len(args), 1)
        self.assertEqual(args[0][0], 2)
        self.assertAlmostEqual(args[0][1], 0.25 * 2 - 1, delta=0.001)

    def test_set_channel_volume_and_mute(self):
        self.start()
        s = self.script
        frame = lambda what, value: s.frame(0x44, s.enc_u14(5) + bytes([what]) + s.enc_norm(value))
        self.send(frame(0, 0.5))
        self.assertAlmostEqual(self.fl.called("channels.setChannelVolume")[0][1], 0.5, delta=0.001)
        self.send(frame(2, 1.0))  # mute on: toggles because it is not muted
        self.assertTrue(self.fl.channels[5]["muted"])
        self.send(frame(2, 1.0))  # already muted: no toggle
        self.assertTrue(self.fl.channels[5]["muted"])
        self.assertEqual(len(self.fl.called("channels.muteChannel")), 1)
        self.send(frame(2, 0.0))
        self.assertFalse(self.fl.channels[5]["muted"])

    def test_set_step(self):
        self.run_vector("setStep")
        self.assertEqual(self.fl.called("channels.setGridBit"), [(1, 17, True)])
        self.assertIn(17, self.fl.channels[1]["grid"])

    def test_select_track(self):
        self.run_vector("selectTrack")
        self.assertEqual(self.fl.called("mixer.setTrackNumber"), [(12,)])

    def test_set_track_solo(self):
        self.run_vector("setTrack")
        self.assertEqual(self.fl.called("mixer.soloTrack"), [(3,)])
        self.assertTrue(self.fl.tracks[3]["solo"])

    def test_set_track_volume_pan_mute_arm(self):
        self.start()
        s = self.script
        frame = lambda what, value: s.frame(0x47, s.enc_u14(4) + bytes([what]) + s.enc_norm(value))
        self.send(frame(0, 0.25))
        self.assertAlmostEqual(self.fl.called("mixer.setTrackVolume")[0][1], 0.25, delta=0.001)
        self.send(frame(1, 1.0))
        self.assertAlmostEqual(self.fl.called("mixer.setTrackPan")[0][1], 1.0, delta=0.001)
        self.send(frame(2, 1.0))
        self.send(frame(4, 1.0))
        self.assertTrue(self.fl.tracks[4]["muted"])
        self.assertTrue(self.fl.tracks[4]["armed"])
        self.send(frame(4, 0.0))
        self.assertFalse(self.fl.tracks[4]["armed"])

    def test_set_param(self):
        self.run_vector("setParam")
        args = self.fl.called("plugins.setParamValue")
        self.assertEqual(len(args), 1)
        self.assertAlmostEqual(args[0][0], 0.3, delta=0.001)
        self.assertEqual(args[0][1:], (200, 0))  # param, selected channel

    def test_set_param_out_of_range_is_ignored(self):
        self.start()
        s = self.script
        self.send(s.frame(0x48, s.enc_u14(9000) + s.enc_norm(0.5)))
        self.assertEqual(self.fl.called("plugins.setParamValue"), [])

    def test_select_pattern(self):
        self.run_vector("selectPattern")
        self.assertEqual(self.fl.called("patterns.jumpToPattern"), [(2,)])

    def test_select_pattern_never_creates_new_patterns(self):
        self.start()
        s = self.script
        self.send(s.frame(0x49, s.enc_u14(400)))
        self.assertEqual(self.fl.called("patterns.jumpToPattern"), [])

    def test_clone_pattern(self):
        self.run_vector("clonePattern")
        self.assertEqual(self.fl.called("patterns.clonePattern"), [(5,)])
        self.assertEqual(self.fl.pattern_count, 6)
        self.assertEqual(self.fl.pattern, 6)  # FL selected the clone: nothing more to do
        self.assertEqual(self.fl.called("patterns.jumpToPattern"), [])

    def test_clone_pattern_selects_the_clone_when_fl_does_not(self):
        self.fl.clone_selects = False
        self.fl.pattern = 2
        self.run_vector("clonePattern")
        self.assertEqual(self.fl.called("patterns.jumpToPattern"), [(6,)])
        self.assertEqual(self.fl.pattern, 6)

    def test_clone_pattern_never_clones_a_pattern_that_does_not_exist(self):
        self.start()
        s = self.script
        self.send(s.frame(0x4D, s.enc_u14(400)))
        self.send(s.frame(0x4D, s.enc_u14(0)))
        self.assertEqual(self.fl.called("patterns.clonePattern"), [])

    def test_new_pattern(self):
        self.run_vector("newPattern")
        self.assertEqual(
            self.fl.called("patterns.findFirstNextEmptyPat"), [(self.script.midi.FFNEP_DontPromptName,)]
        )
        self.assertEqual(self.fl.pattern, 6)

    def test_clear_steps_clears_the_pattern_length_in_one_call(self):
        self.start()
        self.fl.pattern_len_steps = 64
        self.fl.channels[130]["grid"].update([0, 5, 63, 64, 100])
        self.fl.calls[:] = []
        event = self.send(self.vector("clearSteps"))
        self.assertTrue(event.handled)
        calls = self.fl.called("channels.setGridBit")
        self.assertEqual(calls, [(130, step, False) for step in range(64)])
        # steps past the pattern length are left alone
        self.assertEqual(self.fl.channels[130]["grid"], set([64, 100]))

    def test_clear_steps_only_touches_the_given_channel_and_checks_its_range(self):
        self.start()
        self.fl.channels[1]["grid"].add(3)
        s = self.script
        self.send(s.frame(0x4F, s.enc_u14(5000)))
        self.assertEqual(self.fl.called("channels.setGridBit"), [])
        self.send(s.frame(0x4F, s.enc_u14(2)))
        self.assertIn(3, self.fl.channels[1]["grid"])

    def test_pattern_commands_are_caught(self):
        self.start()
        s = self.script
        for name in ("patterns.clonePattern", "patterns.findFirstNextEmptyPat", "channels.setGridBit"):
            self.fl.raise_on[name] = RuntimeError("boom")
        for frame in (
            s.frame(0x4D, s.enc_u14(2)),
            s.frame(0x4E),
            s.frame(0x4F, s.enc_u14(2)),
        ):
            self.assertTrue(self.send(frame).handled)

    def test_ui_actions(self):
        self.start()
        s = self.script
        expected = [
            ("ui.up", ()),
            ("ui.down", ()),
            ("ui.left", ()),
            ("ui.right", ()),
            ("ui.enter", ()),
            ("ui.escape", ()),
            ("general.undoUp", ()),
            ("general.undoDown", ()),
            ("transport.globalTransport", (self.script.midi.FPT_Save, 1)),
            ("channels.getGridBit", None),  # cut: the step clipboard, never ui.cut (see ClipboardTests)
            ("channels.getGridBit", None),  # copy
            ("channels.getGridBit", None),  # paste (writes the clipboard: nothing copied yet = nothing)
            ("channels.quickQuantize", (0, 0)),  # the selected channel, whole notes
            ("channels.quickQuantize", (0, 1)),  # starts only
            ("transport.globalTransport", (self.script.midi.FPT_SaveNew, 1)),  # FILE: NEW VER
        ]
        for action, (name, args) in enumerate(expected):
            with self.subTest(name):
                self.fl.calls[:] = []
                self.send(s.frame(0x4A, bytes([action])))
                if args is not None:
                    self.assertEqual(self.fl.called(name), [args])
                for window_call in ("ui.cut", "ui.copy", "ui.paste"):
                    self.assertEqual(self.fl.called(window_call), [])  # they act on any focused window

    def test_ui_undo_vector(self):
        self.run_vector("ui")
        self.assertEqual(self.fl.called("general.undoUp"), [()])

    def test_out_of_range_commands_do_not_raise(self):
        self.start()
        s = self.script
        self.send(s.frame(0x43, s.enc_u14(5000)))
        self.send(s.frame(0x44, s.enc_u14(5000) + bytes([0]) + s.enc_norm(0.5)))
        self.send(s.frame(0x46, s.enc_u14(5000)))
        self.assertEqual(self.fl.called("channels.selectOneChannel"), [])
        self.assertEqual(self.fl.called("mixer.setTrackNumber"), [])

    def test_failing_fl_call_is_caught(self):
        self.start()
        self.fl.raise_on["channels.selectOneChannel"] = RuntimeError("boom")
        event = self.send(self.vector("selectChannel"))
        self.assertTrue(event.handled)  # the callback returned normally


class EditorFollowTests(BridgeTestCase):
    """Scrolling to another channel brings its editor to the front while a generator window is up."""

    def setUp(self):
        super(EditorFollowTests, self).setUp()
        self.start()

    def focus_generator(self, index, refresh=True):
        self.fl.focused_widget = self.fl.script_midi.widPluginGenerator
        self.fl.focused_form_id = index
        if refresh:
            self.script.OnRefresh(self.fl.script_midi.HW_Dirty_FocusedWindow)

    def select(self, index):
        s = self.script
        return self.send(s.frame(0x43, s.enc_u14(index)))

    def selected(self):
        return [i for i, c in enumerate(self.fl.channels) if c["selected"]][0]

    def editor_calls(self):
        return [(n, a) for (n, a) in self.fl.calls if n in ("channels.showEditor", "channels.focusEditor")]

    def test_follows_when_the_selected_channels_generator_window_is_focused(self):
        self.fl.channels[0]["selected"] = False
        self.fl.channels[3]["selected"] = True
        self.focus_generator(3)
        self.select(4)
        self.assertEqual(self.selected(), 4)
        self.assertEqual(
            self.editor_calls(),
            [("channels.showEditor", (4, 1)), ("channels.focusEditor", (4,))],
        )
        self.assertIn(4, self.fl.open_editors)
        self.assertEqual(self.fl.focused_form_id, 4)

    def test_closes_the_old_window_only_when_follow_opened_it(self):
        self.fl.channels[0]["selected"] = False
        self.fl.channels[3]["selected"] = True
        self.fl.open_editors.add(3)
        self.focus_generator(3)  # the user's window
        self.select(4)
        self.select(5)  # 4 was opened by following: closed now
        self.select(6)
        self.assertEqual(
            self.fl.called("channels.showEditor"),
            [(4, 1), (5, 1), (4, 0), (6, 1), (5, 0)],
        )
        self.assertIn(3, self.fl.open_editors)  # never touched
        self.assertEqual(self.fl.open_editors, {3, 6})
        self.assertEqual(self.bridge.follow_opened, {6})

    def test_does_not_close_a_window_seen_open_before(self):
        self.fl.channels[0]["selected"] = False
        self.fl.channels[3]["selected"] = True
        self.fl.open_editors.add(5)
        self.focus_generator(5)  # the user focused 5's window earlier: seen open
        self.assertEqual(self.bridge.seen_open, {5})
        self.focus_generator(3)
        self.select(4)  # follow opens 4
        self.select(5)  # 4 closes (ours); 5 is not claimed by follow
        self.select(6)  # 5 stays open
        self.assertEqual(self.fl.called("channels.showEditor"), [(4, 1), (5, 1), (4, 0), (6, 1)])
        self.assertNotIn(5, self.bridge.follow_opened)
        self.assertIn(5, self.fl.open_editors)

    def test_focus_changes_we_caused_do_not_count_as_seen(self):
        self.fl.channels[0]["selected"] = False
        self.fl.channels[3]["selected"] = True
        self.focus_generator(3)
        self.select(4)
        self.script.OnRefresh(self.fl.script_midi.HW_Dirty_FocusedWindow)  # FL reports the new focus
        self.assertNotIn(4, self.bridge.seen_open)
        self.assertEqual(self.bridge.follow_opened, {4})

    def test_no_follow_without_a_focused_generator_window(self):
        for widget in (None, self.fl.script_midi.widMixer):
            self.fl.focused_widget = widget
            self.fl.focused_form_id = 0
            self.select(4)
            self.select(0)
        self.assertEqual(self.editor_calls(), [])
        self.assertEqual(self.selected(), 0)

    def test_no_follow_when_the_focused_window_belongs_to_another_channel(self):
        self.focus_generator(7)  # channel 0 is selected
        self.select(4)
        self.assertEqual(self.editor_calls(), [])
        self.assertEqual(self.selected(), 4)

    def test_no_follow_for_the_same_or_an_invalid_channel(self):
        self.focus_generator(0)
        self.select(0)
        self.select(5000)
        self.assertEqual(self.editor_calls(), [])
        self.assertEqual(self.fl.called("channels.selectOneChannel"), [(0,)])

    def test_explicit_show_editor_counts_as_seen_open(self):
        s = self.script
        self.send(s.frame(0x4C, s.enc_u14(5)))
        self.assertIn(5, self.bridge.seen_open)

    def test_seen_open_ignores_focus_changes_to_other_windows(self):
        self.fl.focused_widget = self.fl.script_midi.widMixer
        self.fl.focused_form_id = 2
        self.script.OnRefresh(self.fl.script_midi.HW_Dirty_FocusedWindow)
        self.assertEqual(self.bridge.seen_open, set())
        self.focus_generator(2, refresh=False)
        self.script.OnRefresh(0)  # no focus flag: not looked at
        self.assertEqual(self.bridge.seen_open, set())

    def test_request_state_resets_both_sets(self):
        self.bridge.follow_opened.add(1)
        self.bridge.seen_open.add(2)
        self.send("f07d4d3341f7")
        self.assertEqual((self.bridge.follow_opened, self.bridge.seen_open), (set(), set()))

    def test_channel_count_change_resets_both_sets(self):
        self.bridge.channel_total()
        self.bridge.follow_opened.add(1)
        self.bridge.seen_open.add(2)
        self.bridge.channel_total()
        self.assertEqual(self.bridge.follow_opened, {1})  # unchanged count: kept
        self.fl.channels.pop()
        self.bridge.channel_total()
        self.assertEqual((self.bridge.follow_opened, self.bridge.seen_open), (set(), set()))

    def test_api_exceptions_are_swallowed(self):
        for name in (
            "ui.getFocused",
            "ui.getFocusedFormID",
            "channels.showEditor",
            "channels.focusEditor",
        ):
            with self.subTest(name):
                self.fl.calls[:] = []
                self.fl.raise_on.clear()
                self.fl.raise_on[name] = RuntimeError("boom")
                self.fl.channels[0]["selected"] = True
                self.fl.focused_widget = self.fl.script_midi.widPluginGenerator
                self.fl.focused_form_id = 0
                self.bridge.reset_follow()
                event = self.select(4)
                self.assertTrue(event.handled)
                self.assertEqual(self.selected(), 4)  # the selection itself still happened
                self.script.OnRefresh(self.fl.script_midi.HW_Dirty_FocusedWindow)
                self.script.OnIdle()
                self.select(0)

    def test_failed_open_is_not_remembered(self):
        self.focus_generator(0)
        self.fl.raise_on["channels.showEditor"] = RuntimeError("boom")
        self.select(4)
        self.assertEqual(self.bridge.follow_opened, set())

    def test_follow_logs_one_line(self):
        import contextlib
        import io

        self.focus_generator(0)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.select(4)
        self.assertIn("editor follows: channel 0 -> 4", out.getvalue())
        self.assertEqual(len(out.getvalue().strip().splitlines()), 1)


class StateTests(BridgeTestCase):
    def test_init_sends_hello_first_and_everything_in_view(self):
        frames = self.start()
        self.assertEqual(frames[0].hex(), "f07d4d330102f7")
        commands = set(self.command(f) for f in frames)
        for command in (0x01, 0x02, 0x03, 0x08, 0x09, 0x10, 0x11, 0x13, 0x14, 0x18, 0x19, 0x1A, 0x20, 0x21):
            self.assertIn(command, commands, hex(command))
        self.assertNotIn(0x12, commands)  # meters are off

    def test_transport_and_tempo(self):
        self.fl.playing = True
        self.fl.metronome = True
        frames = self.start()
        transport_frames = self.frames_with(frames, 0x02)
        # flags 05, tempo 12850 (128.50 BPM), swing 0, main volume 0.8
        self.assertEqual(transport_frames[0].hex(), "f07d4d33020500" + "6432" + "0000" + "6632" + "f7")

    def test_song_pos(self):
        frames = self.start()
        pos = self.frames_with(frames, 0x03)[0]
        self.assertEqual(pos.hex(), "f07d4d3303000c" + "03" + "0000" + "f7")  # bar 12, step 2 + 1, tick 0

    def test_channels_in_chunks_of_four(self):
        frames = self.start()
        chunks = self.frames_with(frames, 0x08)
        self.assertEqual(len(chunks), 4)  # 16 channels in the window
        offsets = [(c[5 + 2] << 7) | c[5 + 3] for c in chunks]
        self.assertEqual(offsets, [0, 4, 8, 12])
        for chunk in chunks:
            self.assertEqual(chunk[5 + 4], 4)  # n
            self.assertEqual((chunk[5] << 7) | chunk[6], 24)  # total

    def test_selected_channel_and_plugin(self):
        frames = self.start()
        selected = self.frames_with(frames, 0x09)[0]
        self.assertEqual(selected[5:7], bytes([0, 0]))  # index 0
        self.assertIn(b"Plug0\x00", selected)
        # FL color 0x0000FF goes out unchanged (FL colors are already 0xRRGGBB)
        self.assertEqual(selected[7:11], self.script.enc_color(0x0000FF))
        plugin = self.frames_with(frames, 0x20)[0]
        self.assertEqual(plugin[7], 1)  # valid
        self.assertEqual((plugin[8] << 7) | plugin[9], 300)

    def test_no_selection_and_no_plugin(self):
        self.fl.channels[0]["selected"] = False
        frames = self.start()
        self.assertEqual(self.frames_with(frames, 0x09)[0].hex(), "f07d4d33097f7f00000000000000000000f7")
        self.assertEqual(self.frames_with(frames, 0x20)[0].hex(), "f07d4d33207f7f00000000f7")
        self.assertEqual(self.frames_with(frames, 0x21), [])
        self.assertEqual(self.frames_with(frames, 0x1A), [])

    def test_selected_channel_without_plugin(self):
        self.fl.channels[0]["plugin"] = None
        frames = self.start()
        plugin = self.frames_with(frames, 0x20)[0]
        self.assertEqual(plugin[7], 0)
        self.assertEqual(self.frames_with(frames, 0x21), [])

    def test_mixer_window_of_eight_in_two_chunks(self):
        frames = self.start()
        chunks = self.frames_with(frames, 0x10)
        self.assertEqual(len(chunks), 2)
        # FL reports 127 tracks; the last is the hidden "current" track, which is not sent
        self.assertEqual((chunks[0][5] << 7) | chunks[0][6], 126)
        self.assertEqual(self.frames_with(frames, 0x11)[0].hex(), "f07d4d33110000f7")

    def test_patterns_and_pattern(self):
        frames = self.start()
        pattern = self.frames_with(frames, 0x18)[0]
        self.assertEqual(pattern[5:11].hex(), "000100050010")  # number 1, count 5, length 16 steps
        self.assertIn(b"Pattern 1\x00", pattern)
        patterns = self.frames_with(frames, 0x19)
        self.assertEqual(len(patterns), 2)  # 5 patterns -> chunks of 4 and 1
        self.assertEqual(patterns[0][5 + 4], 4)
        self.assertEqual(patterns[1][5 + 4], 1)
        self.assertEqual(patterns[0][5 + 5], 1)  # pattern 1 is current

    def test_step_grid(self):
        self.fl.channels[0]["grid"] = {0, 4, 8, 12, 15}
        frames = self.start()
        grid = self.frames_with(frames, 0x1A)[0]
        self.assertEqual(grid.hex(), "f07d4d331a00000001000010" + "022211" + "f7")

    def test_plugin_params_default_0_to_7_in_two_chunks(self):
        frames = self.start()
        chunks = self.frames_with(frames, 0x21)
        self.assertEqual(len(chunks), 2)
        self.assertEqual(chunks[0][5], 4)
        self.assertEqual(chunks[1][5], 4)
        self.assertIn(b"P7\x007%\x00", chunks[1])

    def test_nothing_resent_when_unchanged(self):
        self.start()
        self.assertEqual(self.settle(), [])
        self.assertEqual(self.settle(), [])

    def test_change_is_sent_once_and_only_that_message(self):
        self.start()
        self.fl.channels[5]["name"] = "Snare"
        frames = self.settle()
        self.assertEqual([self.command(f) for f in frames], [0x08])
        self.assertEqual((frames[0][7] << 7) | frames[0][8], 4)  # the chunk at offset 4
        self.assertIn(b"Snare\x00", frames[0])
        self.assertEqual(self.settle(), [])

    def test_song_pos_is_throttled_to_50_ms(self):
        self.start()
        self.fl.song_pos[5] = 7
        self.clock.advance(0.01)
        self.script.OnIdle()
        self.assertEqual(self.frames_with(self.take(), 0x03), [])
        self.clock.advance(0.05)
        self.script.OnIdle()
        self.assertEqual(len(self.frames_with(self.take(), 0x03)), 1)

    def test_transport_change_is_seen_on_next_idle(self):
        self.start()
        self.fl.playing = True
        self.script.OnIdle()
        frames = self.take()
        self.assertEqual([self.command(f) for f in frames], [0x02])
        self.assertEqual(frames[0][5], 1)

    def test_dirty_callbacks_reread_without_waiting_100_ms(self):
        self.start()
        self.fl.channels[2]["name"] = "Hat"
        self.fl.tracks[1]["name"] = "Bass"
        self.script.OnDirtyChannel(2)
        self.script.OnDirtyMixerTrack(1)
        self.script.OnIdle()  # same clock reading: no 100 ms re-read, only the dirty flags
        commands = sorted(self.command(f) for f in self.take())
        self.assertEqual(commands, [0x08, 0x10])

    def test_on_refresh_flags(self):
        self.start()
        self.fl.tracks[2]["muted"] = True
        self.script.OnRefresh(self.script.midi.HW_Dirty_Mixer_Display)
        self.assertEqual([self.command(f) for f in self.take()], [0x10])
        self.fl.pattern = 3
        self.script.OnRefresh(self.script.midi.HW_Dirty_Patterns)
        commands = set(self.command(f) for f in self.take())
        self.assertEqual(commands, set([0x18, 0x19, 0x1A]))

    def test_project_load_rereads_everything(self):
        self.start()
        self.fl.channels[3]["name"] = "Loaded"
        self.script.OnProjectLoad(self.script.midi.PL_Start)  # no reads while loading
        self.assertEqual(self.take(), [])
        self.script.OnProjectLoad(self.script.midi.PL_LoadOk)
        self.assertIn(0x08, [self.command(f) for f in self.take()])

    def test_one_bad_channel_does_not_stop_the_rest(self):
        original = self.fl.channels[1]["name"]
        self.fl.channels[1]["color"] = None  # int(None) fails inside fl_color
        # getChannelName for channel 3 raises
        real = sys.modules["channels"].getChannelName

        def flaky(index, *rest):
            if index == 3:
                raise RuntimeError("bad channel")
            return real(index, *rest)

        sys.modules["channels"].getChannelName = flaky
        self.script.channels.getChannelName = flaky
        frames = self.start()
        chunks = self.frames_with(frames, 0x08)
        self.assertEqual(len(chunks), 4)
        self.assertIn(b"Ch 2\x00", chunks[0])
        self.assertIn(b"Ch 4\x00", chunks[1])
        self.assertEqual(original, "Ch 1")

    def test_callbacks_swallow_exceptions(self):
        self.fl.raise_on["channels.channelCount"] = RuntimeError("boom")
        self.fl.raise_on["transport.isPlaying"] = RuntimeError("boom")
        self.fl.raise_on["device.midiOutSysex"] = RuntimeError("boom")
        self.script.OnInit()
        self.script.OnIdle()
        self.script.OnRefresh(0)
        self.script.OnDirtyChannel(-1)
        self.script.OnDirtyMixerTrack(-1)
        self.script.OnProjectLoad(100)
        self.script.OnUpdateMeters()
        self.script.OnSysEx(Event(sysex=None))
        self.script.OnControlChange(Event())

    def test_empty_project(self):
        fl = FakeFL(channel_count=0, track_count=0, pattern_count=0)
        sys.modules.update(fl.modules())
        self.fl.channels[:] = []
        self.fl.tracks[:] = []
        frames = self.start()
        chunks = self.frames_with(frames, 0x08)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0][5 + 4], 0)


class QueueTests(BridgeTestCase):
    def test_newer_message_with_same_key_replaces_the_queued_one(self):
        b = self.bridge
        b.submit("SELECTED_TRACK", {"type": "selectedTrack", "index": 1})
        b.submit("TRANSPORT", {"type": "selectedTrack", "index": 9})
        b.submit("SELECTED_TRACK", {"type": "selectedTrack", "index": 2})
        self.assertEqual(list(b.queue.keys()), ["SELECTED_TRACK", "TRANSPORT"])  # keeps its place
        b.flush()
        self.assertEqual(
            [f.hex() for f in self.fl.sysex_out],
            ["f07d4d33110002f7", "f07d4d33110009f7"],
        )

    def test_queued_message_is_dropped_when_it_equals_what_was_sent(self):
        b = self.bridge
        b.submit("SELECTED_TRACK", {"type": "selectedTrack", "index": 1})
        b.flush()
        b.submit("SELECTED_TRACK", {"type": "selectedTrack", "index": 2})
        b.submit("SELECTED_TRACK", {"type": "selectedTrack", "index": 1})
        self.assertEqual(len(b.queue), 0)
        b.flush()
        self.assertEqual(len(self.fl.sysex_out), 1)

    def test_at_most_eight_frames_per_callback(self):
        self.script.OnInit()
        first = len(self.fl.sysex_out)
        self.assertEqual(first, 8)
        total = first
        calls = 1
        while self.bridge.queue:
            before = len(self.fl.sysex_out)
            self.script.OnIdle()
            sent = len(self.fl.sysex_out) - before
            self.assertLessEqual(sent, 8)
            total += sent
            calls += 1
            self.assertLess(calls, 50)
        self.assertGreater(total, 16)
        self.assertGreater(calls, 2)

    def test_flush_limit_is_per_call(self):
        b = self.bridge
        for i in range(30):
            b.submit("K%d" % i, {"type": "selectedTrack", "index": i})
        self.assertEqual(b.flush(), 8)
        self.assertEqual(len(b.queue), 22)
        self.assertEqual(b.flush(), 8)

    def test_failed_send_is_not_cached(self):
        b = self.bridge
        b.submit("SELECTED_TRACK", {"type": "selectedTrack", "index": 1})
        self.fl.raise_on["device.midiOutSysex"] = RuntimeError("port gone")
        b.flush()
        self.assertNotIn("SELECTED_TRACK", b.sent)
        del self.fl.raise_on["device.midiOutSysex"]
        b.submit("SELECTED_TRACK", {"type": "selectedTrack", "index": 1})
        b.flush()
        self.assertEqual(len(self.fl.sysex_out), 1)


class ViewTests(BridgeTestCase):
    channel_count = 40

    def view_frame(
        self, channel=0, mixer=0, pattern=0, step=0, meters=False, params=(0, 1, 2, 3, 4, 5, 6, 7), presets=False
    ):
        s = self.script
        payload = (
            s.enc_u14(channel)
            + s.enc_u14(mixer)
            + s.enc_u14(pattern)
            + s.enc_u14(step)
            + bytes([(1 if meters else 0) | (2 if presets else 0), len(params)])
        )
        for p in params:
            payload += s.enc_u14(p)
        return s.frame(0x42, payload)

    def test_view_vector_sets_the_windows(self):
        self.start()
        vector = [v for v in load_vectors() if v["name"] == "view"][0]
        self.send(bytes.fromhex(vector["hex"]))
        view = self.bridge.view
        self.assertEqual(
            (view.channel_offset, view.mixer_offset, view.pattern_offset, view.step_offset, view.meters),
            (0, 8, 0, 16, True),
        )
        self.assertEqual(view.params, list(range(8)))

    def test_channel_offset_moves_the_channel_window(self):
        self.start()
        self.send(self.view_frame(channel=20))
        frames = self.settle()
        offsets = [(f[7] << 7) | f[8] for f in self.frames_with(frames, 0x08)]
        self.assertEqual(offsets, [20, 24, 28, 32])  # 16 of 40 channels from 20

    def test_window_is_cut_at_the_total(self):
        self.start()
        self.send(self.view_frame(channel=36))
        frames = self.settle()
        chunks = self.frames_with(frames, 0x08)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0][5 + 4], 4)

    def test_mixer_offset_moves_the_mixer_window(self):
        self.start()
        self.send(self.view_frame(mixer=8))
        frames = self.settle()
        offsets = [(f[7] << 7) | f[8] for f in self.frames_with(frames, 0x10)]
        self.assertEqual(offsets, [8, 12])

    def test_pattern_offset_and_step_offset(self):
        self.start()
        self.fl.pattern_count = 40
        self.fl.channels[0]["grid"] = {16}
        self.send(self.view_frame(pattern=16, step=16))
        frames = self.settle()
        pattern_offsets = [(f[7] << 7) | f[8] for f in self.frames_with(frames, 0x19)]
        self.assertEqual(pattern_offsets, [16, 20, 24, 28])
        grid = self.frames_with(frames, 0x1A)[0]
        self.assertEqual((grid[5 + 4] << 7) | grid[5 + 5], 16)  # offset field
        self.assertEqual(grid[-4:-1], bytes([0, 0, 1]))  # step 16 is bit 0

    def test_meters_only_while_asked(self):
        self.start()
        self.fl.tracks[0]["peaks"] = (1.0, 0.5)
        self.script.OnUpdateMeters()
        self.assertEqual(self.take(), [])
        self.send(self.view_frame(meters=True))
        self.script.OnUpdateMeters()
        meters = self.frames_with(self.take(), 0x12)
        self.assertEqual(len(meters), 2)  # 8 tracks in two chunks
        self.assertEqual(meters[0].hex(), "f07d4d33120000" + "04" + "7f40" + "0000" * 3 + "f7")
        # at most every 50 ms
        self.fl.tracks[0]["peaks"] = (0.0, 0.0)
        self.clock.advance(0.02)
        self.script.OnUpdateMeters()
        self.assertEqual(self.take(), [])
        self.clock.advance(0.05)
        self.script.OnUpdateMeters()
        self.assertEqual(len(self.frames_with(self.take(), 0x12)), 1)  # only the changed chunk
        self.send(self.view_frame(meters=False))
        self.clock.advance(1)
        self.script.OnUpdateMeters()
        self.assertEqual(self.frames_with(self.take(), 0x12), [])

    def test_init_calls_set_has_meters(self):
        self.script.OnInit()
        self.assertEqual(self.fl.called("device.setHasMeters"), [()])

    def test_watched_params(self):
        self.start()
        self.send(self.view_frame(params=(3, 250, 9999)))
        frames = self.settle()
        chunks = self.frames_with(frames, 0x21)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0][5], 2)  # 9999 is beyond the plugin's 300 parameters
        self.assertIn(b"P3\x00", chunks[0])
        self.assertIn(b"P250\x00", chunks[0])

    def test_same_view_twice_sends_nothing_new(self):
        self.start()
        self.send(self.view_frame(channel=8))
        self.settle()
        self.send(self.view_frame(channel=8))
        self.assertEqual(self.settle(), [])

    def test_moving_the_window_back_resends_it(self):
        self.start()
        self.send(self.view_frame(channel=8))
        self.settle()
        self.send(self.view_frame(channel=0))
        frames = self.settle()
        offsets = [(f[7] << 7) | f[8] for f in self.frames_with(frames, 0x08)]
        self.assertEqual(offsets, [0, 4, 8, 12])


class PresetsTests(BridgeTestCase):
    """PRESETS, PRESET_STEP and the VIEW presets flag (the BROWSER page)."""

    def setUp(self):
        super(PresetsTests, self).setUp()
        self.plugin = self.fl.plugin(0)
        self.plugin["presets"] = ["Preset %03d" % i for i in range(300)]
        self.plugin["preset"] = 17

    def view(self, presets=True, channel=0):
        s = self.script
        payload = s.enc_u14(channel) + s.enc_u14(0) * 3 + bytes([2 if presets else 0, 0])
        self.send(s.frame(0x42, payload))

    def step(self, direction):
        self.send(self.script.frame(0x55, bytes([1 if direction == "next" else 0])))

    @staticmethod
    def parse(frame):
        """count, current (None = none), offset, names of a PRESETS frame."""
        payload = frame[5:-1]
        count = (payload[0] << 7) | payload[1]
        current = (payload[2] << 7) | payload[3]
        n = payload[4]
        offset = (payload[5] << 7) | payload[6]
        names = [part.decode("ascii") for part in bytes(payload[7:]).split(b"\x00")[:n]]
        return count, None if current == 0x3FFF else current, offset, names

    def presets_frames(self, frames):
        return [self.parse(f) for f in self.frames_with(frames, 0x15)]

    def name_reads(self):
        return [a for a in self.fl.called("plugins.getName") if a[2] == 6]

    def test_nothing_is_read_or_sent_unless_the_view_asks(self):
        frames = self.start() + self.settle()
        self.assertEqual(self.frames_with(frames, 0x15), [])
        self.assertEqual(self.fl.called("plugins.getPresetCount"), [])
        self.assertEqual(self.name_reads(), [])

    def test_presets_go_out_while_the_view_asks(self):
        self.start()
        self.view()
        frames = self.settle()
        self.assertEqual(
            self.presets_frames(frames),
            [(300, 17, 14, ["Preset %03d" % i for i in range(14, 22)])],
        )

    def test_the_window_is_cut_at_both_ends(self):
        self.start()
        self.plugin["preset"] = 1
        self.view()
        self.assertEqual(self.presets_frames(self.settle())[0][1:3], (1, 0))
        self.plugin["preset"] = 299
        frames = self.settle()
        count, current, offset, names = self.presets_frames(frames)[0]
        self.assertEqual((count, current, offset), (300, 299, 292))
        self.assertEqual(names[-1], "Preset 299")
        self.assertEqual(len(names), 8)

    def test_a_short_bank_is_sent_whole(self):
        self.start()
        self.plugin["presets"] = ["A", "B", "C"]
        self.plugin["preset"] = 2
        self.view()
        self.assertEqual(self.presets_frames(self.settle()), [(3, 2, 0, ["A", "B", "C"])])

    def test_the_names_are_read_once_and_the_patch_name_on_every_pass(self):
        self.start()
        self.view()
        self.settle()
        self.assertEqual(len(self.name_reads()), 300)
        self.settle()
        self.settle()
        self.assertEqual(len(self.name_reads()), 300)  # cached: no new reads of the preset names
        patch_reads = [a for a in self.fl.called("plugins.getName") if a[2] == 3]
        self.assertGreaterEqual(len(patch_reads), 3)
        self.assertEqual(self.settle(), [])  # and nothing new is sent

    def test_a_change_made_in_fl_is_sent(self):
        self.start()
        self.view()
        self.settle()
        self.plugin["preset"] = 40
        count, current, offset, names = self.presets_frames(self.settle())[0]
        self.assertEqual((current, offset), (40, 37))
        self.assertEqual(names[3], "Preset 040")

    def test_preset_step_loads_the_next_and_previous_preset(self):
        self.start()
        self.view()
        self.settle()
        self.step("next")
        self.assertEqual(self.fl.called("plugins.nextPreset"), [(0,)])
        self.assertEqual(self.presets_frames(self.settle())[0][1], 18)
        self.step("prev")
        self.step("prev")
        self.assertEqual(self.fl.called("plugins.prevPreset"), [(0,), (0,)])
        self.assertEqual(self.presets_frames(self.settle())[-1][1], 16)

    def test_preset_step_vector_decodes(self):
        self.assertEqual(self.script.decode(bytes.fromhex("f07d4d335501f7")), {"type": "presetStep", "dir": "next"})
        self.assertEqual(self.script.decode(bytes.fromhex("f07d4d335500f7")), {"type": "presetStep", "dir": "prev"})

    def test_preset_step_acts_on_the_selected_channel(self):
        self.start()
        other = self.fl.plugin(3)
        other["presets"] = ["A", "B"]
        self.fl.channels[0]["selected"] = False
        self.fl.channels[3]["selected"] = True
        self.step("next")
        self.assertEqual(self.fl.called("plugins.nextPreset"), [(3,)])

    def test_preset_step_without_presets_does_nothing(self):
        self.start()
        self.plugin["presets"] = []
        self.step("next")
        self.assertEqual(self.fl.called("plugins.nextPreset"), [])

    def test_no_presets_sends_an_empty_message(self):
        self.start()
        self.plugin["presets"] = []
        self.view()
        self.assertEqual(self.presets_frames(self.settle()), [(0, None, 0, [])])

    def test_no_plugin_sends_an_empty_message(self):
        self.start()
        self.fl.channel(0)["plugin"] = None
        self.view()
        self.assertEqual(self.presets_frames(self.settle()), [(0, None, 0, [])])

    def test_a_patch_name_that_matches_no_preset_is_an_unknown_current(self):
        self.start()
        self.plugin["presets"] = ["A", "B", "C"]
        self.fl.patch_name = "edited sound"  # FL reports a patch the bank does not list
        self.view()
        self.assertEqual(self.presets_frames(self.settle()), [(3, None, 0, ["A", "B", "C"])])

    def test_equal_names_resolve_to_the_nearest_to_the_last_known_index(self):
        self.start()
        self.plugin["presets"] = ["Init"] + ["P%d" % i for i in range(10)] + ["Init"] + ["Q%d" % i for i in range(10)]
        self.plugin["preset"] = 10
        self.view()
        self.assertEqual(self.presets_frames(self.settle())[0][1], 10)
        self.step("next")  # FL goes to preset 11, the second "Init": the first one is far away
        self.assertEqual(self.presets_frames(self.settle())[-1][1], 11)

    def test_a_big_bank_is_not_read_whole(self):
        self.start()
        self.plugin["presets"] = ["Big %d" % i for i in range(5000)]
        self.plugin["preset"] = 0
        self.view()
        frames = self.settle()
        self.assertLessEqual(len(self.name_reads()), 8)
        count, current, offset, names = self.presets_frames(frames)[0]
        self.assertEqual((count, current, offset), (5000, None, 0))
        self.assertEqual(names, ["Big %d" % i for i in range(8)])

    def test_a_big_bank_follows_the_steps(self):
        self.start()
        self.plugin["presets"] = ["Big %d" % i for i in range(5000)]
        self.plugin["preset"] = 0
        self.view()
        self.settle()
        self.bridge.presets["current"] = 100  # as if known
        self.step("next")
        count, current, offset, names = self.presets_frames(self.settle())[-1]
        self.assertEqual((current, offset), (101, 98))
        self.assertEqual(names[3], "Big 101")
        self.assertLessEqual(len(self.name_reads()), 24)

    # -- the current preset by channel name, PRESET_WINDOW, PRESET_LOAD -------------------------

    def window(self, offset):
        self.send(self.script.frame(0x5D, self.script.enc_u14(offset)))

    def load(self, index):
        self.send(self.script.frame(0x5E, self.script.enc_u14(index)))

    def steps(self):
        return len(self.fl.called("plugins.nextPreset")), len(self.fl.called("plugins.prevPreset"))

    def test_the_channel_name_finds_the_current_preset_when_the_patch_name_does_not(self):
        self.start()
        self.fl.patch_name = "SQ Computer Instrument"  # what Diva's FPN_Patch said: not in the bank
        self.fl.channels[0]["name"] = "Preset 042"  # FL names the channel after the VST's program
        self.view()
        count, current, offset, names = self.presets_frames(self.settle())[0]
        self.assertEqual((current, offset), (42, 39))
        self.assertEqual(names[3], "Preset 042")

    def test_the_patch_name_wins_over_the_channel_name(self):
        self.start()
        self.fl.patch_name = "Preset 007"
        self.fl.channels[0]["name"] = "Preset 042"
        self.view()
        self.assertEqual(self.presets_frames(self.settle())[0][1], 7)

    def test_the_current_stays_unknown_when_neither_name_matches(self):
        self.start()
        self.fl.patch_name = "edited sound"
        self.fl.channels[0]["name"] = "Bass"
        self.view()
        self.assertEqual(self.presets_frames(self.settle())[0][1], None)

    def test_a_step_from_an_unknown_index_is_followed_by_a_fresh_read(self):
        self.start()
        self.fl.patch_name = "edited sound"
        self.fl.channels[0]["name"] = "Bass"
        self.view()
        self.settle()
        self.step("next")
        self.fl.channels[0]["name"] = "Preset 018"  # FL renames the channel after the step
        self.assertEqual(self.presets_frames(self.settle())[-1][1], 18)

    def test_preset_window_moves_the_names_and_keeps_the_current(self):
        self.start()
        self.view()
        self.settle()
        self.window(100)
        count, current, offset, names = self.presets_frames(self.settle())[-1]
        self.assertEqual((count, current, offset), (300, 17, 100))
        self.assertEqual(names, ["Preset %03d" % i for i in range(100, 108)])
        self.window(299)
        count, current, offset, names = self.presets_frames(self.settle())[-1]
        self.assertEqual((current, offset), (17, 292))
        self.assertEqual(len(names), 8)

    def test_preset_window_survives_the_rereads_and_a_step_returns_to_the_current(self):
        self.start()
        self.view()
        self.settle()
        self.window(100)
        self.settle()
        self.assertEqual(self.settle(), [])  # the window stays: nothing new is sent
        self.step("next")
        count, current, offset, names = self.presets_frames(self.settle())[-1]
        self.assertEqual((current, offset), (18, 15))

    def test_preset_window_in_a_big_bank_reads_only_those_names(self):
        self.start()
        self.plugin["presets"] = ["Big %d" % i for i in range(5000)]
        self.plugin["preset"] = 0
        self.view()
        self.settle()
        self.window(4000)
        count, current, offset, names = self.presets_frames(self.settle())[-1]
        self.assertEqual((count, offset, names[0]), (5000, 4000, "Big 4000"))
        self.assertLessEqual(len(self.name_reads()), 16)

    def test_preset_window_without_a_view_or_presets_does_nothing(self):
        self.start()
        self.window(100)
        self.assertEqual(self.frames_with(self.settle(), 0x15), [])
        self.plugin["presets"] = []
        self.view()
        self.window(100)
        self.assertEqual(self.presets_frames(self.settle()), [(0, None, 0, [])])

    def test_preset_load_steps_forward_a_few_per_pass(self):
        self.start()
        self.view()
        self.settle()
        self.load(25)  # 17 -> 25 is 8 steps next
        self.assertEqual(self.steps(), (2, 0))  # the OnSysEx pass did two, no more
        self.script.OnIdle()
        self.assertEqual(self.steps(), (4, 0))
        self.drain()
        self.assertEqual(self.steps(), (8, 0))
        self.assertEqual(self.plugin["preset"], 25)
        count, current, offset, names = self.presets_frames(self.settle())[-1]
        self.assertEqual((current, offset), (25, 22))

    def test_preset_load_goes_the_short_way_round(self):
        self.start()
        self.view()
        self.settle()
        self.load(290)  # forward 273, backward 27
        self.drain()
        self.assertEqual(self.steps(), (0, 27))
        self.assertEqual(self.plugin["preset"], 290)
        self.settle()
        self.load(5)  # forward 15 over the end
        self.drain()
        self.assertEqual(self.steps(), (15, 27))
        self.assertEqual(self.plugin["preset"], 5)
        self.assertEqual(self.presets_frames(self.settle())[-1][1], 5)

    def test_preset_load_of_the_current_or_a_missing_preset_does_nothing(self):
        self.start()
        self.view()
        self.settle()
        self.load(17)
        self.load(300)
        self.drain()
        self.assertEqual(self.steps(), (0, 0))

    def test_preset_load_is_refused_while_the_current_preset_is_unknown(self):
        self.start()
        self.fl.patch_name = "edited sound"
        self.fl.channels[0]["name"] = "Bass"
        self.view()
        self.settle()
        self.load(30)
        frames = self.take() + self.drain()
        self.assertEqual(self.steps(), (0, 0))
        self.assertEqual(self.presets_frames(frames), [(300, None, 0, ["Preset %03d" % i for i in range(8)])])

    def test_preset_load_is_dropped_when_the_selected_channel_changes(self):
        self.start()
        self.view()
        self.settle()
        self.load(40)
        self.assertEqual(self.steps(), (2, 0))
        self.fl.plugin(1)["presets"] = ["One", "Two"]
        self.fl.channels[0]["selected"] = False
        self.fl.channels[1]["selected"] = True
        self.drain()
        self.assertEqual(self.steps(), (2, 0))

    def test_preset_load_and_window_vectors_decode(self):
        self.assertEqual(self.script.decode(bytes.fromhex("f07d4d335d022cf7")), {"type": "presetWindow", "offset": 300})
        self.assertEqual(self.script.decode(bytes.fromhex("f07d4d335e0011f7")), {"type": "presetLoad", "index": 17})

    def test_preset_load_survives_failing_calls(self):
        self.start()
        self.view()
        self.settle()
        self.fl.raise_on["plugins.nextPreset"] = RuntimeError("boom")
        self.load(20)
        self.drain()  # nothing raised, and the pass ends

    def test_selecting_another_channel_sends_its_presets(self):
        self.start()
        self.view()
        self.settle()
        other = self.fl.plugin(1)
        other["presets"] = ["One", "Two"]
        other["preset"] = 1
        self.send(self.script.frame(0x43, self.script.enc_u14(1)))
        self.assertEqual(self.presets_frames(self.settle())[-1], (2, 1, 0, ["One", "Two"]))

    def test_the_flag_off_then_on_sends_them_again(self):
        self.start()
        self.view()
        self.settle()
        self.view(presets=False)
        self.assertEqual(self.frames_with(self.settle(), 0x15), [])
        self.view(presets=True)
        self.assertEqual(len(self.presets_frames(self.settle())), 1)

    def test_request_state_resends_them(self):
        self.start()
        self.view()
        self.settle()
        self.send("f07d4d3341f7")
        self.assertEqual(len(self.presets_frames(self.settle())), 1)

    def test_failing_plugin_calls_do_not_raise(self):
        self.start()
        self.view()
        for name in ("plugins.getPresetCount", "plugins.getName", "plugins.nextPreset"):
            self.fl.raise_on[name] = RuntimeError("boom")
        self.step("next")
        self.settle()  # nothing raised

    def test_vectors_encode_and_decode(self):
        for vector in load_vectors():
            if vector["name"] in ("presets", "presetsNone"):
                self.assertEqual(self.script.encode(vector["message"]).hex(), vector["hex"])


class RequestStateTests(BridgeTestCase):
    def test_request_state_clears_the_cache_and_resends_hello_first(self):
        self.start()
        self.assertEqual(self.settle(), [])
        self.send("f07d4d3341f7")
        self.bridge.flush()  # the callback already sent 8; make sure the rest is drained
        frames = self.take() + self.drain()
        self.assertEqual(frames[0].hex(), "f07d4d330102f7")
        commands = set(self.command(f) for f in frames)
        for command in (0x02, 0x03, 0x08, 0x09, 0x10, 0x11, 0x18, 0x19, 0x1A, 0x20, 0x21):
            self.assertIn(command, commands, hex(command))

    def test_request_state_replaces_queued_frames(self):
        self.script.OnInit()  # leaves frames in the queue
        self.assertTrue(self.bridge.queue)
        self.send("f07d4d3341f7")
        frames = self.take() + self.drain()
        hellos = [f for f in frames if f.hex() == "f07d4d330102f7"]
        self.assertEqual(len(hellos), 2)  # OnInit's HELLO went out before; the second one now
        self.assertFalse(self.bridge.queue)

    def test_request_state_keeps_the_view(self):
        self.start()
        self.bridge.view.channel_offset = 8
        self.send("f07d4d3341f7")
        frames = self.take() + self.drain()
        offsets = [(f[7] << 7) | f[8] for f in self.frames_with(frames, 0x08)]
        self.assertEqual(offsets, [8, 12, 16, 20])


class ControlChangeTests(BridgeTestCase):
    def test_note_pass_through(self):
        for callback in (self.script.OnNoteOn, self.script.OnNoteOff):
            event = Event()
            event.handled = True
            callback(event)
            self.assertFalse(event.handled)
        self.assertEqual(self.fl.notes, [])

    def test_transport_ccs_on_channel_16(self):
        expected = {
            102: ("transport.start", ()),
            103: ("transport.stop", ()),
            104: ("transport.record", ()),
            105: ("transport.globalTransport", (self.script.midi.FPT_CountDown, 1)),
            106: ("transport.globalTransport", (self.script.midi.FPT_Metronome, 1)),
            107: ("transport.globalTransport", (self.script.midi.FPT_TapTempo, 1)),
            108: ("transport.start", ()),
        }
        for cc, (name, args) in expected.items():
            with self.subTest(cc):
                self.fl.calls[:] = []
                event = Event(midiChan=15, data1=cc, data2=127)
                self.script.OnControlChange(event)
                self.assertTrue(event.handled)
                self.assertEqual(self.fl.called(name), [args])

    def test_restart_cc_stops_then_starts(self):
        self.fl.calls[:] = []
        event = Event(midiChan=15, data1=108, data2=127)
        self.script.OnControlChange(event)
        self.assertTrue(event.handled)
        order = [name for (name, _) in self.fl.calls if name in ("transport.stop", "transport.start")]
        self.assertEqual(order, ["transport.stop", "transport.start"])

    def test_other_channel_ccs_and_pitch_bend_pass_through(self):
        for chan, cc in ((0, 102), (0, 1), (0, 108), (3, 64), (14, 103)):
            with self.subTest((chan, cc)):
                event = Event(midiChan=chan, data1=cc, data2=127)
                event.handled = True  # prove it is reset, not just left alone
                self.script.OnControlChange(event)
                self.assertFalse(event.handled)
        self.assertEqual(self.fl.called("transport.start"), [])
        self.assertEqual(self.fl.called("transport.stop"), [])
        bend = Event(midiChan=0, data1=0, data2=64)
        bend.handled = True
        self.script.OnPitchBend(bend)
        self.assertFalse(bend.handled)

    def test_touch_strip_pitch_bend_and_mod_wheel_reach_fl_for_every_value(self):
        # MIDI channel 1 is index 0: the strip's pitch bend (0..16383 as LSB, MSB) and CC 1 (0..127)
        # must come out of the script unhandled, so FL routes them to the selected channel.
        for lsb, msb in ((0, 0), (0, 64), (127, 127), (1, 100)):
            bend = Event(midiChan=0, data1=lsb, data2=msb)
            bend.handled = True
            self.script.OnPitchBend(bend)
            self.assertFalse(bend.handled, (lsb, msb))
        for value in range(128):
            event = Event(midiChan=0, data1=1, data2=value)
            event.handled = True
            self.script.OnControlChange(event)
            self.assertFalse(event.handled, value)
        self.assertEqual(self.fl.called("transport.start"), [])

    def test_unmapped_cc_on_channel_16_passes_through(self):
        event = Event(midiChan=15, data1=1, data2=127)
        self.script.OnControlChange(event)
        self.assertFalse(event.handled)

    def test_zero_value_does_nothing(self):
        event = Event(midiChan=15, data1=102, data2=0)
        self.script.OnControlChange(event)
        self.assertTrue(event.handled)
        self.assertEqual(self.fl.called("transport.start"), [])

    def test_cc_sends_updated_transport(self):
        self.start()
        self.fl.playing = True
        self.script.OnControlChange(Event(midiChan=15, data1=102, data2=127))
        frames = self.take()
        self.assertEqual([self.command(f) for f in frames], [0x02])

    def test_foreign_sysex_is_not_handled(self):
        event = self.send(bytes([0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7]))
        self.assertIsNone(event.handled)


class PadModeNoteTests(BridgeTestCase):
    """Notes on MIDI channel 2 play the channel whose group-local index is the note number."""

    def test_note_on_plays_that_channel_at_the_root_note(self):
        self.fl.group_base = 100
        event = Event(midiChan=1, data1=5, data2=90)
        self.script.OnNoteOn(event)
        self.assertTrue(event.handled)
        self.assertEqual(self.fl.notes, [(105, self.script.CHANNEL_NOTE_ROOT, 90)])
        self.assertEqual(self.script.CHANNEL_NOTE_ROOT, 60)

    def test_note_off_and_velocity_zero_release_it(self):
        off = Event(midiChan=1, data1=5, data2=0)
        self.script.OnNoteOff(off)
        self.assertTrue(off.handled)
        zero = Event(midiChan=1, data1=7, data2=0)
        self.script.OnNoteOn(zero)
        self.assertTrue(zero.handled)
        self.assertEqual(self.fl.notes, [(5, 60, 0), (7, 60, 0)])

    def test_other_midi_channels_are_left_alone(self):
        for chan in (0, 2, 9, 15):
            for callback in (self.script.OnNoteOn, self.script.OnNoteOff):
                with self.subTest((chan, callback.__name__)):
                    event = Event(midiChan=chan, data1=5, data2=90)
                    event.handled = True  # proves it is reset
                    callback(event)
                    self.assertFalse(event.handled)
        self.assertEqual(self.fl.notes, [])

    def test_indexes_past_the_last_channel_are_swallowed_without_playing(self):
        event = Event(midiChan=1, data1=100, data2=90)  # only 24 channels
        self.script.OnNoteOn(event)
        self.assertTrue(event.handled)
        self.assertEqual(self.fl.notes, [])

    def test_poly_aftertouch_on_channel_2_is_swallowed_and_on_channel_1_is_not(self):
        pad_mode = Event(midiChan=1, data1=5, data2=64)
        self.script.OnKeyPressure(pad_mode)
        self.assertTrue(pad_mode.handled)
        keyboard = Event(midiChan=0, data1=40, data2=64)
        keyboard.handled = True
        self.script.OnKeyPressure(keyboard)
        self.assertFalse(keyboard.handled)
        self.assertEqual(self.fl.notes, [])

    def test_errors_are_caught(self):
        self.fl.raise_on["channels.midiNoteOn"] = RuntimeError("boom")
        self.script.OnNoteOn(Event(midiChan=1, data1=5, data2=90))
        self.script.OnNoteOff(Event(midiChan=1, data1=5, data2=0))
        self.fl.raise_on["channels.getChannelIndex"] = RuntimeError("boom")
        self.script.OnNoteOn(Event(midiChan=1, data1=5, data2=90))

    def test_missing_midi_channel_does_not_throw(self):
        self.script.OnNoteOn(object())
        self.script.OnNoteOff(object())
        self.script.OnKeyPressure(object())


class ChannelSoloFlagTests(BridgeTestCase):
    def channel_entries(self, frames):
        """(flags byte) of each entry of the CHANNELS frames, by channel index."""
        flags = {}
        for chunk in self.frames_with(frames, 0x08):
            offset = (chunk[7] << 7) | chunk[8]
            count = chunk[9]
            pos = 10
            for i in range(count):
                flags[offset + i] = chunk[pos]
                pos += 1 + 4  # flags + color
                while chunk[pos] != 0:
                    pos += 1
                pos += 1  # the name's terminator
        return flags

    def test_solo_is_flag_4_and_independent_of_mute_and_selection(self):
        self.fl.channels[1].update(solo=True)
        self.fl.channels[2].update(solo=True, muted=True)
        flags = self.channel_entries(self.start())
        self.assertEqual(flags[0], 0x01)  # selected only
        self.assertEqual(flags[1], 0x04)
        self.assertEqual(flags[2], 0x06)
        self.assertEqual(flags[3], 0x00)

    def test_solo_change_is_resent(self):
        self.start()
        self.fl.channels[3]["solo"] = True
        flags = self.channel_entries(self.settle())
        self.assertEqual(flags[3], 0x04)

    def test_a_failing_solo_read_does_not_stop_the_rest(self):
        self.fl.raise_on["channels.isChannelSolo"] = RuntimeError("boom")
        self.fl.channels[1]["muted"] = True
        flags = self.channel_entries(self.start())
        self.assertEqual(flags[1], 0x02)
        self.assertEqual(len(flags), 16)


class ParamNameTests(BridgeTestCase):
    """PARAM_NAMES (0x22): the names of all of the selected plugin's parameters, and the paramCount."""

    @staticmethod
    def names_of(frames):
        """index -> name from PARAM_NAMES frames."""
        names = {}
        for f in frames:
            if f[4] != 0x22:
                continue
            offset = (f[5] << 7) | f[6]
            count = f[7]
            parts = bytes(f[8:-1]).split(b"\x00")[:count]
            for i, part in enumerate(parts):
                if part:
                    names[offset + i] = part.decode("utf-8")
        return names

    @staticmethod
    def param_count(frames):
        plugin = [f for f in frames if f[4] == 0x20][-1]
        return (plugin[8] << 7) | plugin[9]

    def vst_params(self, named, total=4240):
        """A plugin like a VST: `named` is {index: name}, the rest of the `total` are unnamed."""
        return [dict(name=named.get(i, ""), value=0.0, text="") for i in range(total)]

    def test_all_named_plugin_sends_every_name_in_frames_of_eight(self):
        frames = self.start()
        names = self.frames_with(frames, 0x22)
        self.assertEqual(len(names), 38)  # 300 names -> 37 full frames and one of 4
        self.assertTrue(all(f[7] <= 8 for f in names))
        self.assertEqual(self.names_of(frames), dict((i, "P%d" % i) for i in range(300)))
        self.assertEqual(self.param_count(frames), 300)

    def test_vst_with_4240_params_reports_the_last_named_one(self):
        named = {0: "main: Output", 1: "VCC: Voices", 9: "Filter: Cutoff", 20: "last: One"}
        self.fl.channels[0]["plugin"]["params"] = self.vst_params(named)
        frames = self.start()
        self.assertEqual(self.names_of(frames), named)
        self.assertEqual(self.param_count(frames), 21)
        # Frames 0 (names 0-7), 8 (9) and 16 (20); the all-empty ranges are skipped.
        offsets = [(f[5] << 7) | f[6] for f in self.frames_with(frames, 0x22)]
        self.assertEqual(sorted(offsets), [0, 8, 16])

    def test_the_scan_is_spread_over_service_passes(self):
        named = {5: "a", 4239: "z"}
        self.fl.channels[0]["plugin"]["params"] = self.vst_params(named)
        self.script.OnInit()
        self.assertEqual(len(self.bridge.scan["names"]), 1000)
        self.assertFalse(self.bridge.scan["done"])
        self.script.OnIdle()
        self.assertEqual(len(self.bridge.scan["names"]), 2000)
        frames = self.take() + self.drain()
        self.assertTrue(self.bridge.scan["done"])
        self.assertEqual(self.names_of(frames), named)
        self.assertEqual(self.param_count(frames), 4240)
        scanned = [c for c in self.fl.called("plugins.getParamName") if c[0] >= 8]
        self.assertEqual(len(scanned), 4240 - 8)

    def test_names_are_read_once_and_not_resent(self):
        self.start()
        self.fl.calls[:] = []
        self.assertEqual(self.settle(), [])
        # Only the 8 watched parameters are read again.
        self.assertEqual(len(self.fl.called("plugins.getParamName")), 8)

    def test_changing_the_selected_channel_rescans_and_sends_the_new_names(self):
        self.fl.channels[1]["plugin"]["params"] = self.vst_params({2: "Other: Thing"}, total=50)
        self.start()
        self.fl.channels[0]["selected"] = False
        self.fl.channels[1]["selected"] = True
        frames = self.settle()
        self.assertEqual(self.names_of(frames), {2: "Other: Thing"})
        self.assertEqual(self.param_count(frames), 3)
        # The PLUGIN frame goes out before the names, so mk3d's clear-on-change can't drop them.
        commands = [f[4] for f in frames]
        self.assertLess(commands.index(0x20), commands.index(0x22))

    def test_switching_back_resends_names_mk3d_cleared(self):
        self.fl.channels[1]["plugin"]["params"] = self.vst_params({2: "Other"}, total=50)
        self.start()
        self.fl.channels[0]["selected"] = False
        self.fl.channels[1]["selected"] = True
        self.settle()
        self.fl.channels[1]["selected"] = False
        self.fl.channels[0]["selected"] = True
        frames = self.settle()
        self.assertEqual(self.names_of(frames), dict((i, "P%d" % i) for i in range(300)))

    def test_no_plugin_sends_no_names(self):
        self.fl.channels[0]["plugin"] = None
        frames = self.start()
        self.assertEqual(self.frames_with(frames, 0x22), [])
        self.assertEqual(self.param_count(frames), 0)

    def test_request_state_sends_the_names_again(self):
        self.start()
        self.send(self.script.frame(0x41))
        frames = self.settle()
        self.assertEqual(self.names_of(frames), dict((i, "P%d" % i) for i in range(300)))

    def test_whitespace_names_count_as_unnamed(self):
        self.fl.channels[0]["plugin"]["params"] = self.vst_params({0: "  A  ", 1: "   "}, total=10)
        frames = self.start()
        self.assertEqual(self.names_of(frames), {0: "A"})
        self.assertEqual(self.param_count(frames), 1)

    def test_scanning_4240_params_is_fast_enough_for_one_pass(self):
        import time

        self.fl.channels[0]["plugin"]["params"] = self.vst_params(dict((i, "p%d" % i) for i in range(4240)))
        began = time.time()
        frames = self.start()
        self.assertLess(time.time() - began, 5.0)  # the fake is not FL, but the script's own work is tiny
        self.assertEqual(len(self.frames_with(frames, 0x22)), 530)


class QuickEditCommandTests(BridgeTestCase):
    """SET_TEMPO, SET_SWING, SHOW_WINDOW, SET_SNAP and the new UI actions."""

    vector = ToFlCommandTests.vector
    run_vector = ToFlCommandTests.run_vector

    def test_set_tempo_vector(self):
        self.run_vector("setTempo")
        midi = self.script.midi
        self.assertEqual(
            self.fl.rec_writes, [(midi.REC_Tempo, 128500, midi.REC_UpdateValue | midi.REC_UpdateControl)]
        )

    def test_set_tempo_is_clamped_to_fls_range(self):
        self.start()
        s = self.script
        for bpm, raw in ((5, 10000), (999, 522000), (0.1, 10000), (120.01, 120010)):
            with self.subTest(bpm):
                del self.fl.rec_writes[:]
                self.send(s.frame(0x50, s.enc_u21(bpm * 100)))
                self.assertEqual([w[1] for w in self.fl.rec_writes], [raw])

    def test_tempo_change_is_sent_back_in_transport(self):
        self.start()
        self.send(self.script.frame(0x50, self.script.enc_u21(9000)))
        frames = self.take()
        tempo = self.frames_with(frames, 0x02)
        self.assertEqual(len(tempo), 1)
        self.assertEqual(tempo[0][6:9], self.script.enc_u21(9000))

    def test_set_swing_vector(self):
        self.run_vector("setSwing")
        midi = self.script.midi
        self.assertEqual(len(self.fl.rec_writes), 1)
        event, value, flags = self.fl.rec_writes[0]
        self.assertEqual(event, midi.REC_MainShuffle)
        self.assertAlmostEqual(value / float(midi.FromMIDI_Max), 0.25, delta=0.0001)
        self.assertTrue(flags & midi.REC_UpdateControl)
        self.assertTrue(flags & midi.REC_UpdateValue)

    def test_set_swing_extremes_are_clamped(self):
        self.start()
        s = self.script
        midi = s.midi
        self.send(s.frame(0x51, bytes([0x7F, 0x7F])))
        self.assertEqual(self.fl.rec_writes[-1][1], midi.FromMIDI_Max)
        self.send(s.frame(0x51, bytes([0, 0])))
        self.assertEqual(self.fl.rec_writes[-1][1], 0)

    def test_swing_is_read_into_transport(self):
        self.fl.swing = 0.5
        frames = self.start()
        transport = self.frames_with(frames, 0x02)[0]
        self.assertEqual(transport[9:11], self.script.enc_norm(0.5))
        self.fl.swing = 0.75
        frames = self.settle()
        self.assertEqual(self.frames_with(frames, 0x02)[0][9:11], self.script.enc_norm(0.75))

    def test_swing_read_failure_falls_back_to_zero(self):
        self.fl.raise_on["device.getLinkedValue"] = RuntimeError("boom")
        frames = self.start()
        self.assertEqual(self.frames_with(frames, 0x02)[0][9:11], self.script.enc_norm(0))

    def test_show_window_vector_shows_and_focuses_a_hidden_window(self):
        self.run_vector("showWindow")  # window 3, the piano roll
        self.assertEqual(self.fl.called("ui.showWindow"), [(3,)])
        self.assertEqual(self.fl.called("ui.setFocused"), [(3,)])
        self.assertEqual(self.fl.called("ui.hideWindow"), [])

    def test_show_window_hides_the_focused_window(self):
        self.start()
        self.fl.visible.add(3)
        self.fl.focused_widget = 3
        self.fl.calls[:] = []
        self.send(self.vector("showWindow"))
        self.assertEqual(self.fl.called("ui.hideWindow"), [(3,)])
        self.assertEqual(self.fl.called("ui.showWindow"), [])
        self.assertNotIn(3, self.fl.visible)

    def test_show_window_focuses_a_visible_window_that_is_behind(self):
        self.start()
        self.fl.visible.update((3, 1))
        self.fl.focused_widget = 1
        self.fl.calls[:] = []
        self.send(self.vector("showWindow"))
        self.assertEqual(self.fl.called("ui.showWindow"), [(3,)])
        self.assertEqual(self.fl.focused_widget, 3)

    def test_show_window_ignores_other_windows(self):
        self.start()
        self.fl.calls[:] = []
        self.send(self.script.frame(0x52, bytes([5])))
        self.send(self.script.frame(0x52, bytes([100])))
        self.assertEqual(self.fl.called("ui.showWindow"), [])

    def test_set_snap_vector(self):
        self.run_vector("setSnap")
        self.assertEqual(self.fl.called("ui.setSnapMode"), [(13,)])
        self.assertEqual(self.fl.snap, 13)

    def test_new_commands_survive_fl_errors(self):
        self.start()
        s = self.script
        for name in (
            "general.processRECEvent",
            "ui.showWindow",
            "ui.setSnapMode",
            "general.saveUndo",
            "channels.getGridBit",
            "channels.setGridBit",
            "channels.quickQuantize",
        ):
            self.fl.raise_on[name] = RuntimeError("boom")
        frames = (
            s.frame(0x50, s.enc_u21(12000)),
            s.frame(0x51, s.enc_norm(0.5)),
            s.frame(0x52, bytes([3])),
            s.frame(0x53, bytes([8])),
            s.frame(0x4A, bytes([9])),
            s.frame(0x4A, bytes([10])),
            s.frame(0x4A, bytes([11])),
            s.frame(0x4A, bytes([12])),
            s.frame(0x4A, bytes([13])),
        )
        for frame in frames:
            self.assertTrue(self.send(frame).handled)

    def test_quantize_vector_and_actions_need_a_selected_channel(self):
        self.start()
        self.run_vector("uiQuantizeStarts")
        self.assertEqual(self.fl.called("channels.quickQuantize"), [(0, 1)])
        for channel in self.fl.channels:
            channel["selected"] = False
        self.fl.calls[:] = []
        self.send(self.script.frame(0x4A, bytes([12])))
        self.assertEqual(self.fl.called("channels.quickQuantize"), [])

    def test_unknown_ui_action_is_ignored(self):
        self.start()
        self.assertIsNone(self.script.decode(self.script.frame(0x4A, bytes([15]))))


class MainVolumeTests(BridgeTestCase):
    """SET_MAIN_VOLUME and the main volume in TRANSPORT: FL's REC_MainVol, not the Master fader."""

    vector = ToFlCommandTests.vector
    run_vector = ToFlCommandTests.run_vector

    def transport_frame(self, frames):
        return self.frames_with(frames, 0x02)[-1]

    def test_set_main_volume_vector_writes_the_rec_event_like_the_swing(self):
        self.run_vector("setMainVolume")
        midi = self.script.midi
        self.assertEqual(len(self.fl.rec_writes), 1)
        event, value, flags = self.fl.rec_writes[0]
        self.assertEqual(event, midi.REC_MainVol)
        self.assertAlmostEqual(value / float(midi.FromMIDI_Max), 0.8, delta=0.0001)
        self.assertEqual(flags, midi.REC_MIDIController | midi.REC_UpdateControl)

    def test_it_is_not_the_master_mixer_fader(self):
        self.start()
        before = self.fl.tracks[0]["volume"]
        self.send(self.script.frame(0x54, self.script.enc_norm(0.3)))
        self.assertEqual(self.fl.tracks[0]["volume"], before)
        self.assertEqual(self.fl.called("mixer.setTrackVolume"), [])
        self.assertAlmostEqual(self.fl.main_volume, 0.3, delta=0.0001)

    def test_extremes_are_clamped(self):
        self.start()
        s = self.script
        self.send(s.frame(0x54, bytes([0x7F, 0x7F])))
        self.assertEqual(self.fl.rec_writes[-1][1], s.midi.FromMIDI_Max)
        self.send(s.frame(0x54, bytes([0, 0])))
        self.assertEqual(self.fl.rec_writes[-1][1], 0)

    def test_transport_carries_the_main_volume_after_the_swing(self):
        self.fl.main_volume = 0.5
        frames = self.start()
        transport = self.transport_frame(frames)
        self.assertEqual(len(transport), 5 + 1 + 3 + 2 + 2 + 1)
        self.assertEqual(transport[11:13], self.script.enc_norm(0.5))
        self.assertIn((self.script.midi.REC_MainVol,), self.fl.called("device.getLinkedValue"))

    def test_a_change_in_fl_is_sent_once(self):
        self.start()
        self.fl.main_volume = 0.25
        frames = self.settle()
        self.assertEqual(self.transport_frame(frames)[11:13], self.script.enc_norm(0.25))
        self.assertEqual(self.frames_with(self.settle(), 0x02), [])

    def test_a_failed_read_leaves_the_field_out_instead_of_reporting_zero(self):
        self.fl.raise_on["device.getLinkedValue"] = RuntimeError("boom")
        transport = self.transport_frame(self.start())
        self.assertEqual(len(transport), 5 + 1 + 3 + 2 + 1)  # flags, tempo, swing, no main volume

    def test_a_missing_event_reads_as_unknown(self):
        original = self.script.device.getLinkedValue
        main = self.script.midi.REC_MainVol
        # FL answers -1 for an event ID that does not exist
        self.script.device.getLinkedValue = lambda event_id: -1.0 if event_id == main else original(event_id)
        transport = self.transport_frame(self.start())
        self.assertEqual(len(transport), 5 + 1 + 3 + 2 + 1)

    def test_a_failing_write_is_caught(self):
        self.start()
        self.fl.raise_on["general.processRECEvent"] = RuntimeError("boom")
        self.assertTrue(self.send(self.script.frame(0x54, self.script.enc_norm(0.5))).handled)


class UndoStateTests(BridgeTestCase):
    """UNDO_STATE (14): position, count and FL's hint."""

    def states(self, frames):
        return self.frames_with(frames, 0x14)

    def test_init_sends_it(self):
        self.fl.undo_pos, self.fl.undo_count, self.fl.undo_hint = 3, 150, "Move step"
        states = self.states(self.start())
        self.assertEqual(len(states), 1)
        self.assertEqual(states[0].hex(), "f07d4d3314000301164d6f7665207374657000f7")

    def test_it_matches_the_shared_vector(self):
        self.fl.undo_pos, self.fl.undo_count, self.fl.undo_hint = 3, 150, "Move step"
        vector = [v for v in load_vectors() if v["name"] == "undoState"][0]
        self.assertEqual(self.states(self.start())[0].hex(), vector["hex"])

    def test_unchanged_state_is_sent_once(self):
        self.start()
        self.assertEqual(self.states(self.settle()), [])

    def test_undo_and_redo_send_the_new_state_at_once(self):
        self.fl.undo_pos = self.fl.undo_count = 5
        self.start()
        self.send(self.script.frame(0x4A, bytes([6])))  # undo
        states = self.states(self.take())
        self.assertEqual(len(states), 1)
        self.assertEqual(states[0][5:9], bytes([0, 4, 0, 5]))
        self.assertIn(b"undo 4/5", states[0])
        self.send(self.script.frame(0x4A, bytes([7])))  # redo
        states = self.states(self.take())
        self.assertEqual(states[0][5:9], bytes([0, 5, 0, 5]))
        self.assertIn(b"redo 5/5", states[0])

    def test_undo_is_undo_up_and_redo_is_undo_down(self):
        self.start()
        self.fl.calls[:] = []
        self.send(self.script.frame(0x4A, bytes([6])))
        self.send(self.script.frame(0x4A, bytes([7])))
        self.assertEqual([n for (n, _) in self.fl.calls if n.startswith("general.undo")],
                         ["general.undoUp", "general.undoDown"])

    def test_a_batch_edit_sends_it(self):
        self.start()
        self.send(self.script.frame(0x4F, self.script.enc_u14(0)))
        states = self.states(self.take())
        self.assertEqual(len(states), 1)
        self.assertEqual(states[0][5:9], bytes([0, 1, 0, 1]))
        self.assertIn(b"MK3: clear steps", states[0])

    def test_the_undo_dirty_flag_sends_it(self):
        self.start()
        self.fl.undo_pos, self.fl.undo_count, self.fl.undo_hint = 7, 9, "x"
        self.script.OnRefresh(self.script.midi.HW_Dirty_Undo)
        states = self.states(self.take())
        self.assertEqual(len(states), 1)
        self.assertEqual(states[0][5:9], bytes([0, 7, 0, 9]))

    def test_request_state_sends_it_again(self):
        self.start()
        self.send(self.script.frame(0x41))
        self.drain()
        self.assertEqual(len(self.states(self.take())), 1)

    def test_failing_or_missing_calls_give_an_empty_state(self):
        self.fl.raise_on["general.getUndoHistoryPos"] = RuntimeError("boom")
        self.fl.raise_on["general.getUndoLevelHint"] = RuntimeError("boom")
        self.fl.undo_count = 4
        state = self.states(self.start())[0]
        self.assertEqual(state[5:9], bytes([0, 0, 0, 4]))
        self.assertEqual(state[9:], bytes([0, 0xF7]))

    def test_an_fl_without_the_undo_functions_does_not_stop_the_rest(self):
        del self.script.general.getUndoHistoryCount
        frames = self.start()
        self.assertEqual(self.states(frames)[0][5:9], bytes([0, 0, 0, 0]))
        self.assertTrue(self.frames_with(frames, 0x02))


class BatchEditTests(BridgeTestCase):
    """CLEAR_STEPS and paste: one undo point before the first change, the grid sent once after."""

    def grid_frames(self, frames):
        return self.frames_with(frames, 0x1A)

    def grid_bits(self, frame):
        p = frame[5:-1]
        return (p[7] << 14) | (p[8] << 7) | p[9]

    def test_clear_saves_one_undo_point_before_the_first_step(self):
        self.start()
        self.fl.channels[0]["grid"].update([0, 4, 8])
        self.fl.calls[:] = []
        self.send(self.script.frame(0x4F, self.script.enc_u14(0)))
        names = [n for (n, _) in self.fl.calls]
        self.assertEqual(names.count("general.saveUndo"), 1)
        self.assertLess(names.index("general.saveUndo"), names.index("channels.setGridBit"))
        self.assertEqual(self.fl.called("general.saveUndo"), [("MK3: clear steps", self.script.midi.UF_PR)])
        self.assertEqual(self.fl.undo_names, ["MK3: clear steps"])

    def test_the_grid_is_sent_once_after_the_whole_batch(self):
        self.start()
        self.fl.pattern_len_steps = 16
        self.fl.channels[0]["grid"].update(range(16))
        self.script.OnRefresh(self.script.midi.HW_Dirty_ChannelRack)
        self.take()
        # FL calls back into the script while the steps change (OnRefresh, OnIdle)
        script = self.script
        self.fl.on_set_grid_bit = lambda *args: (
            script.OnRefresh(script.midi.HW_Dirty_ChannelRack | script.midi.HW_Dirty_Undo),
            script.OnIdle(),
        )
        self.send(self.script.frame(0x4F, self.script.enc_u14(0)))
        frames = self.take()
        grids = self.grid_frames(frames)
        self.assertEqual(len(grids), 1)
        self.assertEqual(self.grid_bits(grids[0]), 0)  # all off, never half cleared
        self.assertEqual(self.fl.channels[0]["grid"], set())

    def test_nothing_is_read_while_a_batch_runs(self):
        self.start()
        self.bridge.batching = 1
        self.fl.tracks[2]["muted"] = True
        self.fl.calls[:] = []
        self.script.OnRefresh(self.script.midi.HW_Dirty_Undo)
        self.script.OnIdle()
        self.assertEqual(self.fl.calls, [])
        self.assertEqual(self.take(), [])
        self.bridge.batching = 0
        self.script.OnIdle()
        self.assertEqual([self.command(f) for f in self.take() if self.command(f) == 0x10], [0x10])  # afterwards

    def test_the_batch_ends_even_when_fl_raises(self):
        self.start()
        self.fl.raise_on["channels.setGridBit"] = RuntimeError("boom")
        self.assertTrue(self.send(self.script.frame(0x4F, self.script.enc_u14(0))).handled)
        self.assertEqual(self.bridge.batching, 0)
        self.fl.raise_on.clear()
        self.assertTrue(self.drain() is not None)

    def test_a_failing_save_undo_does_not_stop_the_edit(self):
        self.start()
        self.fl.channels[0]["grid"].update([1, 2])
        self.fl.raise_on["general.saveUndo"] = RuntimeError("boom")
        self.send(self.script.frame(0x4F, self.script.enc_u14(0)))
        self.assertEqual(self.fl.channels[0]["grid"], set())

    def test_a_clear_that_is_out_of_range_saves_no_undo_point(self):
        self.start()
        self.send(self.script.frame(0x4F, self.script.enc_u14(5000)))
        self.assertEqual(self.fl.called("general.saveUndo"), [])


class StepClipboardTests(BridgeTestCase):
    """Copy, paste and cut (UI 10, 11, 9) work on a step clipboard in the script."""

    COPY, PASTE, CUT = 10, 11, 9

    def ui(self, action):
        self.send(self.script.frame(0x4A, bytes([action])))

    def select(self, index):
        for i, channel in enumerate(self.fl.channels):
            channel["selected"] = i == index

    def grid(self, index):
        return self.fl.channels[index]["grid"]

    def test_copy_stores_the_selected_channels_steps_and_changes_nothing(self):
        self.start()
        self.fl.pattern_len_steps = 16
        self.grid(0).update([0, 4, 9, 20])  # step 20 is past the pattern: not stored
        self.fl.calls[:] = []
        self.ui(self.COPY)
        self.assertEqual(self.bridge.step_clipboard, [i in (0, 4, 9) for i in range(16)])
        self.assertEqual(self.fl.called("channels.setGridBit"), [])
        self.assertEqual(self.fl.called("general.saveUndo"), [])  # nothing to undo
        self.assertEqual(self.fl.called("ui.copy"), [])  # not the focused window's copy

    def test_paste_writes_it_into_the_selected_channel_as_one_undo_point(self):
        self.start()
        self.fl.pattern_len_steps = 16
        self.grid(0).update([0, 4, 9])
        self.grid(3).update([1, 2])
        self.ui(self.COPY)
        self.select(3)
        self.fl.calls[:] = []
        self.take()
        self.ui(self.PASTE)
        self.assertEqual(self.grid(3), set([0, 4, 9]))  # the old steps 1 and 2 are replaced
        self.assertEqual(self.grid(0), set([0, 4, 9]))
        self.assertEqual(self.fl.called("general.saveUndo"), [("MK3: paste steps", self.script.midi.UF_PR)])
        names = [n for (n, _) in self.fl.calls]
        self.assertLess(names.index("general.saveUndo"), names.index("channels.setGridBit"))
        self.assertEqual(self.fl.called("ui.paste"), [])

    def test_paste_sends_the_grid_once_when_it_is_done(self):
        self.start()
        self.fl.pattern_len_steps = 16
        self.grid(0).update([0, 4, 9])
        self.ui(self.COPY)
        self.select(3)
        self.settle()  # the script sees the new selection and sends channel 3's (empty) grid
        script = self.script
        self.fl.on_set_grid_bit = lambda *a: (script.OnRefresh(script.midi.HW_Dirty_ChannelRack), script.OnIdle())
        self.ui(self.PASTE)
        self.drain()  # at most 8 frames go out per callback: the rest follow on the next OnIdle
        grids = self.frames_with(self.take(), 0x1A)
        self.assertEqual(len(grids), 1)
        p = grids[0][5:-1]
        self.assertEqual((p[7] << 14) | (p[8] << 7) | p[9], (1 << 0) | (1 << 4) | (1 << 9))

    def test_a_shorter_pattern_takes_only_what_fits(self):
        self.start()
        self.fl.pattern_len_steps = 32
        self.grid(0).update([1, 30])
        self.ui(self.COPY)
        self.select(2)
        self.fl.pattern_len_steps = 16
        self.grid(2).update([20])
        self.ui(self.PASTE)
        self.assertEqual(self.grid(2), set([1, 20]))  # step 30 does not fit; step 20 is left alone

    def test_a_longer_pattern_keeps_the_steps_after_the_clipboard(self):
        self.start()
        self.fl.pattern_len_steps = 8
        self.grid(0).update([2, 3])
        self.ui(self.COPY)
        self.select(2)
        self.fl.pattern_len_steps = 32
        self.grid(2).update([0, 2, 20])
        self.ui(self.PASTE)
        self.assertEqual(self.grid(2), set([2, 3, 20]))  # steps 0..7 are the clipboard's
        calls = self.fl.called("channels.setGridBit")
        self.assertEqual(len(calls), 8)

    def test_paste_without_a_clipboard_does_nothing_and_saves_no_undo_point(self):
        self.start()
        self.grid(0).update([1])
        self.fl.calls[:] = []
        self.ui(self.PASTE)
        self.assertEqual(self.grid(0), set([1]))
        self.assertEqual(self.fl.called("general.saveUndo"), [])

    def test_nothing_without_a_selected_channel(self):
        self.start()
        self.ui(self.COPY)
        self.select(None)
        self.fl.calls[:] = []
        self.ui(self.PASTE)
        self.ui(self.CUT)
        self.assertEqual(self.fl.called("channels.setGridBit"), [])
        self.assertEqual(self.fl.called("general.saveUndo"), [])

    def test_cut_is_copy_and_clear_as_one_undo_point(self):
        self.start()
        self.fl.pattern_len_steps = 16
        self.grid(0).update([3, 5])
        self.fl.calls[:] = []
        self.ui(self.CUT)
        self.assertEqual(self.grid(0), set())
        self.assertEqual(self.bridge.step_clipboard, [i in (3, 5) for i in range(16)])
        self.assertEqual(self.fl.called("general.saveUndo"), [("MK3: cut steps", self.script.midi.UF_PR)])
        # ... and a paste into another channel brings the steps back
        self.select(1)
        self.ui(self.PASTE)
        self.assertEqual(self.grid(1), set([3, 5]))

    def test_the_clipboard_survives_a_selection_change_and_a_request_state(self):
        self.start()
        self.fl.pattern_len_steps = 16
        self.grid(0).add(7)
        self.ui(self.COPY)
        self.send(self.script.frame(0x41))
        self.select(5)
        self.ui(self.PASTE)
        self.assertEqual(self.grid(5), set([7]))

    def test_fl_errors_are_caught(self):
        self.start()
        for name in ("channels.getGridBit", "channels.setGridBit"):
            self.fl.raise_on[name] = RuntimeError("boom")
        for action in (self.COPY, self.PASTE, self.CUT):
            self.assertTrue(self.send(self.script.frame(0x4A, bytes([action]))).handled)
        self.assertEqual(self.bridge.batching, 0)


class UiStateTests(BridgeTestCase):
    def ui_state(self, frames):
        return [f for f in self.frames_with(frames, 0x13)]

    def test_init_sends_snap_visible_windows_and_focus(self):
        self.fl.visible.update((0, 3))
        self.fl.focused_widget = 3
        frames = self.start()
        state = self.ui_state(frames)
        self.assertEqual(len(state), 1)
        self.assertEqual(state[0].hex(), "f07d4d3313" + "08" + "09" + "03" + "f7")

    def test_focus_is_none_without_a_known_window_and_plugin_for_plugin_windows(self):
        frames = self.start()
        self.assertEqual(self.ui_state(frames)[0][7], 127)
        self.fl.focused_widget = self.script.midi.widPluginGenerator
        frames = self.settle()
        self.assertEqual(self.ui_state(frames)[0][7], 5)

    def test_unchanged_state_is_sent_once(self):
        self.start()
        self.assertEqual(self.ui_state(self.settle()), [])

    def test_a_focus_change_is_sent_on_the_dirty_flag(self):
        self.start()
        self.fl.visible.add(2)
        self.fl.focused_widget = 2
        self.script.OnRefresh(self.script.midi.HW_Dirty_FocusedWindow)
        state = self.ui_state(self.take())
        self.assertEqual(len(state), 1)
        self.assertEqual(state[0].hex(), "f07d4d3313" + "08" + "04" + "02" + "f7")

    def test_a_snap_change_is_sent_on_the_next_idle_pass(self):
        self.start()
        self.fl.snap = 13
        self.script.OnIdle()  # no 100 ms re-read yet: the cheap snap check finds it
        state = self.ui_state(self.take())
        self.assertEqual(len(state), 1)
        self.assertEqual(state[0][5], 13)

    def test_snap_is_clamped_to_u7(self):
        self.fl.snap = 5000
        frames = self.start()
        self.assertEqual(self.ui_state(frames)[0][5], 127)

    def test_request_state_sends_it_again(self):
        self.start()
        self.send(self.script.frame(0x41))
        self.drain()
        self.assertEqual(len(self.ui_state(self.take())), 1)

    def test_failing_ui_calls_give_an_empty_state(self):
        for name in ("ui.getSnapMode", "ui.getVisible", "ui.getFocused"):
            self.fl.raise_on[name] = RuntimeError("boom")
        frames = self.start()
        self.assertEqual(self.ui_state(frames)[0].hex(), "f07d4d3313" + "00" + "00" + "7f" + "f7")


def parse_markers(frame):
    """Decode a MARKERS frame by hand: (total, offset, [(ticks, name)], ppq)."""
    data = list(frame[5:-1])
    total, offset, count = data[0], data[1], data[2]
    pos = 3
    entries = []
    for _ in range(count):
        ticks = (data[pos] << 14) | (data[pos + 1] << 7) | data[pos + 2]
        pos += 3
        raw = bytearray()
        while data[pos] != 0:
            raw.append(data[pos])
            pos += 1
        pos += 1
        entries.append((ticks, raw.decode("ascii")))
    ppq = (data[pos] << 7) | data[pos + 1]
    assert pos + 2 == len(data), "trailing bytes in MARKERS"
    return total, offset, entries, ppq


class MarkerTests(BridgeTestCase):
    """ARRANGER and SCENE: the marker scan, MARKERS in chunks, JUMP_MARKER, ADD_MARKER, loop mode."""

    def setUp(self):
        super(MarkerTests, self).setUp()
        # Four markers a bar (384 ticks at PPQ 96) apart, from bar 2; named like FL's absolute index.
        self.fl.marker_ticks = [384, 768, 1536, 3840]
        self.fl.song_pos[2] = 1000

    def markers_frames(self, frames):
        return [parse_markers(f) for f in self.frames_with(frames, 0x16)]

    def listed(self, frames):
        """The marker list the frames carry, in offset order."""
        parts = sorted(self.markers_frames(frames), key=lambda part: part[1])
        return [entry for part in parts for entry in part[2]]

    def request(self, hex_name="requestMarkers"):
        return self.send(self.script.frame(0x5A))

    def test_request_state_scans_while_stopped_and_sends_the_list(self):
        frames = self.start()
        self.send(self.script.frame(0x41))
        self.drain()
        frames = self.take()
        parts = self.markers_frames(frames)
        self.assertEqual(len(parts), 1)
        total, offset, entries, ppq = parts[0]
        self.assertEqual((total, offset, ppq), (4, 0, 96))
        self.assertEqual(
            entries, [(384, "Marker 0"), (768, "Marker 1"), (1536, "Marker 2"), (3840, "Marker 3")]
        )

    def test_the_scan_jumps_through_the_markers_and_restores_the_position(self):
        self.start()
        self.take()
        self.fl.calls[:] = []
        self.request()
        self.drain()
        self.assertEqual(self.fl.song_pos[2], 1000)
        sets = self.fl.called("transport.setSongPos")
        self.assertEqual(sets[0], (0, 2))  # to the start first, in absolute ticks
        self.assertEqual(sets[-1], (1000, 2))  # and back where we were
        jumps = self.fl.called("arrangement.jumpToMarker")
        self.assertEqual(jumps[0], (0, False))  # the probe for a marker at tick 0
        self.assertTrue(all(args == (1, False) for args in jumps[1:]))
        self.assertEqual(len(jumps), 1 + 5)  # four markers, one more jump that goes nowhere

    def test_a_marker_at_tick_zero_makes_the_scan_disagree_so_the_times_are_unknown(self):
        # The jumps reach two markers, the names say three: no @0 is invented, the names stay.
        self.fl.marker_ticks = [0, 384, 768]
        self.start()
        self.take()
        self.request()
        self.drain()
        unknown = self.script.MARKER_TICKS_UNKNOWN
        self.assertEqual(unknown, 0x1FFFFF)
        self.assertEqual(
            self.listed(self.take()),
            [(unknown, "Marker 0"), (unknown, "Marker 1"), (unknown, "Marker 2")],
        )

    def test_the_names_give_the_count_and_the_scan_only_the_times(self):
        self.start()
        self.take()
        self.fl.calls[:] = []
        self.request()
        self.drain()
        self.assertEqual(
            self.listed(self.take()),
            [(384, "Marker 0"), (768, "Marker 1"), (1536, "Marker 2"), (3840, "Marker 3")],
        )
        # getMarkerName(0..4): the fifth is empty and ends the list
        asked = [args[0] for args in self.fl.called("arrangement.getMarkerName")]
        self.assertEqual(asked[:5], [0, 1, 2, 3, 4])

    def test_no_marker_at_tick_zero_is_assumed_for_a_scan_that_agrees(self):
        self.start()
        self.take()
        self.request()
        self.drain()
        self.assertEqual(self.listed(self.take())[0], (384, "Marker 0"))

    def test_a_name_without_a_time_keeps_every_time_unknown(self):
        self.fl.marker_names = {4: "Ghost"}  # five names, the jumps reach four markers
        self.fl.marker_ticks = [384, 768, 1536, 3840]
        self.start()
        self.take()
        self.request()
        self.drain()
        listed = self.listed(self.take())
        self.assertEqual([name for _, name in listed][-1], "Ghost")
        self.assertEqual(len(listed), 5)
        self.assertEqual({t for t, _ in listed}, {self.script.MARKER_TICKS_UNKNOWN})
        self.assertEqual(self.fl.song_pos[2], 1000)  # the position was put back all the same

    def test_no_names_means_no_scan_at_all(self):
        self.fl.marker_ticks = []
        self.start()
        self.take()
        self.fl.calls[:] = []
        self.request()
        self.drain()
        self.assertEqual(self.fl.called("arrangement.jumpToMarker"), [])
        self.assertEqual(self.fl.called("transport.setSongPos"), [])
        self.assertEqual(self.markers_frames(self.take()), [(0, 0, [], 96)])

    def test_a_jump_to_a_marker_with_an_unknown_time_does_nothing(self):
        self.fl.marker_ticks = [0, 384, 768]
        self.scanned()
        self.fl.calls[:] = []
        self.jump(1, False)
        self.assertEqual(self.fl.called("transport.setSongPos"), [])
        self.assertEqual(self.fl.song_pos[2], 1000)

    def test_jump_to_marker_zero_that_moves_is_the_first_marker_ahead(self):
        # A FL whose jumpToMarker(0) goes to the nearest marker ahead of the position
        original = self.fl.modules()["arrangement"].jumpToMarker
        fl = self.fl

        def snapping(delta, select=False):
            if delta == 0:
                ahead = [t for t in fl.marker_ticks if t > fl.song_pos[2]]
                if ahead:
                    fl.song_pos[2] = ahead[0]
            else:
                original(delta, select)

        sys.modules["arrangement"].jumpToMarker = snapping
        self.start()
        self.take()
        self.request()
        self.drain()
        self.assertEqual([t for t, _ in self.listed(self.take())], [384, 768, 1536, 3840])

    def test_the_scan_ends_when_the_jump_wraps_around(self):
        self.fl.marker_wrap = True
        self.start()
        self.take()
        self.request()
        self.drain()
        self.assertEqual([t for t, _ in self.listed(self.take())], [384, 768, 1536, 3840])

    def test_no_markers_sends_one_empty_message_with_the_ppq(self):
        self.fl.marker_ticks = []
        self.fl.ppq = 480
        self.start()
        self.take()
        self.request()
        self.drain()
        parts = self.markers_frames(self.take())
        self.assertEqual(parts, [(0, 0, [], 480)])

    def test_nothing_is_scanned_while_playing_and_the_cache_is_answered(self):
        self.start()
        self.take()
        self.request()
        self.drain()
        self.take()
        self.fl.playing = True
        self.fl.calls[:] = []
        self.request()
        self.drain()
        self.assertEqual(self.fl.called("arrangement.jumpToMarker"), [])
        self.assertEqual(self.fl.called("transport.setSongPos"), [])
        # the cached list went out again, so mk3d sees it on opening the page
        self.assertEqual(len(self.listed(self.take())), 4)

    def test_request_state_while_playing_does_not_scan_and_scans_when_it_stops(self):
        self.fl.playing = True
        self.start()
        self.take()
        self.fl.calls[:] = []
        self.send(self.script.frame(0x41))
        self.drain()
        self.assertEqual(self.fl.called("arrangement.jumpToMarker"), [])
        self.assertEqual(self.markers_frames(self.take()), [(0, 0, [], 96)])  # an empty cache
        self.fl.playing = False
        self.drain()
        self.assertEqual(len(self.listed(self.take())), 4)  # scanned as soon as FL stopped
        self.assertGreater(len(self.fl.called("arrangement.jumpToMarker")), 0)

    def test_the_list_goes_out_in_chunks_of_eight_one_per_pass(self):
        self.fl.marker_ticks = [384 * (i + 1) for i in range(20)]
        self.start()
        self.take()
        before = len(self.fl.sysex_out)
        self.request()  # the scan and the first chunk
        per_pass = [len(self.markers_frames(self.fl.sysex_out[before:]))]
        for _ in range(8):
            before = len(self.fl.sysex_out)
            self.script.OnIdle()
            per_pass.append(len(self.markers_frames(self.fl.sysex_out[before:])))
        self.assertEqual(sum(per_pass), 3)
        self.assertTrue(all(n <= 1 for n in per_pass))
        parts = sorted(self.markers_frames(self.take()), key=lambda p: p[1])
        self.assertEqual([(p[0], p[1], len(p[2])) for p in parts], [(20, 0, 8), (20, 8, 8), (20, 16, 4)])
        self.assertEqual(parts[2][2][-1], (384 * 20, "Marker 19"))

    def test_the_scan_stops_at_127_markers(self):
        self.fl.marker_ticks = [96 * (i + 1) for i in range(200)]
        self.start()
        self.take()
        self.request()
        self.drain()
        parts = self.markers_frames(self.take())
        self.assertEqual({p[0] for p in parts}, {127})
        self.assertEqual(sum(len(p[2]) for p in parts), 127)
        self.assertLessEqual(len(self.fl.called("arrangement.jumpToMarker")), 1 + 127)

    def test_an_unchanged_list_is_not_sent_again_unless_asked_for(self):
        self.start()
        self.take()
        self.request()
        self.drain()
        self.assertEqual(len(self.listed(self.take())), 4)
        self.script._bridge.marker_scan = True  # a rescan by itself (project load) finds the same list
        self.drain()
        self.assertEqual(self.markers_frames(self.take()), [])
        self.request()  # mk3d asked: send it
        self.drain()
        self.assertEqual(len(self.listed(self.take())), 4)

    def test_a_shorter_list_drops_the_old_chunks(self):
        self.fl.marker_ticks = [384 * (i + 1) for i in range(12)]
        self.start()
        self.take()
        self.request()
        self.drain()
        self.take()
        self.fl.marker_ticks = [384]
        self.request()
        self.drain()
        parts = self.markers_frames(self.take())
        self.assertEqual([(p[0], p[1], len(p[2])) for p in parts], [(1, 0, 1)])
        self.assertNotIn("MARKERS@8", self.script._bridge.sent)

    def test_failing_jumps_still_restore_the_position_and_keep_the_names_with_unknown_times(self):
        self.fl.raise_on["arrangement.jumpToMarker"] = RuntimeError("boom")
        self.start()
        self.take()
        self.request()
        self.drain()
        self.assertEqual(self.fl.song_pos[2], 1000)
        unknown = self.script.MARKER_TICKS_UNKNOWN
        self.assertEqual(
            self.listed(self.take()), [(unknown, "Marker %d" % i) for i in range(4)]
        )
        self.fl.raise_on.clear()
        self.fl.raise_on["arrangement.getMarkerName"] = RuntimeError("boom")
        self.request()
        self.drain()
        self.assertEqual(self.markers_frames(self.take()), [(0, 0, [], 96)])  # names fail: none

    def test_project_load_scans_once_fl_is_stopped(self):
        self.start()
        self.take()
        self.fl.marker_ticks = [96]
        self.script.OnProjectLoad(self.script.midi.PL_LoadOk)
        self.drain()
        self.assertEqual(self.listed(self.take()), [(96, "Marker 0")])

    def test_project_load_start_does_not_scan(self):
        self.start()
        self.take()
        self.fl.calls[:] = []
        self.script.OnProjectLoad(self.script.midi.PL_Start)
        self.drain()
        self.assertEqual(self.fl.called("arrangement.jumpToMarker"), [])

    # -- JUMP_MARKER ----------------------------------------------------------------------------

    def scanned(self):
        self.start()
        self.take()
        self.request()
        self.drain()
        self.take()
        self.fl.calls[:] = []

    def jump(self, index, quantized):
        return self.send(self.script.frame(0x56, bytes([index, 1 if quantized else 0])))

    def test_jump_now_sets_the_song_position_in_ticks(self):
        self.scanned()
        event = self.jump(2, False)
        self.assertTrue(event.handled)
        self.assertEqual(self.fl.called("transport.setSongPos"), [(1536, 2)])
        self.assertEqual(self.fl.song_pos[2], 1536)

    def test_jump_vectors(self):
        self.scanned()
        self.send(bytes.fromhex("f07d4d33560000f7"))  # index 0, now
        self.assertEqual(self.fl.song_pos[2], 384)
        self.send(bytes.fromhex("f07d4d33560301f7"))  # index 3, quantized, stopped = now
        self.assertEqual(self.fl.song_pos[2], 3840)

    def test_a_jump_past_the_list_is_ignored(self):
        self.scanned()
        self.jump(4, False)
        self.jump(127, True)
        self.assertEqual(self.fl.called("transport.setSongPos"), [])

    def test_quantized_jump_while_playing_waits_for_the_bar(self):
        self.scanned()
        self.fl.playing = True
        self.jump(1, True)
        self.assertEqual(self.fl.called("transport.setSongPos"), [])
        self.script.OnUpdateBeatIndicator(2)  # a beat: not yet
        self.script.OnUpdateBeatIndicator(0)
        self.assertEqual(self.fl.called("transport.setSongPos"), [])
        self.script.OnUpdateBeatIndicator(1)  # the bar
        self.assertEqual(self.fl.called("transport.setSongPos"), [(768, 2)])
        self.script.OnUpdateBeatIndicator(1)  # only once
        self.assertEqual(len(self.fl.called("transport.setSongPos")), 1)

    def test_a_newer_quantized_jump_replaces_the_waiting_one(self):
        self.scanned()
        self.fl.playing = True
        self.jump(1, True)
        self.jump(3, True)
        self.script.OnUpdateBeatIndicator(1)
        self.assertEqual(self.fl.called("transport.setSongPos"), [(3840, 2)])

    def test_a_jump_now_cancels_a_waiting_one(self):
        self.scanned()
        self.fl.playing = True
        self.jump(1, True)
        self.jump(2, False)
        self.script.OnUpdateBeatIndicator(1)
        self.assertEqual(self.fl.called("transport.setSongPos"), [(1536, 2)])

    def test_a_waiting_jump_runs_at_once_when_fl_stops(self):
        self.scanned()
        self.fl.playing = True
        self.jump(1, True)
        self.fl.playing = False
        self.script.OnIdle()
        self.assertEqual(self.fl.called("transport.setSongPos"), [(768, 2)])

    def test_the_beat_callback_survives_errors(self):
        self.scanned()
        self.fl.playing = True
        self.jump(1, True)
        self.fl.raise_on["transport.setSongPos"] = RuntimeError("boom")
        self.script.OnUpdateBeatIndicator(1)  # no exception
        self.script.OnUpdateBeatIndicator("bar?")

    # -- ADD_MARKER, SET_LOOP_MODE, PLAYLIST_VIEW, SET_SONG_POS --------------------------------

    def test_add_marker_saves_undo_first_then_adds_and_rescans(self):
        self.scanned()
        self.fl.song_pos[2] = 1000
        self.send(bytes.fromhex("f07d4d3357f7"))
        self.assertEqual(self.fl.undo_names, ["MK3: add marker"])
        self.assertEqual(self.fl.added_markers, [(1000, "MK3 5")])
        names = [name for name, _ in [(n, a) for (n, a) in self.fl.calls]]
        self.assertLess(names.index("general.saveUndo"), names.index("arrangement.addAutoTimeMarker"))
        self.assertEqual(self.fl.called("general.saveUndo")[0][1], 2048)
        self.drain()
        listed = self.listed(self.take())
        self.assertEqual([t for t, _ in listed], [384, 768, 1000, 1536, 3840])
        self.assertEqual(self.fl.song_pos[2], 1000)  # the rescan put the song back

    def test_add_marker_while_playing_shows_it_at_once_and_scans_when_fl_stops(self):
        self.scanned()
        self.fl.playing = True
        self.fl.song_pos[2] = 2000
        self.send(bytes.fromhex("f07d4d3357f7"))
        self.drain()
        self.assertEqual(self.fl.called("arrangement.jumpToMarker"), [])
        listed = self.listed(self.take())
        self.assertEqual([t for t, _ in listed], [384, 768, 1536, 2000, 3840])
        self.assertEqual(listed[3][1], "MK3 5")
        self.fl.playing = False
        self.drain()
        self.assertGreater(len(self.fl.called("arrangement.jumpToMarker")), 0)

    def test_add_marker_while_playing_with_unknown_times_just_appends(self):
        self.fl.marker_ticks = [0, 384, 768]
        self.scanned()
        self.fl.playing = True
        self.fl.song_pos[2] = 100
        self.send(bytes.fromhex("f07d4d3357f7"))
        self.drain()
        names = [name for _, name in self.listed(self.take())]
        self.assertEqual(names, ["Marker 0", "Marker 1", "Marker 2", "MK3 4"])

    def test_add_marker_failure_is_caught(self):
        self.scanned()
        self.fl.raise_on["arrangement.addAutoTimeMarker"] = RuntimeError("boom")
        self.send(bytes.fromhex("f07d4d3357f7"))
        self.drain()

    def test_loop_mode_toggles_only_when_it_differs(self):
        self.start()
        self.take()
        self.fl.calls[:] = []
        self.send(bytes.fromhex("f07d4d335801f7"))  # song, FL is in pattern mode
        self.assertEqual(len(self.fl.called("transport.setLoopMode")), 1)
        self.assertEqual(self.fl.loop_mode, 1)
        self.send(bytes.fromhex("f07d4d335801f7"))  # song again: nothing
        self.assertEqual(len(self.fl.called("transport.setLoopMode")), 1)
        self.send(bytes.fromhex("f07d4d335800f7"))
        self.assertEqual(len(self.fl.called("transport.setLoopMode")), 2)
        self.assertEqual(self.fl.loop_mode, 0)

    def test_transport_carries_the_loop_mode(self):
        self.fl.loop_mode = 1
        frames = self.start()
        flags = self.frames_with(frames, 0x02)[0][5]
        self.assertEqual(flags & 0x10, 0x10)
        self.fl.loop_mode = 0
        self.script.OnIdle()
        self.clock.advance(0.2)
        self.drain()
        self.assertEqual(self.frames_with(self.take(), 0x02)[-1][5] & 0x10, 0)

    def test_transport_loop_mode_changes_are_sent(self):
        self.start()
        self.take()
        self.send(bytes.fromhex("f07d4d335801f7"))
        self.drain()
        self.assertEqual(self.frames_with(self.take(), 0x02)[-1][5] & 0x10, 0x10)

    def test_missing_loop_mode_functions_read_as_pattern(self):
        del sys.modules["transport"].getLoopMode
        frames = self.start()
        self.assertEqual(self.frames_with(frames, 0x02)[0][5] & 0x10, 0)

    def test_playlist_zoom_and_scroll_focus_the_playlist_first(self):
        self.start()
        self.take()
        self.fl.calls[:] = []
        self.send(bytes.fromhex("f07d4d3359003df7"))  # zoom -3
        self.assertEqual(self.fl.called("ui.showWindow"), [(2,)])
        self.assertEqual(self.fl.called("ui.setFocused"), [(2,)])
        self.assertEqual(self.fl.called("ui.horZoom"), [(-3,)])
        self.fl.calls[:] = []
        self.send(bytes.fromhex("f07d4d33590145f7"))  # scroll +5, the playlist has the focus now
        self.assertEqual(self.fl.called("ui.showWindow"), [])
        self.assertEqual(self.fl.called("ui.jog"), [(5,)])

    def test_playlist_view_failure_is_caught(self):
        self.start()
        self.fl.raise_on["ui.horZoom"] = RuntimeError("boom")
        self.send(bytes.fromhex("f07d4d3359003df7"))
        self.fl.raise_on["ui.getFocused"] = RuntimeError("boom")
        self.send(bytes.fromhex("f07d4d33590145f7"))

    def test_set_song_pos_in_ticks(self):
        self.start()
        self.take()
        self.fl.calls[:] = []
        self.send(bytes.fromhex("f07d4d335b001e00f7"))
        self.assertEqual(self.fl.called("transport.setSongPos"), [(3840, 2)])

    def test_marker_commands_survive_fl_errors(self):
        self.scanned()
        for name in ("transport.setSongPos", "transport.setLoopMode", "general.getRecPPQ"):
            self.fl.raise_on[name] = RuntimeError("boom")
        for hex_frame in ("f07d4d33560100f7", "f07d4d335801f7", "f07d4d335b001e00f7", "f07d4d335af7"):
            self.send(bytes.fromhex(hex_frame))
        self.drain()


class TransposeTests(BridgeTestCase):
    """TRANSPOSE (66): step pitches rewritten, the PROBE line."""

    channel_count = 200

    def vector(self, name):
        for v in load_vectors():
            if v["name"] == name:
                return bytes.fromhex(v["hex"])
        raise KeyError(name)

    def done(self):
        self.drain()
        return self.take()

    def probes(self, frames):
        return [bytes(f[5:-2]).decode("ascii") for f in self.frames_with(frames, 0x17)]

    def transpose(self, channel, semitones):
        s = self.script
        self.send(s.frame(0x66, s.enc_u14(channel) + bytes([semitones + 64])))

    def test_vector(self):
        self.start()
        self.fl.channels[130]["grid"].add(2)
        self.fl.step_params[(130, 2, 0)] = 60
        self.fl.calls[:] = []
        self.assertTrue(self.send(self.vector("transpose")).handled)
        self.assertEqual(self.fl.step_params[(130, 2, 0)], 48)

    def test_one_undo_point_first_then_the_step_pitches_move_and_nothing_else_does(self):
        self.start()
        self.fl.channels[3]["grid"].update([0, 4, 9])
        for step, pitch in ((0, 60), (4, 64), (9, 127)):
            self.fl.step_params[(3, step, 0)] = pitch
        self.fl.step_params[(3, 2, 0)] = 50  # a step that is off: left alone
        self.fl.calls[:] = []
        self.transpose(3, 5)
        frames = self.done()
        names = [name for (name, args) in self.fl.calls]
        self.assertEqual(self.fl.undo_names[-1], "MK3: transpose")
        self.assertLess(names.index("general.saveUndo"), names.index("channels.setStepParameterByIndex"))
        self.assertEqual(self.fl.step_params[(3, 0, 0)], 65)
        self.assertEqual(self.fl.step_params[(3, 4, 0)], 69)
        self.assertEqual(self.fl.step_params[(3, 9, 0)], 127)  # clamped
        self.assertEqual(self.fl.step_params[(3, 2, 0)], 50)
        self.assertEqual(self.fl.called("channels.setGridBit"), [])
        self.assertEqual(self.fl.called("ui.up"), [])
        self.assertEqual(self.probes(frames), ["transpose(ch 3, +5): steps 2 changed"])

    def test_clamps_at_zero_going_down(self):
        self.start()
        self.fl.channels[1]["grid"].update([0, 1])
        self.fl.step_params[(1, 0, 0)] = 3
        self.fl.step_params[(1, 1, 0)] = 40
        self.transpose(1, -12)
        self.done()
        self.assertEqual(self.fl.step_params[(1, 0, 0)], 0)
        self.assertEqual(self.fl.step_params[(1, 1, 0)], 28)

    def test_only_the_asked_channel_and_pattern_are_written(self):
        self.start()
        self.fl.pattern = 2
        self.fl.channels[0]["grid"].add(1)
        self.fl.channels[1]["grid"].add(1)
        self.fl.step_params[(0, 1, 0)] = 60
        self.fl.step_params[(1, 1, 0)] = 60
        self.transpose(0, 1)
        self.done()
        self.assertEqual(self.fl.step_params[(1, 1, 0)], 60)
        self.assertEqual(set(a[:2] for a in self.fl.called("channels.setStepParameterByIndex")), set([(0, 2)]))

    def test_without_step_notes_nothing_moves_and_no_window_is_touched(self):
        self.start()
        self.fl.calls[:] = []
        self.transpose(6, 12)
        frames = self.done()
        self.assertEqual(self.fl.called("ui.up"), [])
        self.assertEqual(self.fl.called("ui.showWindow"), [])
        self.assertEqual(self.fl.called("ui.setFocused"), [])
        self.assertEqual(self.probes(frames), ["transpose(ch 6, +12): steps 0 changed"])

    def test_a_failing_step_function_or_a_missing_one_does_not_raise(self):
        self.start()
        self.fl.channels[0]["grid"].add(0)
        self.fl.raise_on["channels.getCurrentStepParam"] = RuntimeError("boom")
        self.transpose(0, 1)
        self.done()
        self.fl.raise_on.clear()
        delattr(self.script.channels, "setStepParameterByIndex")
        self.transpose(0, 1)
        self.done()

    def test_a_bad_channel_or_zero_does_nothing(self):
        self.start()
        self.fl.calls[:] = []
        self.transpose(199, 0)
        self.transpose(500, 1)
        self.done()
        self.assertEqual(self.fl.called("general.saveUndo"), [])
        self.assertEqual(self.fl.called("ui.up"), [])


class LengthAndLoopTests(BridgeTestCase):
    """SET_PATTERN_LENGTH, SET_PATTERN_COLOR, SET_LOOP, REQUEST_LOOP, LOOP_STATE and FEATURES."""

    def done(self):
        """Everything sent since the last take (OnSysEx already serviced the command), drained."""
        self.drain()
        return self.take()

    def probes(self, frames):
        return [bytes(f[5:-2]).decode("ascii") for f in self.frames_with(frames, 0x17)]

    def u21(self, frame, at):
        return (frame[at] << 14) | (frame[at + 1] << 7) | frame[at + 2]

    def last(self, frames, command):
        found = self.frames_with(frames, command)
        self.assertTrue(found, "no 0x%02x frame" % command)
        return found[-1]

    # -- FEATURES -----------------------------------------------------------------------------

    def test_features_say_nothing_is_missing_when_the_functions_exist(self):
        frames = self.start()
        self.assertEqual(self.frames_with(frames, 0x1D), [bytes.fromhex("f07d4d331d00f7")])

    def test_features_report_each_missing_function(self):
        delattr(self.script.patterns, "setPatternLength")
        frames = self.start()
        self.assertEqual(self.frames_with(frames, 0x1D), [bytes.fromhex("f07d4d331d01f7")])
        delattr(self.script.arrangement, "selectionClear")
        self.send(self.script.frame(0x41))  # REQUEST_STATE: everything again
        frames = self.done()
        self.assertEqual(self.frames_with(frames, 0x1D), [bytes.fromhex("f07d4d331d03f7")])

    # -- LOOP_STATE ---------------------------------------------------------------------------

    def test_loop_state_is_sent_at_start_and_only_when_it_changes(self):
        frames = self.start()
        self.assertEqual(self.frames_with(frames, 0x1C), [bytes.fromhex("f07d4d331c00000000000000f7")])
        self.assertEqual(self.settle(), [])  # nothing changed: nothing sent
        self.fl.selection = (1536, 3072)  # FL's user drew a time selection
        self.script.OnIdle()  # picked up on the very next service pass, no 100 ms wait
        frames = self.take()
        loop = self.last(frames, 0x1C)
        self.assertEqual((loop[5], self.u21(loop, 6), self.u21(loop, 9)), (1, 1536, 3072))
        self.assertEqual(self.done(), [])
        self.fl.selection = None
        self.script.OnIdle()
        self.assertEqual(self.last(self.take(), 0x1C), bytes.fromhex("f07d4d331c00000000000000f7"))

    def test_request_loop_sends_it_again(self):
        self.start()
        self.fl.selection = (96, 192)
        self.drain()
        self.take()
        self.send(self.script.frame(0x61))
        frames = self.done()
        self.assertEqual(len(self.frames_with(frames, 0x1C)), 1)

    def test_loop_state_survives_missing_functions(self):
        delattr(self.script.arrangement, "selectionIsActive")
        frames = self.start()
        self.assertEqual(self.frames_with(frames, 0x1C), [bytes.fromhex("f07d4d331c00000000000000f7")])

    # -- SET_LOOP -----------------------------------------------------------------------------

    def test_set_loop_sets_reads_back_and_probes(self):
        self.start()
        event = self.send(self.script.frame(0x60, self.script.enc_u21(1536) + self.script.enc_u21(3072)))
        self.assertTrue(event.handled)
        self.assertEqual(self.fl.called("arrangement.selectionSet"), [(1536, 3072)])
        self.assertEqual(self.fl.selection, (1536, 3072))
        frames = self.done()
        self.assertEqual(self.probes(frames), ["selectionSet(1536, 3072) -> active=1 start=1536 end=3072"])
        loop = self.last(frames, 0x1C)
        self.assertEqual((loop[5], self.u21(loop, 6), self.u21(loop, 9)), (1, 1536, 3072))

    def test_set_loop_with_zeros_clears(self):
        self.start()
        self.fl.selection = (96, 192)
        self.send(self.script.frame(0x60, bytes(6)))
        self.assertEqual(self.fl.called("arrangement.selectionClear"), [()])
        self.assertEqual(self.fl.called("arrangement.selectionSet"), [])
        self.assertIsNone(self.fl.selection)
        frames = self.done()
        self.assertEqual(self.probes(frames), ["selectionClear() -> active=0 start=0 end=0"])

    def test_set_loop_ignores_an_empty_or_backwards_range(self):
        self.start()
        s = self.script
        self.send(s.frame(0x60, s.enc_u21(100) + s.enc_u21(100)))
        self.send(s.frame(0x60, s.enc_u21(200) + s.enc_u21(100)))
        self.assertEqual(self.fl.called("arrangement.selectionSet"), [])
        self.assertEqual(self.probes(self.done()), [])

    def test_set_loop_missing_function_sends_nothing(self):
        delattr(self.script.arrangement, "selectionSet")
        self.start()
        event = self.send(self.script.frame(0x60, self.script.enc_u21(1) + self.script.enc_u21(2)))
        self.assertTrue(event.handled)
        self.assertEqual(self.probes(self.done()), [])

    def test_set_loop_error_is_caught_and_probed(self):
        self.start()
        self.fl.raise_on["arrangement.selectionSet"] = RuntimeError("boom")
        event = self.send(self.script.frame(0x60, self.script.enc_u21(1) + self.script.enc_u21(2)))
        self.assertTrue(event.handled)
        self.assertEqual(self.probes(self.done()), ["selectionSet(1, 2) -> error: boom"])

    # -- SET_PATTERN_LENGTH -------------------------------------------------------------------

    def test_set_pattern_length_sets_reads_back_and_probes(self):
        self.start()
        s = self.script
        event = self.send(s.frame(0x5F, s.enc_u7(3) + s.enc_u14(32)))
        self.assertTrue(event.handled)
        self.assertEqual(self.fl.called("patterns.setPatternLength"), [(3, 32)])
        frames = self.done()
        self.assertEqual(self.probes(frames), ["setPatternLength(3, 32) -> getPatternLength(3) = 32"])
        # PATTERN follows with the new length (the pattern in view is number 1: same fake length)
        pattern = self.last(frames, 0x18)
        self.assertEqual((pattern[5] << 7) | pattern[6], 1)
        self.assertEqual((pattern[9] << 7) | pattern[10], 32)

    def test_set_pattern_length_clamps_and_checks_the_pattern(self):
        self.start()
        s = self.script
        self.send(s.frame(0x5F, s.enc_u7(2) + s.enc_u14(16383)))
        self.assertEqual(self.fl.called("patterns.setPatternLength"), [(2, 512)])
        self.send(s.frame(0x5F, s.enc_u7(2) + s.enc_u14(0)))
        self.assertEqual(self.fl.called("patterns.setPatternLength")[-1], (2, 1))
        self.send(s.frame(0x5F, s.enc_u7(99) + s.enc_u14(32)))  # only 5 patterns
        self.send(s.frame(0x5F, s.enc_u7(0) + s.enc_u14(32)))
        self.assertEqual(len(self.fl.called("patterns.setPatternLength")), 2)

    def test_set_pattern_length_missing_or_failing_function(self):
        self.start()
        s = self.script
        self.fl.raise_on["patterns.setPatternLength"] = RuntimeError("boom")
        self.assertTrue(self.send(s.frame(0x5F, s.enc_u7(1) + s.enc_u14(32))).handled)
        self.assertEqual(self.probes(self.done()), ["setPatternLength(1, 32) -> error: boom"])
        delattr(s.patterns, "setPatternLength")
        self.assertTrue(self.send(s.frame(0x5F, s.enc_u7(1) + s.enc_u14(32))).handled)
        self.assertEqual(self.probes(self.done()), [])

    # -- SET_PATTERN_COLOR --------------------------------------------------------------------

    def test_set_pattern_color_sets_reads_back_and_probes(self):
        self.start()
        s = self.script
        color = 0xE0707A
        payload = s.enc_u14(1) + s.enc_color(color)
        self.assertTrue(self.send(s.frame(0x62, payload)).handled)
        self.assertEqual(self.fl.called("patterns.setPatternColor"), [(1, color)])
        frames = self.done()
        self.assertEqual(self.probes(frames), ["setPatternColor(1, 0xe0707a) -> getPatternColor(1) = 0xe0707a"])
        pattern = self.last(frames, 0x18)
        # PATTERN's color field: after number (2), count (2), length (2)
        self.assertEqual(pattern[11:15], s.enc_color(color))

    def test_set_pattern_color_checks_the_pattern_and_catches_errors(self):
        self.start()
        s = self.script
        self.send(s.frame(0x62, s.enc_u14(77) + s.enc_color(1)))
        self.assertEqual(self.fl.called("patterns.setPatternColor"), [])
        self.fl.raise_on["patterns.setPatternColor"] = RuntimeError("boom")
        self.assertTrue(self.send(s.frame(0x62, s.enc_u14(1) + s.enc_color(1))).handled)
        self.assertEqual(self.probes(self.done()), ["setPatternColor(1, 0x000001) -> error: boom"])

    # -- the rules ----------------------------------------------------------------------------

    def test_probe_lines_are_never_deduplicated(self):
        self.start()
        s = self.script
        for _ in range(2):
            self.send(s.frame(0x5F, s.enc_u7(1) + s.enc_u14(32)))
            self.assertEqual(len(self.probes(self.done())), 1)

    def test_a_burst_of_sets_never_sends_more_than_eight_frames_per_callback(self):
        self.start()
        s = self.script
        for length in range(10, 40):
            self.send(s.frame(0x5F, s.enc_u7(1) + s.enc_u14(length)))
        total = 0
        for _ in range(100):
            before = len(self.fl.sysex_out)
            self.script.OnIdle()
            sent = len(self.fl.sysex_out) - before
            self.assertLessEqual(sent, 8)
            total += sent
            if not self.bridge.queue and not sent:
                break
        self.assertGreaterEqual(len(self.probes(self.take())), 30)


class PlaylistProbeTests(BridgeTestCase):
    """RUN_PROBE (5C): PROBE lines (17) with what the performance-mode functions return."""

    RUN = "f07d4d335cf7"

    @staticmethod
    def text(frame):
        payload = frame[5:-1]
        assert payload[-1] == 0
        return bytes(payload[:-1]).decode("ascii")

    def probe_frames(self, frames):
        return [self.text(f) for f in self.frames_with(frames, 0x17)]

    def run_probe(self, ilmcp=False):
        """RUN_PROBE and OnIdle until the lines stop; returns the PROBE texts, in order (the playlist
        lines only, unless `ilmcp`: the ilmcp browser lines come first)."""
        self.start()
        self.take()
        self.send(self.RUN)
        self.drain()
        lines = self.probe_frames(self.take())
        if ilmcp:
            return lines
        hidden = ("ilmcp: ", "browser ", "prscript: ", "channels.getSwing", "general.getProjectTitle")
        hidden += ("arrangement.selectionIsActive", "mixer.getPluginMixLevel")
        hidden += ("patterns.getBlockSetStatus",)
        kept, skipping = [], False
        for l in lines:  # a hidden line's continuations ("+ …") go with it
            if l.startswith("+ "):
                if not skipping:
                    kept.append(l)
                continue
            skipping = l.startswith(hidden)
            if not skipping:
                kept.append(l)
        return kept

    def test_the_ilmcp_browser_lines_come_first_and_only_read(self):
        calls = []

        class FakeIlmcp:
            def getBrowserNames(self, path, recursive):
                calls.append((path, recursive))
                return {"": ["Current project", "Plugin database"], "Plugin database": ["Generators"]}.get(
                    path, []
                )

            def addChannel(self, name=""):
                raise AssertionError("the probe must not add channels")

        sys.modules["ilmcp"] = FakeIlmcp()
        try:
            lines = self.run_probe(ilmcp=True)
        finally:
            del sys.modules["ilmcp"]
        self.assertEqual(lines[0], "ilmcp: addChannel getBrowserNames")
        self.assertEqual(lines[1], "browser '' (2): Current project, Plugin database")
        self.assertIn("browser 'Plugin database' (1): Generators", lines)
        self.assertTrue(all(recursive is False for _, recursive in calls))

    def test_the_piano_roll_probe_runs_a_reading_script_and_reports_the_shared_notes(self):
        scripts = []

        class FakeIlmcp:
            def getBrowserNames(self, path, recursive):
                return []

            def runPRScript(self, code):
                scripts.append(code)
                shared = type(sys)("mk3_shared")
                shared.notes = [(60, 0, 96, 0.8)]
                shared.ppq = 96
                sys.modules["mk3_shared"] = shared
                return None

        sys.modules["ilmcp"] = FakeIlmcp()
        try:
            lines = self.run_probe(ilmcp=True)
        finally:
            del sys.modules["ilmcp"]
            sys.modules.pop("mk3_shared", None)
        line = next(l for l in lines if l.startswith("prscript: "))
        self.assertIn("shared=1 notes ppq 96", line)
        self.assertEqual(len(scripts), 1)
        self.assertNotIn("addNote", scripts[0])  # it only reads

    def test_without_ilmcp_the_probe_says_so(self):
        lines = self.run_probe(ilmcp=True)
        self.assertTrue(lines[0].startswith("ilmcp: import failed"))

    def test_nothing_is_sent_without_run_probe(self):
        self.start()
        self.settle()
        self.assertEqual(self.probe_frames(self.take()), [])
        self.assertEqual(self.fl.called("playlist.getLiveStatus"), [])

    def test_one_line_per_tick_and_never_a_burst(self):
        self.start()
        self.take()
        self.send(self.RUN)
        self.take()
        counts = []
        for _ in range(120):
            self.script.OnIdle()
            counts.append(len(self.probe_frames(self.take())))
        self.assertTrue(all(c <= 1 for c in counts), counts)
        first_empty = counts.index(0)
        self.assertTrue(first_empty >= 44, counts)  # every line took its own tick (a long one, several)
        self.assertEqual(sum(counts[first_empty:]), 0)  # and then it is over
        self.assertEqual(self.bridge.probe_todo, [])

    def test_the_run_probe_command_sends_the_first_line_at_once(self):
        self.start()
        self.take()
        self.send(self.RUN)
        self.assertEqual(len(self.probe_frames(self.take())), 1)

    def test_the_lines_come_in_the_order_of_the_spec(self):
        lines = self.run_probe()
        self.assertEqual(
            lines[0],
            "perf=False tracks=500 ppq=96 songlen=3840 bars=10 start=0 pos=0 loop=0",
        )
        self.assertEqual(
            lines[1],
            "blocks: " + " ".join(str(b * 384) for b in range(16)),
        )
        self.assertEqual(lines[2], "t2b: " + " ".join(str(4 * bar) for bar in range(16)))
        self.assertTrue(lines[3].startswith('track0 "Track 0" st=0 '))
        track_lines = [l for l in lines if l.startswith("T")]
        self.assertEqual(sum(1 for l in track_lines if l.startswith("T12 ")), 3)
        self.assertFalse(any(l.startswith("T13 ") for l in lines))
        self.assertTrue(lines[-2].startswith("markers: "))
        self.assertTrue(lines[-1].startswith("patterns: n=5 "))

    def test_track_lines(self):
        lines = self.run_probe()
        # T2: status mode Simplest as hex digits, joined; getLiveStatus(i, Simplest)
        simplest = "".join("%x" % ((2 + b) % 3) for b in range(16))
        self.assertIn('T2 "Track 2" st=2 ' + simplest, lines)
        self.assertEqual(self.fl.called("playlist.getLiveStatus")[:2], [(0, 2), (1, 2)])
        self.assertIn(("playlist.getLiveBlockStatus", (2, 3, 0)), self.fl.calls)  # LB_Status_Default
        self.assertIn(("playlist.getLiveBlockStatus", (2, 3, 2)), self.fl.calls)  # LB_Status_Simplest
        default = "T2 def: " + " ".join("%x" % (2 * 16 + b) for b in range(16))
        self.assertIn(default, lines)
        colors = ["%06x" % (0x123456 + b) for b in range(15)] + ["ffffff"]
        joined = " ".join(colors)
        piece = [l for l in lines if l.startswith("T2 col: ")][0]
        self.assertTrue(joined.startswith(piece[len("T2 col: ") :]))
        self.assertEqual(self.fl.called("playlist.getLiveBlockColor")[0], (0, 0))

    def test_every_text_fits_100_characters_and_a_long_line_continues(self):
        lines = self.run_probe()
        self.assertTrue(all(len(l) <= 100 for l in lines), [l for l in lines if len(l) > 100])
        index = [i for i, l in enumerate(lines) if l.startswith("T1 col: ")][0]
        self.assertTrue(lines[index + 1].startswith("+ "))
        whole = lines[index] + " " + lines[index + 1][2:]
        self.assertEqual(whole.split("col: ")[1].split(" "), ["%06x" % (0x123456 + b) for b in range(15)] + ["ffffff"])

    def test_split_probe_text(self):
        split = self.script.split_probe_text
        self.assertEqual(split("short"), ["short"])
        self.assertEqual(split("x" * 100), ["x" * 100])
        self.assertEqual(split("x" * 101), ["x" * 100, "+ x"])
        pieces = split(" ".join(["abcdef"] * 30))
        self.assertTrue(len(pieces) > 1 and all(len(p) <= 100 for p in pieces))
        self.assertEqual(" ".join(p.lstrip("+ ") if i else p for i, p in enumerate(pieces)), " ".join(["abcdef"] * 30))

    def test_the_markers_and_patterns_lines(self):
        self.fl.marker_ticks = [384, 768]
        self.fl.marker_names = {0: "Intro", 1: "Drop"}
        self.fl.pattern_count = 10
        self.fl.pattern_names = {1: "Kick"}
        lines = self.run_probe()
        self.assertIn("markers: 0=Intro, 1=Drop", lines)
        patterns = [l for l in lines if l.startswith("patterns: ")][0]
        self.assertTrue(patterns.startswith("patterns: n=10 Kick/16, Pattern 2/16"))

    def test_no_markers(self):
        self.fl.marker_ticks = []
        self.assertIn("markers: (none)", self.run_probe())

    def test_a_failing_call_becomes_an_error_note_and_the_rest_goes_on(self):
        self.fl.raise_on["playlist.getPerformanceModeState"] = RuntimeError("boom")
        self.fl.raise_on["playlist.getLiveStatus"] = RuntimeError("no live")
        self.fl.raise_on["arrangement.getMarkerName"] = RuntimeError("no markers")
        self.fl.raise_on["patterns.patternCount"] = RuntimeError("no count")
        lines = self.run_probe()
        self.assertTrue(lines[0].startswith("perf=? tracks=500 ppq=96 "), lines[0])
        self.assertIn("playlist.getPerformanceModeState: error boom", lines[0] + " " + lines[1])
        t1 = [l for l in lines if l.startswith('T1 "Track 1" st=? ')][0]
        self.assertIn("playlist.getLiveStatus: error no live", t1)
        self.assertIn("markers: (none) | arrangement.getMarkerName: error no markers", lines)
        self.assertIn("patterns: n=? | patterns.patternCount: error no count", [l.rstrip() for l in lines])
        self.assertTrue(any(l.startswith("T12 def: ") for l in lines))  # the rest still ran

    def test_a_missing_function_is_an_error_note_too(self):
        del sys.modules["playlist"].getLiveBlockColor
        lines = self.run_probe()
        colors = [l for l in lines if l.startswith("T1 col: ")][0]
        self.assertIn("? ? ?", colors)
        self.assertTrue(any("playlist.getLiveBlockColor: error" in l for l in lines))
        self.assertTrue(lines[-1].startswith("patterns: "))

    def test_every_call_is_read_only(self):
        self.run_probe()
        changing = [n for n, _ in self.fl.calls if n.startswith(("transport.set", "ui.show", "ui.hide", "ui.set", "playlist.trigger", "playlist.lock"))]
        self.assertEqual(changing, [])

    def test_a_second_run_probe_starts_over(self):
        self.start()
        self.take()
        self.send(self.RUN)
        self.script.OnIdle()
        self.send(self.RUN)
        self.drain()
        lines = self.probe_frames(self.take())
        # the first run got as far as its first line (ilmcp's), the second ran to the end
        self.assertEqual(sum(1 for l in lines if l.startswith("ilmcp: ")), 2)
        self.assertEqual(sum(1 for l in lines if l.startswith("perf=")), 1)
        self.assertEqual(sum(1 for l in lines if l.startswith("patterns: ")), 1)

    def test_probe_frames_are_not_remembered(self):
        self.run_probe()
        self.assertEqual([k for k in self.bridge.sent if k.startswith("PROBE")], [])
        self.send(self.RUN)
        self.drain()
        self.assertEqual(sum(1 for l in self.probe_frames(self.take()) if l.startswith("perf=")), 1)


def parse_pattern_grid(frame):
    """Decode a PATTERN_GRID frame by hand: (channel, start, steps, flags)."""
    data = list(frame[5:-1])
    channel = data[0]
    start = (data[1] << 7) | data[2]
    n = data[3]
    pos = 4
    steps = []
    for first in range(0, n, 7):
        bits = data[pos]
        pos += 1
        assert bits < 0x80
        steps.extend(bool(bits & (1 << i)) for i in range(min(7, n - first)))
    flags = data[pos]
    assert pos + 1 == len(data), "trailing bytes in PATTERN_GRID"
    return channel, start, steps, flags


class LiveSceneTests(BridgeTestCase):
    """VIEW's liveScenes/liveOffset, LIVE_GRID (0x23) and TRIGGER_LIVE_CLIP (0x6A): the LIVE
    overlay's scene grid. A press makes the call Image-Line's Akai Fire script makes for a scene
    launch: one playlist.triggerLiveClip(track, block, TLC_MuteOthers | TLC_Fill | TLC_ColumnMode
    [| TLC_GlobalSnap]) on the first scanned track filled at the block, and the release repeats it
    with TLC_Release. The grid ORs the LB_Status_Default bits (filled 1, scheduled 2, playing 4)."""

    LAUNCH = 1 | 2 | 128  # TLC_MuteOthers | TLC_Fill | TLC_ColumnMode
    GLOBAL_SNAP = 8
    RELEASE = 32

    def view_frame(self, scenes=True, offset=0):
        s = self.script
        payload = (
            s.enc_u14(0)
            + s.enc_u14(0)
            + s.enc_u14(0)
            + s.enc_u14(0)
            + bytes([0, 0])  # flags (none), 0 params
            + s.enc_flag(scenes)
            + s.enc_u14(offset)
        )
        return s.frame(0x42, payload)

    def trigger_frame(self, block, release=False):
        s = self.script
        return s.frame(0x6A, s.enc_u14(s.NONE_INDEX if block is None else block) + s.enc_flag(release))

    def track_rows(self, frames):
        """LIVE_TRACK (0x25) frames by track: {track: (offset, flags, name, [status...])} (payload:
        offset u14, track u7, flags u7, color u7x4, trigSnap u7, name str, n u7, n x (status u7,
        color u7x4))."""
        rows = {}
        for frame in self.frames_with(frames, 0x25):
            payload = frame[5:-1]
            offset = payload[0] << 7 | payload[1]
            track, flags = payload[2], payload[3]
            pos = 9
            end = payload.index(0, pos)
            name = payload[pos:end].decode()
            pos = end + 1
            n = payload[pos]
            pos += 1
            statuses = [payload[pos + 5 * i] for i in range(n)]
            rows[track] = (offset, flags, name, statuses)
        return rows

    def press(self, block, release=False):
        self.fl.calls[:] = []
        self.send(self.trigger_frame(block, release))
        return self.fl.called("playlist.triggerLiveClip")

    def test_the_flag_decodes_and_defaults_to_off(self):
        decoded = self.script.decode(self.view_frame(scenes=True, offset=16))
        self.assertEqual((decoded["liveScenes"], decoded["liveOffset"]), (True, 16))
        plain = self.script.decode(self.script.frame(0x42, self.script.enc_u14(0) * 4 + bytes([0, 0])))
        self.assertEqual((plain["liveScenes"], plain["liveOffset"]), (False, 0))

    def test_the_trigger_decodes_its_release_flag(self):
        decode = self.script.decode
        self.assertEqual(decode(self.trigger_frame(2)), {"type": "triggerLiveClip", "block": 2, "release": False})
        self.assertEqual(decode(self.trigger_frame(2, True))["release"], True)
        self.assertEqual(decode(self.trigger_frame(None))["block"], None)
        bare = decode(self.script.frame(0x6A, self.script.enc_u14(2)))
        self.assertEqual(bare["release"], False)

    def test_nothing_is_read_without_the_flag(self):
        self.start()
        self.take()
        self.fl.calls[:] = []
        self.send(self.view_frame(scenes=False))
        self.settle()
        self.assertEqual(self.fl.called("playlist.getLiveBlockStatus"), [])

    def test_it_scans_exactly_LIVE_TRACK_SCAN_tracks_per_block_in_the_default_mode(self):
        self.start()
        self.take()
        self.send(self.view_frame())
        self.drain()
        calls = self.fl.called("playlist.getLiveBlockStatus")
        self.assertEqual({args[0] for args in calls}, set(range(1, self.script.LIVE_TRACK_SCAN + 1)))
        self.assertEqual({args[2] for args in calls}, {0})  # LB_Status_Default: scheduled != playing

    def test_a_header_and_one_row_per_scanned_track(self):
        self.fl.live_blocks = {(1, 0): 1, (2, 0): 5, (3, 1): 3, (9, 2): 5}
        self.fl.muted_tracks = {2}
        self.fl.solo_tracks = {3}
        self.start()
        self.take()
        self.send(self.view_frame(offset=0))
        self.drain()
        frames = self.take()
        header = self.frames_with(frames, 0x23)
        self.assertEqual(header[-1][5:-1], bytes([self.script.LIVE_TRACK_SCAN, 0]))  # scanned, perf off
        rows = self.track_rows(frames)
        self.assertEqual(sorted(rows), list(range(1, self.script.LIVE_TRACK_SCAN + 1)))  # not track 9
        self.assertEqual(rows[1], (0, 0, "Track 1", [1] + [0] * 15))
        self.assertEqual(rows[2], (0, 1, "Track 2", [5] + [0] * 15))  # muted
        self.assertEqual(rows[3], (0, 2, "Track 3", [0, 3] + [0] * 14))  # soloed

    def test_only_changed_rows_go_out_again(self):
        self.fl.live_blocks = {(1, 0): 1}
        self.start()
        self.send(self.view_frame())
        self.drain()
        self.take()
        self.fl.live_blocks[(2, 4)] = 3
        self.clock.advance(self.script.LIVE_SECONDS + 0.001)
        self.drain()
        self.assertEqual(sorted(self.track_rows(self.take())), [2])

    def test_the_grid_is_read_at_most_every_LIVE_SECONDS(self):
        self.start()
        self.send(self.view_frame())
        self.drain()
        self.fl.calls[:] = []
        self.drain()  # same instant: no new read
        self.assertEqual(self.fl.called("playlist.getLiveBlockStatus"), [])
        self.clock.advance(self.script.LIVE_SECONDS + 0.001)
        self.drain()
        self.assertTrue(self.fl.called("playlist.getLiveBlockStatus"))

    def test_OnUpdateLiveMode_and_a_trigger_read_the_grid_at_once(self):
        self.fl.live_blocks = {(1, 0): 1}
        self.start()
        self.send(self.view_frame())
        self.drain()
        self.fl.calls[:] = []
        self.script.OnUpdateLiveMode(8)
        self.drain()
        self.assertTrue(self.fl.called("playlist.getLiveBlockStatus"))
        self.fl.calls[:] = []
        self.fl.live_blocks[(1, 0)] = 3
        self.send(self.trigger_frame(0))  # OnSysEx services right away
        self.drain()
        self.assertEqual(self.track_rows(self.take())[1][3][0], 3)

    def test_a_press_launches_the_scene_from_the_first_filled_track(self):
        self.fl.live_blocks = {(3, 2): 1, (5, 2): 1}
        self.start()
        triggered = self.press(2)
        self.assertEqual(triggered, [(3, 2, self.LAUNCH | self.GLOBAL_SNAP)])  # snap is on (8)

    def test_without_snap_the_launch_has_no_global_snap(self):
        self.fl.live_blocks = {(1, 0): 1}
        self.fl.snap = 3  # Snap_None
        self.start()
        self.assertEqual(self.press(0), [(1, 0, self.LAUNCH)])

    def test_the_release_repeats_the_press_with_TLC_Release(self):
        self.fl.live_blocks = {(3, 2): 1}
        self.start()
        self.press(2)
        released = self.press(2, release=True)
        self.assertEqual(released, [(3, 2, self.LAUNCH | self.GLOBAL_SNAP | self.RELEASE)])
        self.assertEqual(self.press(2, release=True), [])  # only once

    def test_an_empty_block_or_a_stray_release_calls_nothing(self):
        self.fl.live_blocks = {}
        self.start()
        self.assertEqual(self.press(4), [])
        self.assertEqual(self.press(4, release=True), [])

    def test_a_null_block_stops_every_scanned_track(self):
        self.start()
        triggered = self.press(None)
        scan = self.script.LIVE_TRACK_SCAN
        self.assertEqual(triggered, [(t, -1, 1 | 2) for t in range(1, scan + 1)])  # MuteOthers | Fill


class ActivityTests(BridgeTestCase):
    """ACTIVITY (0x24): which channels of the selected channel's bank FL plays now
    (channels.getActivityLevel > 0, as Image-Line's Akai Fire script lights its channel pads)."""

    def activity(self, frames):
        found = self.frames_with(frames, 0x24)
        self.assertTrue(found, "no ACTIVITY (0x24) frame")
        payload = found[-1][5:-1]
        first = payload[0] << 7 | payload[1]
        return first, [b != 0 for b in payload[3 : 3 + payload[2]]]

    channel_count = 20

    def setup_channels(self, count, selected):
        del self.fl.channels[count:]
        for i, channel in enumerate(self.fl.channels):
            channel["selected"] = i == selected

    def test_it_reports_the_selected_channels_bank(self):
        self.setup_channels(20, 17)
        self.fl.activity = {16: 0.8, 19: 0.1, 3: 1.0}  # channel 3 is in another bank
        first, active = self.activity(self.start())
        self.assertEqual(first, 16)
        self.assertEqual(active, [True, False, False, True])

    def test_it_is_read_while_playing_and_clears_after(self):
        self.setup_channels(4, 0)
        self.start()
        self.fl.playing = True
        self.fl.activity = {1: 0.5}
        self.clock.advance(self.script.ACTIVITY_SECONDS + 0.001)
        self.drain()
        self.assertEqual(self.activity(self.take()), (0, [False, True, False, False]))
        self.fl.playing = False
        self.fl.activity = {}
        self.clock.advance(self.script.ACTIVITY_SECONDS + 0.001)
        self.drain()  # no 100 ms re-read yet: the lit pad still gets its clearing frame
        self.assertEqual(self.activity(self.take()), (0, [False, False, False, False]))
        self.fl.calls[:] = []
        self.bridge.last_full = self.clock()  # keep the 100 ms full re-read (which reads everything) out
        self.clock.advance(self.script.ACTIVITY_SECONDS + 0.001)
        self.drain()
        self.assertEqual(self.fl.called("channels.getActivityLevel"), [])  # stopped and dark: not read

    def test_while_playing_it_is_read_at_most_every_ACTIVITY_SECONDS(self):
        self.setup_channels(4, 0)
        self.start()
        self.fl.playing = True
        self.drain()
        self.fl.calls[:] = []
        self.drain()  # same instant
        self.assertEqual(self.fl.called("channels.getActivityLevel"), [])
        self.clock.advance(self.script.ACTIVITY_SECONDS + 0.001)
        self.drain()
        self.assertTrue(self.fl.called("channels.getActivityLevel"))


class PatternGridTests(BridgeTestCase):
    """PATTERN_GRID (1B) and VIEW's patternGrid flag: ARRANGER's pattern overview."""

    channel_count = 40

    def view_frame(self, channel=0, step=0, grid=True, pattern=0):
        s = self.script
        payload = (
            s.enc_u14(channel)
            + s.enc_u14(0)
            + s.enc_u14(pattern)
            + s.enc_u14(step)
            + bytes([4 if grid else 0, 0])
        )
        return s.frame(0x42, payload)

    def chunks(self, frames):
        return [parse_pattern_grid(f) for f in self.frames_with(frames, 0x1B)]

    def watch(self, **kwargs):
        """Start, send the VIEW, and return every PATTERN_GRID chunk it takes to settle."""
        self.start()
        self.take()
        self.send(self.view_frame(**kwargs))
        self.drain()
        return self.chunks(self.take())

    def test_nothing_is_read_or_sent_without_the_flag(self):
        self.start()
        self.take()
        self.fl.calls[:] = []
        self.send(self.view_frame(grid=False))
        frames = self.settle()
        self.assertEqual(self.chunks(frames), [])
        # only the STEP window of the selected channel is read, 16 bits, never a whole pattern
        self.assertLessEqual(len(self.fl.called("channels.getGridBit")), 16 * 3)
        self.assertEqual(self.fl.called("channels.isGridBitAssigned"), [])

    def test_the_flag_decodes(self):
        decoded = self.script.decode(self.view_frame(channel=16, step=32))
        self.assertTrue(decoded["patternGrid"])
        self.assertFalse(self.script.decode(self.view_frame(grid=False))["patternGrid"])

    def test_the_16_channels_of_the_bank_get_the_whole_pattern(self):
        self.fl.pattern_len_steps = 64
        self.fl.channels[2]["grid"] = {0, 4, 17, 63}
        chunks = self.watch()
        self.assertEqual(len(chunks), 16 * 4)
        self.assertEqual(sorted({c[0] for c in chunks}), list(range(16)))
        self.assertEqual(sorted({c[1] for c in chunks}), [0, 16, 32, 48])
        self.assertTrue(all(len(c[2]) == 16 for c in chunks))
        by_key = dict(((c[0], c[1]), c[2]) for c in chunks)
        self.assertEqual([i for i, on in enumerate(by_key[(2, 0)]) if on], [0, 4])
        self.assertEqual([i for i, on in enumerate(by_key[(2, 16)]) if on], [1])
        self.assertEqual([i for i, on in enumerate(by_key[(2, 48)]) if on], [15])
        self.assertEqual(sum(1 for c in chunks if any(c[2])), 3)

    def test_the_bank_follows_channel_offset_and_is_cut_at_the_total(self):
        chunks = self.watch(channel=32)
        self.assertEqual(sorted({c[0] for c in chunks}), list(range(32, 40)))

    def test_a_pattern_is_read_up_to_256_steps(self):
        self.fl.pattern_len_steps = 400
        self.fl.channels[0]["grid"] = {255, 256}
        chunks = self.watch()
        self.assertEqual(len(chunks), 16 * 16)
        self.assertEqual(max(c[1] for c in chunks), 240)
        last = [c for c in chunks if c[0] == 0 and c[1] == 240][0]
        self.assertTrue(last[2][15])  # step 255; step 256 is not sent

    def test_a_short_last_chunk_is_partial(self):
        self.fl.pattern_len_steps = 20
        self.fl.channels[1]["grid"] = {17, 19}
        chunks = self.watch()
        partial = [c for c in chunks if c[0] == 1 and c[1] == 16][0]
        self.assertEqual(partial[2], [False, True, False, True])

    def test_chunks_are_paced_a_few_per_pass(self):
        self.fl.pattern_len_steps = 256
        self.start()
        self.take()
        self.send(self.view_frame())  # the first pass runs inside OnSysEx
        per_pass = [len(self.chunks(self.fl.sysex_out))]
        for _ in range(200):
            before = len(self.fl.sysex_out)
            self.script.OnIdle()
            per_pass.append(len(self.chunks(self.fl.sysex_out[before:])))
            if not self.bridge.pg_todo and not self.bridge.queue and not self.bridge.dirty:
                break
        limit = self.script.PATTERN_GRID_CHUNKS_PER_PASS
        self.assertTrue(all(n <= limit for n in per_pass), per_pass)
        self.assertGreater(sum(1 for n in per_pass if n), 40)  # spread over many passes
        self.assertEqual(sum(per_pass), 16 * 16)

    def test_the_visible_step_page_comes_first(self):
        self.fl.pattern_len_steps = 128
        self.start()
        self.take()
        self.send(self.view_frame(step=32))
        for _ in range(5):
            self.script.OnIdle()
        first = self.chunks(self.take())
        self.assertGreaterEqual(len(first), 16)
        self.assertEqual({c[1] for c in first[:16]}, {32})
        self.assertEqual(sorted(c[0] for c in first[:16]), list(range(16)))

    def test_only_changed_chunks_are_sent_again(self):
        self.fl.pattern_len_steps = 64
        self.watch()
        self.assertEqual(self.chunks(self.settle()), [])  # the 100 ms re-read finds nothing new
        self.fl.channels[5]["grid"] = {20}
        chunks = self.chunks(self.settle())
        self.assertEqual([(c[0], c[1]) for c in chunks], [(5, 16)])
        self.assertTrue(chunks[0][2][4])

    def test_set_step_marks_the_overview_at_once(self):
        self.fl.pattern_len_steps = 32
        self.watch()
        self.send(self.script.frame(0x45, self.script.enc_u14(3) + self.script.enc_u14(18) + bytes([1])))
        self.drain()
        chunks = self.chunks(self.take())
        self.assertEqual([(c[0], c[1]) for c in chunks], [(3, 16)])

    def test_a_pattern_change_sends_every_chunk_of_the_new_pattern_after_pattern(self):
        self.fl.pattern_len_steps = 32
        self.watch()
        self.fl.pattern = 2
        self.send(self.script.frame(0x49, self.script.enc_u14(2)))  # SELECT_PATTERN
        self.drain()
        frames = self.take()
        chunks = self.chunks(frames)
        self.assertEqual(len(chunks), 16 * 2)  # the cache was dropped: everything again
        commands = [self.command(f) for f in frames]
        self.assertIn(0x18, commands)
        self.assertLess(commands.index(0x18), commands.index(0x1B))  # PATTERN first

    def test_the_flag_going_off_stops_it_and_on_again_resends_everything(self):
        self.fl.pattern_len_steps = 16
        self.watch()
        self.send(self.view_frame(grid=False))
        self.fl.calls[:] = []
        self.assertEqual(self.chunks(self.settle()), [])
        self.assertEqual(self.fl.called("channels.isGridBitAssigned"), [])
        self.send(self.view_frame())
        self.drain()
        self.assertEqual(len(self.chunks(self.take())), 16)

    def test_moving_the_bank_sends_the_new_channels(self):
        self.fl.pattern_len_steps = 16
        self.watch()
        self.send(self.view_frame(channel=16))
        self.drain()
        chunks = self.chunks(self.take())
        self.assertEqual(sorted(c[0] for c in chunks), list(range(16, 32)))
        self.send(self.view_frame(channel=0))
        self.drain()
        self.assertEqual(self.chunks(self.take()), [])  # mk3d still has bank 1, unchanged

    def test_the_step_sequencer_flag_comes_from_is_grid_bit_assigned(self):
        self.fl.channels[3]["step_row"] = False
        chunks = self.watch()
        flags = dict((c[0], c[3]) for c in chunks)
        self.assertEqual(flags[3], 0)
        self.assertTrue(all(flag == 1 for channel, flag in flags.items() if channel != 3))
        self.assertIn(("channels.isGridBitAssigned", (3,)), self.fl.calls)

    def test_a_missing_or_failing_is_grid_bit_assigned_reads_as_a_step_channel(self):
        del sys.modules["channels"].isGridBitAssigned
        chunks = self.watch()
        self.assertEqual({c[3] for c in chunks}, {1})
        self.assertEqual(len(chunks), 16)

    def test_a_failing_is_grid_bit_assigned_is_a_step_channel_too(self):
        self.fl.raise_on["channels.isGridBitAssigned"] = RuntimeError("boom")
        chunks = self.watch()
        self.assertEqual({c[3] for c in chunks}, {1})

    def test_failing_grid_calls_send_empty_chunks_and_do_not_stop_the_rest(self):
        self.fl.raise_on["channels.getGridBit"] = RuntimeError("boom")
        chunks = self.watch()
        self.assertEqual(len(chunks), 16)
        self.assertFalse(any(any(c[2]) for c in chunks))

    def test_channels_from_128_up_get_no_row(self):
        self.fl.channels += [dict(self.fl.channels[0]) for _ in range(200 - len(self.fl.channels))]
        chunks = self.watch(channel=120)
        self.assertEqual(sorted({c[0] for c in chunks}), list(range(120, 128)))
        self.assertEqual(self.chunks(self.settle()), [])

    def test_request_state_sends_everything_again(self):
        self.fl.pattern_len_steps = 32
        self.watch()
        self.send(self.script.frame(0x41))
        self.drain()
        self.assertEqual(len(self.chunks(self.take())), 16 * 2)

    def test_a_batch_edit_restarts_the_overview(self):
        self.fl.pattern_len_steps = 32
        self.fl.channels[2]["grid"] = {1, 2, 3}
        self.watch()
        self.send(self.script.frame(0x4F, self.script.enc_u14(2)))  # CLEAR_STEPS
        self.drain()
        chunks = self.chunks(self.take())
        self.assertEqual([(c[0], c[1]) for c in chunks], [(2, 0)])
        self.assertFalse(any(chunks[0][2]))

    def test_chunk_keys_are_per_channel_and_start(self):
        self.fl.pattern_len_steps = 32
        self.watch()
        keys = [k for k in self.bridge.sent if k.startswith("PATTERN_GRID@")]
        self.assertIn("PATTERN_GRID@0@0", keys)
        self.assertIn("PATTERN_GRID@15@16", keys)
        self.assertEqual(len(keys), 16 * 2)


class DoublePatternTests(BridgeTestCase):
    """DOUBLE_PATTERN (63) and CREATE_PATTERN (64)."""

    def vector(self, name):
        for v in load_vectors():
            if v["name"] == name:
                return bytes.fromhex(v["hex"])
        raise KeyError(name)

    def done(self):
        self.drain()
        return self.take()

    def double(self, pattern=1):
        s = self.script
        self.send(s.frame(0x63, s.enc_u7(pattern)))

    def probes(self, frames):
        return [bytes(f[5:-2]).decode("ascii") for f in self.frames_with(frames, 0x17)]

    def grids(self, frames):
        return self.frames_with(frames, 0x1A)

    def test_vector(self):
        self.start()
        self.fl.pattern = 3
        self.fl.calls[:] = []
        self.assertTrue(self.send(self.vector("doublePattern")).handled)
        self.assertEqual(self.fl.called("patterns.setPatternLength"), [(3, 32)])

    def test_shift_double_tries_duplicate_pattern_data_with_undo_and_a_before_after_probe(self):
        self.start()
        self.fl.pattern = 2
        self.fl.pattern_len_steps = 16
        self.fl.channels[0]["grid"].update([0, 4])
        calls = []
        patterns_module = self.script.patterns
        patterns_module.duplicatePatternData = lambda n: calls.append(n)
        try:
            s = self.script
            self.send(s.frame(0x63, s.enc_u7(2) + s.enc_u7(1)))
            frames = self.done()
        finally:
            del patterns_module.duplicatePatternData
        self.assertEqual(calls, [2])
        self.assertTrue(any(c[0] == "general.saveUndo" for c in self.fl.calls))
        line = [p for p in self.probes(frames) if p.startswith("duplicatePatternData(2)")]
        self.assertEqual(len(line), 1)
        self.assertIn("before count", line[0])
        self.assertIn("0:x...x", line[0])
        self.assertEqual(self.fl.called("patterns.setPatternLength"), [])  # the step copy did not run

    def test_double_uses_duplicate_pattern_data_then_sets_twice_the_length(self):
        self.start()
        self.fl.pattern = 1
        self.fl.pattern_len_steps = 16
        calls = []
        patterns_module = self.script.patterns
        patterns_module.duplicatePatternData = lambda n: calls.append(n)
        try:
            self.double(1)
            frames = self.done()
        finally:
            del patterns_module.duplicatePatternData
        self.assertEqual(calls, [1])
        self.assertEqual(self.fl.called("patterns.setPatternLength"), [(1, 32)])
        self.assertEqual(self.fl.called("channels.setGridBit"), [])  # no step copy
        self.assertTrue(any("(duplicatePatternData)" in p for p in self.probes(frames)))

    def test_doubles_the_length_and_copies_the_steps_of_every_channel(self):
        self.start()
        self.fl.pattern_len_steps = 16
        self.fl.channels[0]["grid"].update([0, 4, 15])
        self.fl.channels[7]["grid"].update([2, 3])
        self.fl.channels[23]["grid"].update([9, 20])  # past the old length: not ours, left alone
        self.double()
        self.drain()
        self.assertEqual(self.fl.pattern_len_steps, 32)
        self.assertEqual(self.fl.channels[0]["grid"], set([0, 4, 15, 16, 20, 31]))
        self.assertEqual(self.fl.channels[7]["grid"], set([2, 3, 18, 19]))
        self.assertEqual(self.fl.channels[23]["grid"], set([9, 25]))  # step 20 was a stale bit: now off

    def test_copies_the_step_parameters_of_the_steps_that_are_on(self):
        self.start()
        self.fl.pattern_len_steps = 16
        self.fl.channels[2]["grid"].update([1, 5])
        for param in range(8):
            self.fl.step_params[(2, 1, param)] = 10 + param
            self.fl.step_params[(2, 5, param)] = 50 + param
        self.double()
        self.drain()
        for param in range(8):
            self.assertEqual(self.fl.step_params[(2, 17, param)], 10 + param)
            self.assertEqual(self.fl.step_params[(2, 21, param)], 50 + param)
        self.assertNotIn((2, 18, 0), self.fl.step_params)  # no step, no parameters
        pattern_args = set(args[1] for args in self.fl.called("channels.setStepParameterByIndex"))
        self.assertEqual(pattern_args, set([1]))

    def test_a_failing_or_missing_step_parameter_function_still_copies_the_grid(self):
        self.start()
        self.fl.pattern_len_steps = 16
        self.fl.channels[0]["grid"].add(3)
        self.fl.raise_on["channels.setStepParameterByIndex"] = RuntimeError("boom")
        self.double()
        self.drain()
        self.assertEqual(self.fl.channels[0]["grid"], set([3, 19]))
        self.assertEqual(self.fl.pattern_len_steps, 32)

        self.fl.raise_on.clear()
        self.fl.pattern_len_steps = 16
        delattr(self.script.channels, "setStepParameterByIndex")
        self.fl.channels[1]["grid"].add(2)
        self.double()
        self.drain()
        self.assertEqual(self.fl.channels[1]["grid"], set([2, 18]))

    def test_one_undo_point_before_the_first_change(self):
        self.start()
        self.fl.channels[0]["grid"].add(1)
        self.fl.calls[:] = []
        self.double()
        self.drain()
        names = [n for (n, _) in self.fl.calls]
        self.assertEqual(names.count("general.saveUndo"), 1)
        self.assertEqual(self.fl.called("general.saveUndo"), [("MK3: double pattern", self.script.midi.UF_PR)])
        self.assertLess(names.index("general.saveUndo"), names.index("patterns.setPatternLength"))
        self.assertLess(names.index("patterns.setPatternLength"), names.index("channels.setGridBit"))
        self.assertEqual(self.fl.undo_names, ["MK3: double pattern"])

    def test_the_grid_is_sent_once_when_it_is_over_and_the_probe_reads_back(self):
        self.start()
        self.fl.channels[0]["grid"].update([0, 1])
        self.fl.channels[1]["grid"].update([2])
        script = self.script
        # FL calls back into the script while steps change
        self.fl.on_set_grid_bit = lambda *args: (
            script.OnRefresh(script.midi.HW_Dirty_ChannelRack),
            script.OnIdle(),
        )
        self.double()
        frames = []
        for _ in range(60):
            self.clock.advance(0.2)  # the 100 ms re-read is due on every pass
            self.script.OnIdle()
            frames.extend(self.take())
            if self.bridge.double_job is None and not self.bridge.dirty:
                break
        self.assertEqual(len(self.grids(frames)), 1)
        self.assertEqual(self.probes(frames), ["doublePattern(1) 16 -> 32, channels 2"])

    def test_it_is_paced_a_few_channels_per_service_pass(self):
        self.start()
        for channel in self.fl.channels:
            channel["grid"].add(0)
        self.double()
        self.assertIsNotNone(self.bridge.double_job)
        passes = 0
        while self.bridge.double_job is not None:
            before = len(self.fl.called("channels.setGridBit"))
            self.script.OnIdle()
            touched = len(self.fl.called("channels.setGridBit")) - before
            self.assertLessEqual(touched, self.script.DOUBLE_CHANNELS_PER_PASS)
            passes += 1
            self.assertLess(passes, 100)
        self.assertGreaterEqual(passes, 24 // self.script.DOUBLE_CHANNELS_PER_PASS - 1)  # one ran in OnSysEx
        self.assertTrue(all(16 in c["grid"] for c in self.fl.channels))

    def test_at_the_cap_nothing_happens(self):
        self.start()
        self.fl.pattern_len_steps = 512
        self.fl.calls[:] = []
        self.double()
        frames = self.done()
        self.assertEqual(self.fl.called("patterns.setPatternLength"), [])
        self.assertEqual(self.fl.called("general.saveUndo"), [])
        self.assertEqual(self.probes(frames), ["doublePattern(1) 512 -> skipped (at most 512 steps)"])
        self.fl.pattern_len_steps = 256
        self.double()
        self.drain()
        self.assertEqual(self.fl.pattern_len_steps, 512)

    def test_only_the_current_pattern_and_never_two_at_once(self):
        self.start()
        self.fl.calls[:] = []
        self.double(pattern=2)  # the current one is 1
        self.double(pattern=99)
        self.assertEqual(self.fl.called("patterns.setPatternLength"), [])
        self.double()
        self.fl.pattern_len_steps = 16
        self.double()  # one is running
        self.assertEqual(len(self.fl.called("patterns.setPatternLength")), 1)

    def test_missing_setter_and_errors_are_caught(self):
        self.start()
        self.fl.raise_on["patterns.setPatternLength"] = RuntimeError("boom")
        self.double()
        self.assertIsNone(self.bridge.double_job)
        self.assertEqual(self.probes(self.done()), ["doublePattern(1) 16 -> error: boom"])
        self.fl.raise_on.clear()
        delattr(self.script.patterns, "setPatternLength")
        self.double()
        self.assertIsNone(self.bridge.double_job)
        self.fl.raise_on["channels.getGridBit"] = RuntimeError("boom")
        self.assertTrue(self.drain() is not None)

    # -- CREATE_PATTERN -----------------------------------------------------------------------

    def create(self, number):
        s = self.script
        self.send(s.frame(0x64, s.enc_u14(number)))

    def test_create_vector(self):
        self.start()
        self.assertTrue(self.send(self.vector("createPattern")).handled)

    def test_an_empty_pad_creates_the_pattern_with_jump_to_pattern(self):
        self.start()
        self.fl.calls[:] = []
        self.create(7)
        self.assertEqual(self.fl.called("patterns.jumpToPattern"), [(7,)])
        self.assertEqual(self.fl.called("patterns.findFirstNextEmptyPat"), [])
        self.assertEqual(self.fl.pattern, 7)
        self.assertEqual(self.fl.pattern_count, 7)
        self.assertEqual(
            self.probes(self.done()),
            ["createPattern(7): jumpToPattern -> patternNumber 7, patternCount 5 -> 7"],
        )

    def test_it_falls_back_to_the_first_empty_pattern_and_says_which_it_got(self):
        self.start()
        self.fl.jump_creates = False
        self.create(7)
        self.assertEqual(
            self.fl.called("patterns.findFirstNextEmptyPat"), [(self.script.midi.FFNEP_DontPromptName,)]
        )
        self.assertEqual(self.fl.pattern, 6)
        self.assertEqual(
            self.probes(self.done()),
            [
                "createPattern(7): jump left 1; findFirstNextEmptyPat -> pattern 6, count 5 -> 6"
            ],
        )

    def test_existing_and_absurd_numbers_create_nothing(self):
        self.start()
        self.fl.calls[:] = []
        self.create(3)  # exists
        self.create(5)  # exists
        self.create(5000)
        self.create(0)
        self.assertEqual(self.fl.called("patterns.jumpToPattern"), [])
        self.assertEqual(self.fl.called("patterns.findFirstNextEmptyPat"), [])

    def test_create_is_caught(self):
        self.start()
        self.fl.raise_on["patterns.jumpToPattern"] = RuntimeError("boom")
        self.fl.raise_on["patterns.findFirstNextEmptyPat"] = RuntimeError("boom")
        self.assertTrue(self.send(self.script.frame(0x64, self.script.enc_u14(9))).handled)


class TouchStripTests(BridgeTestCase):
    """STRIP (65): the touch strip's pitch, mod and perform values for the selected channel."""

    def strip(self, kind, value, release=False):
        s = self.script
        code = {"pitch": 0, "mod": 1, "perform": 2}[kind]
        event = self.send(s.frame(0x65, bytes([code]) + s.enc_u14(value) + bytes([1 if release else 0])))
        self.assertTrue(event.handled)

    def make_vst(self, channel, names=None, count=4240):
        """A plugin with `count` parameters, `names` = {index: name}, the rest unnamed."""
        names = names or {}
        self.fl.channels[channel]["plugin"]["name"] = "Diva"
        self.fl.channels[channel]["plugin"]["params"] = [
            dict(name=names.get(p, ""), value=0.25 if p in names else 0.0, text="") for p in range(count)
        ]

    def param(self, channel, index):
        return self.fl.channels[channel]["plugin"]["params"][index]["value"]

    def done(self):
        self.drain()
        return self.take()

    def probes(self, frames):
        return [bytes(f[5:-2]).decode("ascii") for f in self.frames_with(frames, 0x17)]

    def pitches(self):
        return [(a[0], round(a[1], 4), a[2]) for a in self.fl.called("channels.setChannelPitch")]

    def test_vector_decodes(self):
        self.start()
        msg = self.script.decode(self.vector("stripPitch"))
        self.assertEqual(msg, {"type": "strip", "kind": "pitch", "value": 12000, "release": False})
        msg = self.script.decode(self.vector("stripModRelease"))
        self.assertEqual(msg, {"type": "strip", "kind": "mod", "value": 64, "release": True})
        self.assertIsNone(self.script.decode(self.script.frame(0x65, bytes([9, 0, 0, 0]))))

    def vector(self, name):
        for v in load_vectors():
            if v["name"] == name:
                return bytes.fromhex(v["hex"])
        raise KeyError(name)

    def test_pitch_is_the_channel_pitch_as_a_factor_of_the_range(self):
        self.start()
        self.fl.calls[:] = []
        self.strip("pitch", 16383)
        self.strip("pitch", 8192)
        self.strip("pitch", 0)
        self.strip("pitch", 12288)
        self.assertEqual(self.pitches(), [(0, 0.9999, 0), (0, 0.0, 0), (0, -1.0, 0), (0, 0.5, 0)])

    def test_pitch_release_resets_to_zero_and_works_on_the_channel_the_touch_started_on(self):
        self.start()
        self.strip("pitch", 16383)
        self.fl.calls[:] = []
        self.strip("pitch", 16383, release=True)
        self.assertEqual(self.pitches(), [(0, 0.0, 0)])
        # The channel changes under the finger: the next value resets the old channel first.
        self.strip("pitch", 16383)
        self.fl.channels[0]["selected"] = False
        self.fl.channels[3]["selected"] = True
        self.fl.calls[:] = []
        self.strip("pitch", 16383, release=True)
        self.assertEqual(self.pitches(), [(0, 0.0, 0)])

    def test_mod_sets_the_cc_1_parameter_of_a_vst(self):
        self.start()
        self.make_vst(0)
        self.fl.calls[:] = []
        self.strip("mod", 127)
        self.assertEqual(self.fl.called("plugins.setParamValue"), [(1.0, 4097, 0)])
        self.strip("mod", 64, release=True)
        self.assertAlmostEqual(self.param(0, 4097), 64 / 127.0, delta=0.0001)

    def test_mod_does_nothing_for_a_plugin_without_cc_parameters(self):
        self.start()
        self.fl.calls[:] = []
        self.strip("mod", 100)  # 300 parameters: mk3d sends the raw CC 1 instead
        self.assertEqual(self.fl.called("plugins.setParamValue"), [])
        self.assertEqual(self.fl.called("channels.setChannelPitch"), [])

    def test_raw_cc_1_and_pitch_bend_still_go_on_to_fl(self):
        for callback, event in (
            (self.script.OnControlChange, Event(midiChan=0, data1=1, data2=64)),
            (self.script.OnPitchBend, Event(midiChan=0, data1=0, data2=64)),
        ):
            event.handled = True
            callback(event)
            self.assertFalse(event.handled)

    def read_names(self):
        self.settle()
        self.assertTrue(self.bridge.scan["done"])

    def test_perform_finds_the_diva_cutoff_logs_it_and_restores(self):
        self.start()
        self.make_vst(0, {10: "VCF1: Resonance", 11: "VCF1: Frequency", 12: "VCF2: Frequency", 50: "Volume"})
        self.read_names()
        self.fl.calls[:] = []
        self.take()
        self.strip("perform", 16383)
        self.assertEqual(self.param(0, 11), 1.0)
        self.strip("perform", 8192)
        self.assertAlmostEqual(self.param(0, 11), 8192 / 16383.0, delta=0.0001)
        self.strip("perform", 0, release=True)
        self.assertEqual(self.param(0, 11), 0.25)  # what it was at the first value
        self.assertEqual(self.fl.rec_writes, [])  # the channel cutoff was not touched
        self.assertIn('perform: Diva -> param 11 "VCF1: Frequency"', self.probes(self.done()))
        # The choice is cached: the next touch does not log again.
        self.strip("perform", 100)
        self.strip("perform", 0, release=True)
        self.assertEqual([p for p in self.probes(self.done()) if p.startswith("perform")], [])

    def test_perform_prefers_the_first_match_and_knows_a_cutoff_name(self):
        self.start()
        self.make_vst(0, {7: "Osc Frequency", 20: "Filter Cutoff", 21: "Filter Freq"})
        self.read_names()
        self.take()
        self.strip("perform", 16383)
        self.strip("perform", 0, release=True)
        self.assertIn('perform: Diva -> param 20 "Filter Cutoff"', self.probes(self.done()))
        self.assertEqual(self.param(0, 7), 0.25)

    def test_perform_without_a_filter_parameter_uses_the_channel_cutoff(self):
        self.start()
        self.make_vst(0, {7: "Osc Frequency", 8: "Volume"})  # frequency, but no filter word
        self.read_names()
        self.take()
        self.fl.channels[0]["cutoff"] = 0.4
        self.strip("perform", 16383)
        base = 0x10000 * 1
        self.assertEqual(self.fl.rec_writes[0][0], base + self.script.midi.REC_Chan_FCut)
        self.assertEqual(self.fl.rec_writes[0][1], self.script.REC_VALUE_MAX)
        self.strip("perform", 0, release=True)
        self.assertAlmostEqual(self.fl.rec_writes[-1][1] / float(self.script.REC_VALUE_MAX), 0.4, delta=0.0001)
        self.assertEqual(self.param(0, 7), 0.25)
        self.assertIn("perform: Diva -> channel cutoff", self.probes(self.done()))

    def test_perform_remembers_only_the_first_value_of_a_touch(self):
        self.start()
        self.make_vst(0, {3: "Cutoff"})
        self.read_names()
        self.strip("perform", 16383)
        self.strip("perform", 0)  # the second value must not become the "before"
        self.strip("perform", 0, release=True)
        self.assertEqual(self.param(0, 3), 0.25)
        self.strip("perform", 0, release=True)  # a second release has nothing to give back
        self.assertEqual(self.param(0, 3), 0.25)

    def test_perform_gives_the_old_channel_its_value_back_when_the_channel_changes(self):
        self.start()
        self.make_vst(0, {3: "Cutoff"})
        self.read_names()
        self.strip("perform", 16383)
        self.assertEqual(self.param(0, 3), 1.0)
        self.fl.channels[0]["selected"] = False
        self.fl.channels[1]["selected"] = True
        self.strip("perform", 0, release=True)  # mk3d's release after the channel change
        self.assertEqual(self.param(0, 3), 0.25)

    def test_perform_with_unread_names_sweeps_the_channel_cutoff_this_once(self):
        self.start()
        self.make_vst(0, {3: "Cutoff"})  # the scan has not run for the new plugin yet
        self.strip("perform", 16383)
        self.assertEqual(self.param(0, 3), 0.25)
        self.assertEqual(len(self.fl.rec_writes), 1)
        self.strip("perform", 0, release=True)

    def test_deinit_gives_the_value_back(self):
        self.start()
        self.make_vst(0, {3: "Cutoff"})
        self.read_names()
        self.strip("perform", 16383)
        self.script.OnDeInit()
        self.assertEqual(self.param(0, 3), 0.25)


if __name__ == "__main__":
    unittest.main()


class PerformScoreTests(BridgeTestCase):
    """The PERFORM cutoff choice (owner's Diva picked "CutoffSlop" by substring, 2026-10-18)."""

    def test_diva_names_choose_the_vcf_frequency(self):
        bridge = self.script

        names = ["CutoffSlop", "VCF1: FreqModDepth", "VCF1: FreqMod2Depth", "VCF1: KeyFollow", "VCF1: Frequency"]
        scores = [bridge.perform_score(n) for n in names]
        self.assertEqual(max(range(len(names)), key=lambda i: scores[i]), 4)
        self.assertEqual(bridge.perform_score("CutoffSlop"), 0)

    def test_plain_cutoff_and_second_filters(self):
        bridge = self.script

        self.assertGreater(bridge.perform_score("Cutoff"), 0)
        self.assertGreater(bridge.perform_score("Filter Cutoff"), bridge.perform_score("Filter 2 Cutoff"))
        self.assertEqual(bridge.perform_score("Volume"), 0)


class PluginLoaderTrialTests(BridgeTestCase):
    """BROWSE (67), UI_KEY (68), PICKER (69) and BROWSER_NODE (1E): the plug-in loader trial."""

    def vector(self, name):
        for v in load_vectors():
            if v["name"] == name:
                return bytes.fromhex(v["hex"])
        raise KeyError(name)

    def probes(self, frames):
        return [bytes(f[5:-2]).decode("ascii") for f in self.frames_with(frames, 0x17)]

    def run_command(self, code, *payload):
        """Send the command, drain, and return (frames, FL calls of the trial functions)."""
        self.start()
        self.fl.calls[:] = []
        self.send(self.script.frame(code, bytes(payload)))
        frames = self.take()
        self.drain()
        frames += self.take()
        return frames

    def node(self, frames):
        found = self.frames_with(frames, 0x1E)
        self.assertEqual(len(found), 1)
        return found[0]

    ACTIONS = (
        "ui.showWindow",
        "ui.setFocused",
        "transport.globalTransport",
        "ui.navigateBrowser",
        "ui.toggleBrowserNode",
        "ui.selectBrowserMenuItem",
        "ui.previewBrowserMenuItem",
        "ui.closeActivePopupMenu",
        "ui.up",
        "ui.down",
        "ui.left",
        "ui.right",
        "ui.enter",
        "ui.escape",
        "ui.showPicker",
    )

    def acted(self):
        return [(n, a) for (n, a) in self.fl.calls if n in self.ACTIONS]

    def test_vectors_decode_and_run(self):
        self.start()
        self.fl.calls[:] = []
        self.assertTrue(self.send(self.vector("browse")).handled)
        self.assertTrue(self.send(self.vector("uiKey")).handled)
        self.assertTrue(self.send(self.vector("picker")).handled)
        self.assertEqual(
            self.acted(),
            [("ui.setFocused", (4,)), ("ui.navigateBrowser", (41, False)), ("ui.enter", ()), ("ui.showPicker", (1, 2))],
        )

    def test_browser_node_matches_the_vector_encoding(self):
        v = [v for v in load_vectors() if v["name"] == "browserNode"][0]
        m = v["message"]
        self.assertEqual(self.script.encode(m).hex(), v["hex"])

    def test_browse_show_shows_and_focuses_the_browser(self):
        self.run_command(0x67, 0)
        self.assertEqual(self.acted(), [("ui.showWindow", (4,)), ("ui.setFocused", (4,))])

    def test_each_browse_action_calls_exactly_one_function(self):
        # next / prev focus the browser first (round 2, the owner's try 2026-10-19)
        expected = {
            1: [("ui.setFocused", (4,)), ("ui.navigateBrowser", (41, False))],
            2: [("ui.setFocused", (4,)), ("ui.navigateBrowser", (40, False))],
            3: [("ui.toggleBrowserNode", (-1,))],
            4: [("ui.selectBrowserMenuItem", ())],
            5: [("ui.previewBrowserMenuItem", ())],
            6: [("ui.setFocused", (4,)), ("ui.enter", ())],  # load: FL sends the item to the selected channel
            7: [("ui.setFocused", (4,)), ("transport.globalTransport", (91, 1))],  # the item's own menu
            8: [("transport.globalTransport", (67, 1))],  # F8: FL's Plugin picker
        }
        for action, calls in expected.items():
            with self.subTest(action=action):
                self.setUp()
                self.run_command(0x67, action)
                self.assertEqual(self.acted(), calls)

    def test_each_ui_key_calls_the_matching_function(self):
        names = ["up", "down", "left", "right", "enter", "escape", "closeActivePopupMenu"]
        for key, name in enumerate(names):
            with self.subTest(key=key):
                self.setUp()
                self.run_command(0x68, key)
                self.assertEqual(self.acted(), [("ui." + name, ())])

    def test_picker_with_one_or_two_arguments(self):
        self.run_command(0x69, 1, 63)  # mode -1: left out
        self.assertEqual(self.acted(), [("ui.showPicker", (1,))])
        self.setUp()
        self.run_command(0x69, 0, 64 + 3)
        self.assertEqual(self.acted(), [("ui.showPicker", (0, 3))])

    def test_unknown_action_or_key_is_ignored(self):
        self.run_command(0x67, 9)
        self.run_command(0x68, 9)
        self.assertEqual(self.acted(), [])

    def test_answer_is_browser_node_and_a_probe_line_after_a_service_pass(self):
        self.start()
        self.send(self.script.frame(0x67, bytes([1])))  # OnSysEx serviced once already
        self.fl.in_popup = True
        frames = self.take()
        self.assertEqual(self.frames_with(frames, 0x1E), [])  # FL has not had a pass to update yet
        self.script.OnIdle()
        frames = self.take()
        node = self.node(frames)
        text = bytes(node[5:-1])
        self.assertTrue(text.startswith(b"Diva\x00"))
        flags = text[len(b"Diva\x00") + 2]
        self.assertEqual(flags, 0x03)  # popup; next focused the browser first
        self.assertEqual(
            self.probes(frames),
            ['browse(next) returned "Diva" -> "Diva" type -1 popup 1 form "Browser" id -1 hint "Plugin database"'],
        )

    def test_folder_type_and_flags(self):
        self.fl.node_type = -120
        self.fl.focused_widget = 4
        frames = self.run_command(0x67, 3)
        text = bytes(self.node(frames)[5:-1])
        at = len(b"Diva\x00")
        self.assertEqual((text[at] << 7 | text[at + 1]) - 8192, -120)
        self.assertEqual(text[at + 2], 0x02)  # browser focused

    def test_other_form_focused_flag(self):
        self.fl.form_caption = "Plugin picker"
        self.fl.focused_widget = 0
        frames = self.run_command(0x68, 4)  # enter
        text = bytes(self.node(frames)[5:-1])
        self.assertEqual(text[len(b"Diva\x00") + 2], 0x04)

    def test_arrow_keys_get_no_answer_but_enter_and_the_plugin_picker_do(self):
        for key in (0, 1, 2, 3):
            self.setUp()
            self.assertEqual(self.frames_with(self.run_command(0x68, key), 0x1E), [])
        self.setUp()
        self.assertEqual(len(self.frames_with(self.run_command(0x68, 4), 0x1E)), 1)
        self.setUp()
        self.assertEqual(len(self.frames_with(self.run_command(0x67, 8), 0x1E)), 1)

    def test_strings_are_cut_to_forty_characters(self):
        self.fl.node_caption = "x" * 60
        self.fl.hint = "h" * 60
        frames = self.run_command(0x67, 1)
        text = bytes(self.node(frames)[5:-1])
        self.assertTrue(text.startswith(b"x" * 40 + b"\x00"))
        self.assertTrue(text.endswith(b"h" * 40 + b"\x00"))

    def test_missing_functions_go_into_features_and_the_probe_says_missing(self):
        delattr(self.script.ui, "navigateBrowser")
        delattr(self.script.ui, "getHintMsg")
        frames = self.start()
        self.assertEqual(self.frames_with(frames, 0x1D), [bytes.fromhex("f07d4d331d04f7")])
        self.fl.calls[:] = []
        self.send(self.script.frame(0x67, bytes([1])))
        self.drain()
        frames = self.take()
        self.assertEqual(self.acted(), [("ui.setFocused", (4,))])
        probe = self.probes(frames)
        self.assertIn("browse(next) -> missing: ui.navigateBrowser, ui.getHintMsg; ", "".join(probe))
        self.assertEqual(len(self.frames_with(frames, 0x1E)), 1)

    def test_missing_picker_goes_into_features(self):
        delattr(self.script.ui, "showPicker")
        frames = self.start()
        self.assertEqual(self.frames_with(frames, 0x1D), [bytes.fromhex("f07d4d331d08f7")])
        self.send(self.script.frame(0x69, bytes([1, 63])))
        self.drain()
        self.assertIn("picker(1) -> missing: ui.showPicker; ", "".join(self.probes(self.take())))

    def test_exceptions_never_escape(self):
        cases = (
            (0x67, bytes([1]), "ui.navigateBrowser"),
            (0x69, bytes([1, 63]), "ui.showPicker"),
            (0x68, bytes([4]), "ui.enter"),
            (0x67, bytes([1]), "ui.getFocusedNodeCaption"),
            (0x67, bytes([1]), "ui.isInPopupMenu"),
        )
        for code, payload, name in cases:
            with self.subTest(name=name):
                self.setUp()
                self.start()
                self.fl.raise_on[name] = RuntimeError("boom")
                event = self.send(self.script.frame(code, payload))
                self.assertTrue(event.handled)
                self.drain()
                frames = self.take()
                self.assertIn("error " + name + ": boom", "".join(self.probes(frames)))
                self.assertEqual(len(self.frames_with(frames, 0x1E)), 1)

    def test_every_command_is_answered(self):
        self.start()
        for code, payload in ((0x67, 1), (0x68, 4), (0x69, 1)):
            self.take()
            self.send(self.script.frame(code, bytes([payload, 63]) if code == 0x69 else bytes([payload])))
            self.drain()
            self.assertEqual(len(self.frames_with(self.take(), 0x1E)), 1)
