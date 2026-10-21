# FL Studio 2026's hidden Python API (`ilmcp` and undocumented functions)

Found 2026-10-18 while looking for a way to put a new instrument on an empty pad (PLAN.md, the
owner's idea list). **Everything here is undocumented and NOT VERIFIED in FL** until the probe has
run (below); any FL update may change or drop it. Keep every call behind `getattr`/try-except.

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

| Module | Functions (likely args) |
|---|---|
| `patterns` | **`setPatternLength(pattern, length)`**, `incrementPatternLength(…)`, **`clearPattern([pattern])`**, **`duplicatePatternData(…)`**, **`movePattern(…)`**, `setLoopStarterRootNote` |
| `channels` | **`getSwing()` / `setSwing(f)`** (channel swing), `fillEachNSteps(channel, n, …)`, `rerollLoopStarterLoop/Steps/Sample` (FL's Loop Starter) |
| `mixer` | **`getPluginMixLevel(track, slot)` / `setPluginMixLevel(track, slot, value)`**, **`getPluginMuteState` / `setPluginMuteState(track, slot, …)`** (FX slot mix and bypass), `setCurrentTempo(bpm)`, `getTrackCount` |
| `arrangement` | **`selectionSet(start, end)`, `selectionClear()`, `selectionIsActive()`** (the playlist time selection = the song loop range) |
| `general` | **`setNumerator`, `setDenominator`** (time signature), `setRecPPQ`, `getProjectTitle/Author/Genre` |
| `playlist` | `selectTool(i)` |
| `ui` | `showPicker(i [, i])` |
| `device` | `flrMidiNote(…)`, `flrMidiCC(…)`, `releaseCC` |

## What it could unlock (ideas, in rough order of value)

1. **Real notes on the screens and editing them** (`runPRScript`): a piano roll script reads the
   selected channel's notes in the current pattern, including notes drawn in the piano roll, and can
   add, move, delete, quantize and transpose them. That makes Maschine's EVENTS page, a real note
   view in ARRANGER and recording-to-pattern edits possible. Open question: how the notes get back
   to our script (a shared Python module if piano roll scripts share the interpreter, else a temp
   file); the probe tries both.
2. **New instrument on an empty pad / plug-in loader** (`getBrowserNames` + `addChannel`): browse
   FL's plugin database on the MK3 and load; also SHIFT + BROWSER (Maschine's plug-in loader).
   `addEffect` gives a mixer FX loader; `get/setPluginMixLevel` + `setPluginMuteState` FX slot
   mix knobs and bypass buttons on the Mixer page.
3. **Pattern length and clear** (`setPatternLength` **built**, `clearPattern`, `duplicatePatternData`,
   `movePattern`): pattern length on the PATTERN overlay's knob 4, pattern clear/delete via ERASE,
   double (SHIFT + DUPLICATE) as real data copies, reordering patterns.
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

## What mk3d uses now (2026-10-18, all NOT VERIFIED until the owner has tried them)

- **`patterns.setPatternLength(pattern, length)`**: PATTERN overlay, knob 4 `LENGTH` (SET_PATTERN_LENGTH
  `u7 pattern`, `u14 length`) and display 3 `DOUBLE` (DOUBLE_PATTERN). **Verified in FL 2026 by the owner
  (2026-10-18): the unit is steps**, the log showed `setPatternLength(2, 33) -> getPatternLength(2) = 33`
  (so `STEPS_PER_UNIT = 1`). FL 2026's release notes list the functions as official (26.1: "MIDI scripting:
  setPatternLength, incrementPatternLength and getPatternLength…"), so they are no longer "hidden". The
  script calls `getattr`, sets, reads `getPatternLength` back and sends a PROBE line.
- **DOUBLE (`DOUBLE_PATTERN`)**: `general.saveUndo("MK3: double pattern", UF_PR)` once, `setPatternLength(p, 2L)`
  (at most 512 steps), then for every channel `getGridBit` / `setGridBit` copy steps 0…L−1 to L…2L−1 and the
  step parameters (`channels.getCurrentStepParam` / `setStepParameterByIndex`, params 0–7: pitch, velocity,
  release, fine pitch, pan, mod X, mod Y, shift) of the steps that are on; what fails is skipped. A few channels
  per service pass; the grid goes out once at the end; PROBE `doublePattern(1) 16 -> 32, channels 5`. Notes
  drawn in the piano roll cannot be read by a script and are not doubled (NOT VERIFIED live: the step
  parameter copy, the pacing).
- **CREATE_PATTERN (an empty pad while PATTERN is held)**: `patterns.jumpToPattern(k)` creates a missing pattern
  (stub docs; NOT VERIFIED live). The script reads `patternNumber` back; if FL did not select `k` it falls back to
  `findFirstNextEmptyPat(FFNEP_DontPromptName)`. PROBE `createPattern(7): jumpToPattern -> patternNumber 7,
  patternCount 5 -> 7` or `createPattern(7): jump left 1; findFirstNextEmptyPat -> pattern 6, count 5 -> 6`.
- **`arrangement.selectionSet(start, end)`, `selectionClear()`, `selectionIsActive()`** with the documented
  `selectionStart()` / `selectionEnd()`: the song loop, SHIFT + RESTART (tap = on/off, hold = LOOP
  overlay). Ticks are assumed to be absolute ticks, the unit of MARKERS; the PROBE line after each set
  (`selectionSet(0, 1536) -> active=1 start=0 end=1536`) shows what FL made of it. LOOP_STATE reports
  the range back (read on every service pass) and lights RESTART.
- `patterns.setPatternColor(pattern, color)` is documented, not hidden: PATTERN's knob 1 `COLOR`
  (SET_PATTERN_COLOR); its PROBE line shows the colour byte order FL read back.
- A function missing in another FL version is reported once in FEATURES; mk3d then shows `Not
  available in this FL version` and sends nothing (the script never calls what `getattr` does not find).
- Still unused: `clearPattern`, `duplicatePatternData`, `movePattern`, swing, time signature, FX slot mix.

## Plugin loader trial (2026-10-19, NOT VERIFIED)

`ilmcp.addChannel` only exists in FL's Gopher assistant sessions (the probe could not import it), and the
documented script API has no "add plugin" call, so mk3d tries two undocumented-in-practice routes. Both
are wired as one FL call per command (BROWSE, UI_KEY, PICKER; docs/sysex.md), each answered with
BROWSER_NODE and one PROBE line (`<- FL probe: browse(next) -> "Diva" type -1 popup 0 form "Browser" id 4 hint "..."`).
Try them from the BROWSER page: display 2 `PLUG-INS`, display 3 `PICKER` (docs/mapping.md, BROWSER).

1. **FL's browser.** Walk the tree to `Plugin database > Installed > Generators > ...` with the 4D (BROWSE next /
   previous, `ui.navigateBrowser(41 / 40, False)`), open folders with push or `OPEN` (`ui.toggleBrowserNode(-1)`),
   and on a plugin node push (or `MENU`): `ui.selectBrowserMenuItem()`. The stubs say it selects the highlighted
   menu item; FL's own Fire script used it to open the node's context menu, which has "Open in new channel".
   The menu is driven with the 4D (down / up / push = UI_KEY) and `ENTER`, `ESC` closes it
   (`ui.closeActivePopupMenu()`). `ENTER` on the node itself (`ui.enter()`) may also load it.
