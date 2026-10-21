// One-line descriptions of FL state changes, for the daemon's log.
import type { FlSection, FlState } from "./fl/flState.js";
import { FOCUS_NONE, FOCUS_PLUGIN, PROTOCOL_VERSION, UI_WINDOWS } from "./fl/protocol.js";
import { panText, pct } from "./modes/format.js";

/** The log line for one PROBE message (the playlist probe, docs/sysex.md). */
export const describeProbe = (text: string): string => `← FL probe: ${text}`;

export function describeSection(fl: FlState, section: FlSection): string | undefined {
  if (!fl.connected && section !== "connection") return undefined; // all empty
  switch (section) {
    case "connection":
      return fl.connected
        ? `FL Studio connected (protocol v${fl.version})` +
            (fl.version !== PROTOCOL_VERSION
              ? `. mk3d speaks v${PROTOCOL_VERSION}: reload the script in FL`
              : "")
        : "FL Studio gone, waiting for it";
    case "transport": {
      const s = fl.transport;
      return (
        `transport: ${s.playing ? "playing" : "stopped"}, rec ${s.recording ? "armed" : "off"},` +
        ` metronome ${s.metronome ? "on" : "off"}, count-in ${s.countIn ? "on" : "off"},` +
        ` loop ${s.songMode ? "song" : "pattern"},` +
        ` ${fl.tempo.toFixed(2)} BPM, swing ${pct(fl.swing)}` +
        (fl.mainVolume === undefined ? "" : `, main volume ${pct(fl.mainVolume)}`)
      );
    }
    case "channels": {
      const list = [...fl.channels]
        .sort(([a], [b]) => a - b)
        .map(([i, c]) => `${i + 1} ${c.name}${c.selected ? "*" : ""}${c.muted ? " (muted)" : ""}`);
      return `channels (${fl.channelTotal}): ${list.join(", ")}`;
    }
    case "selectedChannel": {
      const c = fl.selectedChannel;
      if (c.index === null) return "selected channel: none";
      return (
        `selected channel ${c.index + 1} "${c.name}"${c.plugin ? ` (${c.plugin})` : ""},` +
        ` vol ${pct(c.volume)}, pan ${panText(c.pan)}`
      );
    }
    case "channelDetail": {
      const d = fl.channelDetail;
      if (d.index === null) return undefined;
      return (
        `channel ${d.index + 1}: pitch ${(d.pitch * d.pitchRange).toFixed(2)} st,` +
        ` cutoff ${pct(d.cutoff)}, resonance ${pct(d.resonance)}, mixer track ${d.mixerTrack}`
      );
    }
    case "mixer": {
      const list = [...fl.mixer]
        .sort(([a], [b]) => a - b)
        .map(([i, t]) => {
          const flags = [t.muted && "muted", t.solo && "solo", t.armed && "armed"].filter(Boolean);
          return `${i} ${t.name} ${pct(t.volume)}${flags.length ? ` (${flags.join(", ")})` : ""}`;
        });
      return `mixer (${fl.mixerTotal}): ${list.join(", ")}`;
    }
    case "selectedTrack":
      return `selected mixer track ${fl.selectedTrack}`;
    case "uiState": {
      const u = fl.uiState;
      const shown = UI_WINDOWS.filter((_, i) => u.visible[i]).join(", ") || "none";
      const focus =
        u.focused === FOCUS_PLUGIN
          ? "a plugin"
          : (UI_WINDOWS[u.focused] ?? (u.focused === FOCUS_NONE ? "none" : String(u.focused)));
      return `FL windows: ${shown} shown, ${focus} focused, snap ${u.snap}`;
    }
    case "undoState": {
      const u = fl.undoState;
      return `undo history: position ${u.position} of ${u.count}, hint "${u.hint}"`;
    }
    case "pattern": {
      const p = fl.pattern;
      return `pattern ${p.number}/${p.count} "${p.name}", ${p.length} steps`;
    }
    case "patterns": {
      const list = [...fl.patterns]
        .sort(([a], [b]) => a - b)
        .map(([i, p]) => `${i + 1} ${p.name}${p.current ? "*" : ""}`);
      return `patterns (${fl.patternCount}): ${list.join(", ")}`;
    }
    case "stepGrid": {
      const g = fl.stepGrid;
      const steps = [...g.steps]
        .sort(([a], [b]) => a - b)
        .map(([, on]) => (on ? "x" : "."))
        .join("");
      const channel = g.channel === null ? "-" : String(g.channel + 1);
      return `steps (channel ${channel}, pattern ${g.pattern}): ${steps}`;
    }
    case "plugin": {
      const p = fl.plugin;
      return p.valid ? `plugin "${p.name}", ${p.paramCount} params` : "plugin: none";
    }
    case "pluginParams": {
      const list = [...fl.pluginParams.values()]
        .sort((a, b) => a.index - b.index)
        .map((p) => `${p.name}=${p.valueText}`);
      return `params: ${list.join(", ")}`;
    }
    case "paramNames":
      return `param names: ${fl.paramNames.size} of ${fl.plugin.paramCount}`;
    case "presets": {
      const p = fl.presets;
      if (!p || p.count === 0) return "presets: none";
      const now = p.current === null ? "?" : String(p.current + 1);
      return `presets: ${now} of ${p.count}, "${p.names[(p.current ?? p.offset) - p.offset] ?? ""}"`;
    }
    case "markers": {
      const list = [...fl.markers]
        .sort(([a], [b]) => a - b)
        .map(([i, m]) => `${i + 1} ${m.name} @${m.ticks ?? "?"}`);
      return `markers (${fl.markerTotal}, ppq ${fl.ppq}): ${list.join(", ")}`;
    }
    case "loop": {
      const l = fl.loop;
      return l.active ? `song loop: ${l.start}…${l.end} ticks` : "song loop: off";
    }
    case "browserNode": {
      const n = fl.browserNode;
      if (!n) return undefined;
      return `browser node: ${JSON.stringify(n.caption)} type ${n.fileType}${n.popup ? " popup" : ""} form ${JSON.stringify(n.formCaption)}`;
    }
    case "features": {
      const m = fl.missing;
      const list = [
        m.patternLength && "setPatternLength",
        m.loop && "selectionSet",
        m.browser && "ui.navigateBrowser",
        m.picker && "ui.showPicker",
      ].filter(Boolean);
      return list.length > 0 ? `missing in this FL version: ${list.join(", ")}` : undefined;
    }
    case "songPos":
    case "meters":
    case "patternGrid":
    case "activity":
      return undefined; // too frequent to log
    case "liveGrid": {
      const g = fl.liveGrid;
      if (!g) return undefined;
      const rows = [...fl.liveTracks.values()]
        .filter((row) => row.blocks.some((b) => b.status !== 0))
        .map((row) => {
          const badges = `${row.muted ? " muted" : ""}${row.solo ? " solo" : ""}`;
          const blocks = row.blocks.map((b) => b.status).join("");
          return `T${row.track} "${row.name}"${badges} snap ${row.trigSnap} @${row.offset}: ${blocks}`;
        });
      return `live grid: ${g.scanned} tracks, perf ${g.perf ? "on" : "off"}${rows.length ? `; ${rows.join("; ")}` : ""}`;
    }
  }
}
