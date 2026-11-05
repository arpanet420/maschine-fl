# FL Studio 2026's hidden Python API (`ilmcp` and undocumented functions)

**A research log from 2026-10-18 and 19.** The probe (`MK3D_PROBE`, RUN_PROBE, `_ilmcp`), the browser trial (BROWSE,
PICKER, BROWSER_NODE) and the setters' read-back PROBE lines were removed on 2026-11-05
([review-2026-11-05.md](review-2026-11-05.md)); they are in git history. The findings stand. What the script uses today
and how far each call has been checked is in [fl-api-notes.md](fl-api-notes.md).

Found while looking for a way to put a new instrument on an empty pad (`PLAN.md`, the owner's idea list). "Hidden" meant
not in the stubs. On 2026-11-05 FL's [online manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/midi_scripting.htm)
turned out to document most of it; the table below says which. What's still undocumented may change or go in any FL
update, so it stays behind `getattr` and try/except.

## How it was found (repeatable)

- Source: `/Applications/FL Studio 2026.app/Contents/Libs/FLEngine_x64.dylib` (universal; the x86_64
  slice was analysed: `lipo -thin x86_64`).
- Every `PyMethodDef` table in the `__DATA` segments was located (32-byte entries: name, C function,
  flags, doc) and tied to its `PyModuleDef` (module name at +0x28, methods at +0x40). The function
  names were then diffed against the stubs in `reference/FL-Studio-API-Stubs`.
- REA (Ghidra) decompiled the interesting C functions; argument formats are the `PyArg_ParseTuple`
  strings they use (extracted from `objdump`; treat the formats in the tables below as likely, not
  certain).

## Modules FL registers

Documented (stubs): `playlist`, `channels`, `mixer`, `patterns`, `transport`, `general`, `ui`,
`device`, `arrangement`, `launchMapPages`, `screen`, `plugins`. Undocumented: **`ilmcp`** (no
docstrings; probably "Image-Line MCP", FL's AI/assistant hooks) and the piano roll script API
(`flpianoroll`: score `getNote/addNote/deleteNote/…`, chord markers, the script dialog).

## `ilmcp`

| Function | Args | What the decompiled code does |
|---|---|---|
| `getBrowserNames(path, fullRecursive)` | `sp` | Walks FL's browser tree by a `/`-separated path (empty = root) and returns a **list of names**. Errors: "Could not find browser tree node with name …"; a recursive listing of the root is refused. |
| `addChannel(name)` | `\|s` | Looks `name` up as a **plugin** (plugin database folder first, then FL's plugin list, preferring one format) and **adds a channel** with it, like dropping it on the channel rack. |
| `removeChannel(index)` | `i` (likely) | Removes a channel. |
| `addEffect(name, track, slot)` | `sii` | **Inserts effect plugin** `name` into mixer `track`, `slot` (undo: "insert effect plugin"; also "remove effect plugin"). |
| `runPRScript(code)` | `s` | Writes `code` to `tempscript.PYSCRIPT`, **opens the piano roll if needed and runs the code as a piano roll script** (FL's documented `flpianoroll` API: read, add, delete notes and markers). Returns what the run returns. |
| `storePRScript(name, code)` | `ss` | Saves `code` as `<name>.PYSCRIPT` in the user's piano roll scripts folder (it then shows in the piano roll's Scripts menu). |
| `getHighlightNames()`, `showHighlight(…)`, `forwardTutorialEvent(…)` | | Tutorial UI highlights; not needed. |

## Hidden functions in the documented modules

The stubs don't have these. The numbers are the API version the manual gives.

| Module | In the manual now | Still undocumented (likely arguments) |
|---|---|---|
| `patterns` | `setPatternLength`, `incrementPatternLength`, `movePattern` (39), `clearPattern` (44), `duplicatePatternData` (45) | `setLoopStarterRootNote` |
| `channels` | `rerollLoopStarterLoop` (39) | `getSwing()` / `setSwing(f)` (channel swing), `fillEachNSteps(channel, n, …)`, `rerollLoopStarterSteps`, `rerollLoopStarterSample` |
| `mixer` | `getPluginMixLevel`, `setPluginMixLevel` (37), `setCurrentTempo`, `getTrackCount` (38) | `getPluginMuteState`, `setPluginMuteState(track, slot, …)` (FX slot bypass) |
| `arrangement` | | `selectionSet(start, end)`, `selectionClear()`, `selectionIsActive()` (the playlist time selection = the song loop range) |
| `general` | `setNumerator`, `setDenominator`, `setRecPPQ`, `getProjectTitle`, `getProjectAuthor`, `getProjectGenre` (38) | |
| `playlist` | `selectTool` (40) | |
| `ui` | `showPicker(mode, category)` (41): mode 0 the Plugin picker, 1 the Project picker | |
| `device` | | `flrMidiNote(…)`, `flrMidiCC(…)`, `releaseCC` |

## What it could unlock (ideas, in rough order of value)

1. **Real notes on the screens and editing them** (`runPRScript`): a piano roll script reads the
   selected channel's notes in the current pattern, including notes drawn in the piano roll, and can
   add, move, delete, quantize and transpose them. That makes Maschine's EVENTS page, a real note
   view in ARRANGER and recording-to-pattern edits possible. Out of reach: see the probe results.
2. **New instrument on an empty pad / plug-in loader** (`getBrowserNames` + `addChannel`, out of reach; the Plugin
   picker does it, below). `get/setPluginMixLevel` + `setPluginMuteState` could give FX slot mix knobs and bypass
   buttons on the Mixer page.
3. **Pattern length and clear** (`setPatternLength` and `duplicatePatternData` **built**, `clearPattern`,
   `movePattern`): pattern length on the PATTERN overlay's knob 4, double (SHIFT + DUPLICATE) as real data copies,
   pattern clear via ERASE, reordering patterns.
4. **Song loop range** (`arrangement.selectionSet`, **built**): Maschine's loop page (SHIFT + RESTART held),
   and SCENE could loop the section between two markers.
5. **Per-channel swing** (`channels.setSwing`) for the SWING quick edit with a pad held;
   **time signature** (`setNumerator/Denominator`) in SETTINGS or a project page.
6. **Project title** on the home screen / FILE page.

## Probe results (2026-10-18, owner's FL 2026)

- **The hidden functions in the documented modules work from our controller script:**
  `channels.getSwing() = 0.0`, `general.getProjectTitle() = ''`, `arrangement.selectionIsActive() =
  0`, `mixer.getPluginMixLevel(1, 0) = 1.0`. So `setPatternLength`, `clearPattern`,
  `duplicatePatternData`, `movePattern`, `selectionSet`, `setSwing`, `setNumerator`, FX slot mix and
  bypass are very likely usable too (setters still to be tried once each).
- **`import ilmcp` fails in a controller script.** Why (REA): the module is created only by
  `TMCPPythonSession` (unit `MCPServer`), the Python session of FL's MCP server. That server serves
  **Gopher**, FL's AI assistant: its tools are `System/Tools/MCP/MCPTools.pyc` in the app bundle
  (66 functions: `add_channel` → `ilmcp.addChannel(plugin)`, `get_browser_names` →
  `ilmcp.getBrowserNames(path, fullRecursive)`, `add_effect` → `ilmcp.addEffect(plugin, track,
  slot)`, `remove_channels` → `ilmcp.removeChannel(index)`, `run_piano_roll_script` →
  `ilmcp.runPRScript(source)`, `save_piano_roll_script` → `ilmcp.storePRScript(name, source)`, plus
  ordinary-API tools). Gopher's web panel calls them over a JavaScript bridge (`flHelper.onRunJson`,
  `onMCPTools`); no network port was found, so mk3d cannot connect from outside.
- **After using Gopher once (2026-10-18): still `ModuleNotFoundError("No module named 'ilmcp'")`.**
  The controller script's `sys.modules` holds only the stdlib basics and FL's documented modules
  (`arrangement channels device general launchMapPages midi mixer patterns playlist plugins screen
  transport ui`), so Gopher's sessions run apart from controller scripts. **Conclusion: `ilmcp`
  (adding channels and effects, the browser tree, piano roll scripts) is out of reach for mk3d.**
  What remains usable is the hidden functions of the documented modules (table above).

## What came of it

- **`patterns.setPatternLength`**: PATTERN's knob 4 `LENGTH` and DOUBLE. The owner's try on 2026-10-18 showed the unit is
  steps (`setPatternLength(2, 33)` reads back 33), though the manual says beats.
- **`patterns.duplicatePatternData`**: DOUBLE (SHIFT + DUPLICATE). `getGridBit` reads recorded notes but `setGridBit`
  doesn't write them, so copying steps left the second half empty. This function copies every note, piano roll notes
  too, and leaves the length at what the content spans.
- **`patterns.jumpToPattern`** creates a missing pattern: an empty pad while PATTERN is held.
- **`arrangement.selectionSet`, `selectionClear`, `selectionIsActive`**: the song loop, SHIFT + RESTART.
- **`patterns.setPatternColor`** is documented: PATTERN's knob 1 `COLOR`.
- A function missing in another FL version is reported once in FEATURES; mk3d then shows `Not available in this FL
  version` and sends nothing.
- Still unused: `clearPattern`, `movePattern`, swing, time signature, FX slot mix.

## The plug-in loader: how we got to the Plugin picker

`ilmcp.addChannel` only exists in FL's Gopher assistant sessions and the script API has no "add plug-in" call, so we
tried FL's browser (BROWSE: `ui.navigateBrowser`, `toggleBrowserNode`, `selectBrowserMenuItem`) and the picker
(`ui.showPicker`). The results below are in the order they came. The manual now explains one of the dead ends:
`showPicker(1, …)` is the **Project** picker, which is why it showed patterns and channels. We never tried mode 0.

### Round 1 results (owner, 2026-10-19)

- **Browser:** `getFocusedNodeCaption()` works: it returned `Repro-5.fst` (type 4), the item last used in FL's
  browser. `navigateBrowser(41/40)` and `toggleBrowserNode(-1)` changed nothing, and after `showWindow` +
  `setFocused(widBrowser)` FL still reported no focused window. Round 2: next/prev call `setFocused(widBrowser)`
  first, and the PROBE line logs what `navigateBrowser` returns (`browse(next) returned "…" -> …`).
- **Picker:** `showPicker(1)` opens a form FL calls `PlugList`; `showPicker(0)` seemed to close it. It mostly showed the
  project's patterns and channels (FL's project picker), and once FL's plugins. With it focused, `ui.down/up`
  moved through the project's patterns and channels and **created a pattern (7)** at the end of the list. The hint
  bar showed category names (`Unsorted`, `All`). `getFocusedFormID()` is −1 throughout. Next: SHIFT + display 3
  (`showPicker(1, mode)`, modes 0–3) to find the mode that always shows plugins, then ENTER on a generator.

### Round 2 results (owner, 2026-10-19)

- **Browser navigation works** once `setFocused(widBrowser)` comes first: `navigateBrowser(41/40)` returned
  `AX73.fst`, `chipspeech.fst`, `D-50.fst`, `Diva 2.fst`, … (type 4 = a plugin preset `.fst`; FL's hint said
  `Found 101 files`, a search in the browser).
- **`selectBrowserMenuItem()` opens FL's main File menu** (`New (Empty)`, `New from template`, `Open...`, `Save`),
  not the item's menu, as the stubs warn. `ui.enter()` on its own did nothing (the browser had lost the focus).
- **`showPicker(1, mode)`**: modes 0–3 show the picker panel's All / patterns / channels; no plugins. The picker
  route is dropped. (Our `mode` is the manual's `category`, and our 1 is its Project picker.)
- Round 3: BROWSE action 6 `load` = `setFocused(widBrowser)` + `ui.enter()`. FL's release notes: "Browser's F5/F6
  (or extra mouse buttons, or ENTER or middle click) now sends to the focused plugin (or the selected Channel if
  there's none)". So it **replaces the selected channel's plugin** (Maschine's browser also loads into the focused
  sound); FL's undo takes it back. A *new* channel ("Open in new channel" in the item's right-click menu) has no
  keyboard path found yet.

### Round 3 results and round 4 (owner, 2026-10-19)

- `setFocused(widBrowser)` + `ui.enter()` did not load the item, and loading into the selected channel would
  replace that channel's plugin, which the owner does not want. The owner adds instruments by hand through FL's
  **Plugin picker** (the toolbar's plug button: Generators / Effects with category tabs; picking a generator makes
  a new channel).
- Round 4: BROWSE 8 `pluginPicker` = `transport.globalTransport(midi.FPT_F8 (67), 1)` (F8 opens the Plugin picker),
  on display 3; BROWSE 7 `itemMenu` = `setFocused(widBrowser)` + `globalTransport(midi.FPT_ItemMenu (91), 1)` (the
  focused item's own menu, where "Open in new channel" is), on the 4D push and display 6 `MENU` of PLUG-INS. Menus
  are then walked with the 4D (UI_KEY down / up / enter); FL's hint bar names the highlighted menu entry.

### Result (owner, FL 2026, 2026-10-19)

**The Plugin picker route is the loader.** `transport.globalTransport(midi.FPT_F8, 1)` (BROWSE 8 `pluginPicker`)
opens and closes FL's Plugin picker. With it open, `ui.down/up` move through the plugins, `ui.left/right`
change the category page and `ui.enter()` adds the highlighted plugin as a **new channel**. FL's hint bar and
every getter say nothing about the highlighted plugin, so mk3d cannot show its name; the user looks at FL.
BROWSER's display 2 `PLUG-INS` is exactly this (docs/mapping.md, BROWSER). Dead ends:
the FL browser tree (`navigateBrowser` works, but nothing loads a `.fst` into a new channel;
`selectBrowserMenuItem` and `FPT_ItemMenu` open FL's File menu; Enter replaces the selected channel) and
`ui.showPicker(1, …)` (the Project picker: patterns / channels). The trial code went on 2026-11-05: what stays
is PLUGIN_PICKER and UI_KEY (docs/sysex.md).