2. **FL's plugin picker.** `ui.showPicker(i [, i])` (hidden; the parser format is `i|i`, the second argument
   defaults to −1; FL 2026 release notes: "added a function to show or hide the plugin picker" and "the plugin
   picker can now be focused from a script"). Picking a generator there adds it as a new channel. The
   meaning of the arguments is unknown: PICKER shows with `showPicker(1)`, and SHIFT + display 3 cycles
   `showPicker(1, 0)` ... `(1, 3)`.

**What to report** (the daemon log, with the screen): for each step the PROBE line (the caption and file
type of the node, whether a popup was open, which form had the focus, the hint text) and whether a new
channel appeared:
- Does `navigateBrowser(41 / 40)` move FL's browser selection, and does the caption follow? Which file type
  do folders, plugins and presets report (the page treats -100 or lower as a folder)?
- Does `toggleBrowserNode(-1)` open / close the folder under the cursor?
- What does `selectBrowserMenuItem()` do on a plugin node: open a popup menu (`popup 1`), or load the plugin
  at once? In the popup, does down / up / enter reach the items, and does "Open in new channel" add a channel?
- What does `showPicker(1)` do, and each of `showPicker(1, 0..3)`; does the picker take the focus (the form
  caption / flags in BROWSER_NODE), and do down / up / left / right / enter pick an instrument?
- Which of the functions are `missing` (FEATURES `browser` / `picker`, and `missing:` in the PROBE line)?

If neither route adds a channel the loader stays a trial and the BROWSER page keeps only the presets source.

## Status and next steps

- The probe (`MK3D_PROBE=1 npm run mk3d`, reload the FL script, press ARRANGER) logs, read-only:
  `ilmcp: <dir>`, the browser root and a few folders, the hidden getters above, and **one run of a
  reading piano roll script** (it opens the piano roll if closed and changes nothing; it may add an
  undo step). It never calls `addChannel`, `addEffect` or any setter.
- After the probe: try `addChannel` and `setPatternLength` once with the owner watching, then build
  the features above one by one, each with a feature check so older FL versions fall back cleanly.

## DOUBLE and piano roll notes (2026-10-18)

DOUBLE copies steps with `getGridBit`/`setGridBit`. On the owner's try the second half stayed empty:
the notes were recorded, i.e. piano roll notes. `getGridBit` reads them at step positions, but
`setGridBit` does not write into a channel that holds piano roll notes. **SHIFT + DOUBLE** is a
trial of the hidden `patterns.duplicatePatternData(pattern)` (one `i` argument; its disassembly runs
an internal FL action on the main thread; what it does is NOT VERIFIED): one undo point, then a
PROBE line `duplicatePatternData(n) -> …; before count/len/grids; after (pattern m) …`.


### Round 1 results (owner, 2026-10-19)

- **Browser:** `getFocusedNodeCaption()` works: it returned `Repro-5.fst` (type 4), the item last used in FL's
  browser. `navigateBrowser(41/40)` and `toggleBrowserNode(-1)` changed nothing, and after `showWindow` +
  `setFocused(widBrowser)` FL still reported no focused window. Round 2: next/prev call `setFocused(widBrowser)`
  first, and the PROBE line logs what `navigateBrowser` returns (`browse(next) returned "…" -> …`).
- **Picker:** `showPicker(1)` opens a form FL calls `PlugList`; `showPicker(0)` closes it. It mostly showed the
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
  route is dropped.
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
BROWSER's display 2 `PLUG-INS` is exactly this (docs/mapping.md, BROWSER). Dead ends, removed from the UI:
the FL browser tree (`navigateBrowser` works, but nothing loads a `.fst` into a new channel;
`selectBrowserMenuItem` and `FPT_ItemMenu` open FL's File menu; Enter replaces the selected channel) and
`ui.showPicker` (the playlist's picker panel: patterns / channels). The wire codes (BROWSE, UI_KEY, PICKER,
BROWSER_NODE) stay, the unused actions are only handled by the script.
