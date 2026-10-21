# Workflow: Maschine's buttons in FL Studio

How mk3d should use the MK3's buttons: as close to Maschine 3's own workflow as FL Studio's model
and its scripting API allow. Based on Maschine 3's hardware scripts (plain Lua in
`Maschine 3.app/Contents/Resources/Scripts/`, read-only; the native page stack confirmed in the
binary with REA). This is a proposal: decisions marked **(decided)** were taken without the owner
and can be changed; **hard** marks places where FL's model or API doesn't fit.

## How Maschine works

- **One home page and a stack of pages, not modes.** CONTROL (the CHANNEL/PLUG-IN page) is home.
  **Main pages** (MIXER, ARRANGER, BROWSER, SAMPLING, the plug-in loader) replace what is on
  screen; pressing the same button again goes back home.
- **Overlays are hold-to-peek.** SCENE, PATTERN, EVENTS, VARIATION, DUPLICATE, SELECT, SOLO, MUTE,
  GRID, NOTE REPEAT show while the button is held and vanish on release. **Display button 1 on an
  overlay is a pin tab named after the page**: pressing it latches the overlay (pin states are
  saved). Tool-like pages (STEP, PAD MODE, KEYBOARD, CHORDS, FILE, SETTINGS, MACRO) are always
  latched: press to enter, press again to leave, and you are back on the page underneath.
- **SHIFT is read at press time** and gives the button's second label: the same screen slot
  changes text (`CREATE` → `RENAME`), a different page opens (BROWSER → plug-in loader, FOLLOW →
  GRID, VARIATION → NAVIGATE), or an action fires without a page (FILE → save, TAP → metronome,
  DUPLICATE → double, MUTE → choke all). **SHIFT + pad** is a 16-action row: undo, redo, step
  undo/redo, quantize, quantize 50 %, nudge ◀ ▶, clear notes, clear automation, copy, paste,
  semitone −/+, octave −/+.
- **Tap vs hold on one button**: REC tap = record (Maschine's hold = pattern length is built as the
  PATTERN overlay's LENGTH knob instead); SHIFT+RESTART tap = loop on/off, hold = loop editor; a step pad tapped toggles, held opens that step's editor.
- **Pads change role with the page** (sounds, steps, patterns, scenes, mute/solo targets, grid
  values) but always show the objects' own colors. GROUP A–H always pick a group; what the press
  does depends on the page.
- **Screens are a pair**: left = context and navigation (tabs, lists, slots), right = detail
  (parameters, logo, results, pad grid). Display buttons and knobs act on the half they sit under.
- **4D encoder**: turn = scroll a list or edit the quick-edit value, push = confirm/load, tilt
  ◀ ▶ = move between columns/slots/strips, tilt ▲ ▼ = change level (group ↔ sound). Its tilt
  LEDs are dim where a move is possible.
- **LEDs**: usable = dim, active or pressed = bright, not available = off; radio groups
  (CHANNEL/PLUG-IN, PAD MODE/KEYBOARD/CHORDS, PITCH/MOD/PERFORM/NOTES) have exactly one bright.
  A page button is bright when its page is on top, dim when it is pinned underneath.
- **PLUG-IN is not a browser.** CHANNEL and PLUG-IN show the same Control page, once with the
  channel's own parameters and once with its plug-in slots' NKS pages. Loading a plug-in is
  SHIFT + BROWSER (the plug-in loader), or pushing the 4D encoder on the plug-in page, and
  SHIFT on the plug-in page gives `EDIT` (open the plug-in window), `INSERT`, `SAVE`, `BYPASS`,
  `REMOVE`. So mk3d's PLUG-IN mode already matches Maschine.

## How Maschine's objects map to FL

| Maschine                 | FL Studio                                                             |
| ------------------------ | --------------------------------------------------------------------- |
| Sound (pad)              | Channel in the channel rack                                           |
| Group (A–H)              | A bank of 16 channels (channels 1–16 = A, 17–32 = B, …) **(decided)** |
| Master/Group/Sound level | Master / mixer track / channel                                        |
| Pattern                  | Pattern                                                               |
| Scene / Section          | Playlist markers (jump to, add) — **hard**, FL has no scenes          |
| Plug-in slots            | The channel's generator; mixer track FX slots for effects             |
| Arranger                 | Playlist                                                              |

## Button by button

"Main" = main page (press again = home); "Hold" = hold-to-peek overlay, display button 1 pins
it; "Latch" = press to enter, press again to leave.

| Button (2nd label)                    | Maschine                        | mk3d                                                                                                                                                          | Kind  |
| ------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| CHANNEL (MIDI)                        | Control page, channel params    | Channel mode (home). As today; 4D push opens the editor, which then follows the selection                                                                     | Main  |
| PLUG-IN (Instance)                    | Control page, plug-in NKS pages | Plugin mode with NKS pages (as today). SHIFT row: `EDIT` (editor), `<<` `>>` presets, `BYPASS` (mixer slot)                                                   | Main  |
| ARRANGER                              | Sections / clips                | **Built** as a pattern overview (the playlist's clips are invisible to scripts outside performance mode): right screen = the current pattern's step grid, up to 8 channel rows × 16 steps with the play head; left screen = the rows' channels; 4D turn/push = row cursor/select channel, tilt and knob 6 = step page, knob 5 = rows, pads = patterns, `SONG`, `PREV PAT`/`NEXT PAT`; shows and focuses FL's playlist. FL's Performance mode clips are a separate overlay now: SHIFT + SCENE opens LIVE (docs/mapping.md) | Main  |
| MIXER                                 | 8 strips, knobs = volume or pan | Mixer mode: 8 tracks per bank, knob = volume, 4D push toggles pan, tilt ◀ ▶ = track, arrows = bank. FL look (docs/design.md)                                  | Main  |
| BROWSER (+Plug-in)                    | Preset browser / plug-in loader | **Built.** Preset browser of the selected plug-in: display 5 `PREV` / 6 `NEXT` and 4D turn load the previous/next preset (`plugins.prevPreset/nextPreset`), a list of preset names around the current one. 4D push does nothing yet. SHIFT (plug-in loader) is **hard**: FL can't load plug-ins | Main  |
| SAMPLING                              | Record and slice                | Not mapped. FL's API can't record into Edison or slice — **hard**                                                                                             | –     |
| FILE (Save)                           | File page / save                | **Built.** SHIFT + FILE = save the project (read-out `SAVED`, no page). FILE: `SAVE`, `NEW VER` (FPT_SaveNew), `UNDO`, `REDO` on the display buttons, FL's undo state on the screens **(decided)** | Latch |
| SETTINGS                              | Settings                        | **Built.** mk3d's own settings: knob 1 pad full-scale hit, knob 2 pad curve, knob 3 fixed velocity value, a curve graph; saved with the page state. Screen and LED brightness are not built | Latch |
| AUTO                                  | Automation write while held     | **hard**: FL records knob moves only while recording; AUTO held = arm FL's automation recording if the API allows, else unused                                | Hold  |
| MACRO (Set)                           | 8 macros                        | **hard**: FL has no macros. Later: 8 user-chosen parameters saved by mk3d                                                                                     | Latch |
| NOTE REPEAT (Arp)                     | Note repeat / arpeggiator       | **Built** (hold overlay, pin tab `NOTE RPT`). mk3d generates the repeats itself, synced to FL's tempo and song position; rate 1/4–1/32T on display 2–8 and knob 1, gate knob 2, swing knob 3. In KEYBOARD and CHORDS the button opens the **arpeggiator** (pin tab `ARP`): the held pads' notes one at a time on the same grid, Type/Rate/Octaves/Gate/Swing on knobs 1–5, HOLD on display 3, four presets on display 5–8 | Hold  |
| LOCK                                  | Snapshot lock                   | Not mapped (no FL equivalent)                                                                                                                                 | –     |
| VOLUME (Velocity)                     | 4D edits volume of the level    | **Built.** 4D turn = FL's main volume (`REC_MainVol`, not the Master fader), or the channel's volume while a pad is held (a group button held = mixer track is not built)                                 | Quick |
| SWING (Position)                      | 4D edits swing                  | **Built.** 4D turn = main swing (`REC_MainShuffle`); a held pad changes nothing (no channel swing)                                                            | Quick |
| TEMPO (Fine-tune)                     | 4D edits tempo                  | **Built.** 4D turn = tempo (SHIFT = fine), or channel pitch while a pad is held                                                                               | Quick |
| PAD MODE                              | Pads = 16 sounds                | Pads = the 16 channels of the current bank, each plays its channel (drum-machine style) **(decided)**                                                         | Latch |
| KEYBOARD                              | Pads = notes                    | **Built.** Pads = notes on the selected channel, octave/semitone on the display buttons, knob 1 = scale (Chromatic by default = what pads did before) | Latch |
| CHORDS                                | Chord pads                      | **Built (software only).** Pads play chords: harmonizer (each pad's scale note plus a stack in the scale) or chord set (I…vii triads, I up, I7…vii7, I7 up); knobs scale, chord mode, chord type, position. USER CHD, PADS ON, strumming unbuilt | Latch |
| STEP                                  | Pads = 16 steps                 | **Built.** Step page: pads = 16 steps of the selected channel in the current pattern (press toggles), `<<` `>>` page, FOLLOW; held step = its velocity/pitch comes later | Latch |
| FIXED VEL (16 Vel)                    | Fixed velocity / 16 velocities  | **Built (toggle).** Every pad note (KEYBOARD, PAD MODE, NOTE REPEAT) uses the fixed value (SETTINGS knob 3) instead of the hit; LED bright while on. SHIFT + FIXED VEL (16 velocities of the selected channel) is not built: LED off | –     |
| SCENE                                 | Scenes                          | **Built.** The same marker pads; press = jump at the next bar while playing (now while stopped), `NOW` = always now, a queued pad flashes. SHIFT (sections) unbuilt — **hard**, FL has no scenes | Hold  |
| PATTERN                               | Patterns                        | **Built.** Pads = patterns 1–16 (banks with `<<` `>>`), press = select; `DOUBLE` (twice the length, grid steps copied; not piano roll notes), `DUPLICATE` (clone the current one) and `CREATE` (new empty); a free pad (`+`) creates its pattern; knob 4 `LENGTH` (16 32 64 … 512 steps a detent, SHIFT = 1 step; `setPatternLength`) and knob 1 `COLOR` (one page); no `DELETE` (FL has no API for it) | Hold  |
| EVENTS                                | Note editor                     | **hard**: FL's MIDI scripts can't edit piano roll notes (piano roll scripts are a separate system). Not mapped yet                                            | Hold  |
| VARIATION (Navigate)                  | Humanize/random / view switcher | VARIATION: not mapped (**hard**, same reason). SHIFT = NAVIGATE (**built**): show/focus FL's windows (mixer, rack, playlist, piano roll, browser, plug-in)           | Hold  |
| DUPLICATE (Double)                    | Copy pad to pad                 | **Built.** Hold + pad = clone that pattern (`patterns.clonePattern`; pin tab `DUPLICATE`). SHIFT + DUPLICATE = clone the current pattern, no page. Channels can't be cloned through the API | Hold  |
| SELECT                                | Select sound/group              | Hold + pad = select that channel; group button = bank                                                                                                         | Hold  |
| SOLO                                  | Hold + pad = solo               | Hold + pad = solo that channel; on the Mixer page, hold + display button = solo that track                                                                    | Hold  |
| MUTE (Choke)                          | Hold + pad = mute               | Hold + pad = mute that channel; on the Mixer page, hold + display button = mute that track                                                                    | Hold  |
| GROUP A–H                             | Focus group                     | Pick the channel bank (pads in PAD MODE); on the Mixer page: track 1–8 of the bank                                                                            | –     |
| PLAY, STOP, REC, RESTART, TAP (Metro) | Transport                       | **Built.** REC tap = record (the hold-REC page was dropped: pattern length is knob 4 of the PATTERN overlay). SHIFT+RESTART tap = song loop on/off, hold (400 ms) = the LOOP overlay (`selectionSet`, hidden); RESTART's LED is bright while a loop is active | Tap/hold |
| FOLLOW (Grid)                         | Follow play position / grid     | FOLLOW: not in FL's API (verify). SHIFT = GRID (**built**): pads pick FL's snap value (`ui.getSnapMode/setSnapMode`)                                      | Hold  |
| ERASE                                 | Hold + pad erases               | **Built.** Hold + pad in STEP = clear that step; hold + pad in PAD MODE = clear the channel's steps in this pattern; in KEYBOARD the pads do nothing while held                  | Hold  |
| PITCH / MOD / PERFORM / NOTES         | Touch strip modes               | **Built** (not verified in FL yet). PITCH (default: bend, springs back), MOD (CC 1, kept per channel), PERFORM (momentary cutoff sweep, restored on release), NOTES (scale zones, or the bank's 16 channels in PAD MODE); pressing the lit one = no mode: the strip shows the play position. SHIFT + strip does nothing yet. docs/mapping.md, "Touch strip" | Radio |
| SHIFT + pad 1–16                      | Action row                      | **Built.** undo, redo, quantize (`channels.quickQuantize`), clear (the channel's steps), copy/paste (a step clipboard in the FL script), transpose the channel's recorded notes by a semitone or an octave (TRANSPOSE; NOT VERIFIED for piano roll notes), each with a read-out card; step undo/redo, nudge and clear automation are **hard** (LED off) | –     |

## Hard to map with FL

> **Playlist probe, 2026-10-18 (owner's FL 2026, performance mode off, project with clips and two
> markers):** `getLiveBlockStatus` is 0 and `getLiveBlockColor` the default `39454c` for every track
> and block, `getLiveStatus` raises "Index out of range", `liveTimeToBlockNum` returns −1 and
> `liveBlockNumToTime(b)` is just `b` bars (384 ticks at PPQ 96). Track index 0 raises; tracks are
> 1-based. So **outside performance mode a script cannot see playlist clips**; nor piano-roll notes.
> `getMarkerName(i)` lists the markers reliably (0-based), while the jump scan gave unstable
> positions (a marker alternately at 0 and at 1158).
>
> The owner chose a **pattern overview** (Maschine's pattern view: sounds × steps) for ARRANGER
> and wants FL's Performance mode later; the marker list now takes its count and names from
> `getMarkerName` and uses the scan only for times (unknown when the two disagree).

> **Playlist probe, 2026-10-20 (same probe, performance mode now ON, a clip on Track 1 block 0):**
> confirmed — `getLiveBlockStatus` reports real data once performance mode is on: `T1 def: 1 0 0 0
> 0 0 0 0 0 0 0 0 0 0 0 0` (block 0 = filled, matching the clip the owner placed there), all other
> tracks/blocks `0`. `liveTimeToBlockNum` also came alive (`t2b: -1 0 0 0 0 1 1 1 1 2 2 2 2 3 3 3`,
> vs. all `-1` with performance mode off). Two things still open: `getLiveBlockColor` stayed at the
> default `39454c` even on the filled block (the clip/pattern may need an explicit color before it
> shows); `getLiveStatus(index, mode)` (the per-track summary, not per-block) still raises "Index
> out of range" on every track including the filled one, while `getLiveBlockStatus` on the same
> index works — a second probe pass with a colored clip, and a look at why `getLiveStatus` differs
> from `getLiveBlockStatus`, should close this out. Otherwise: **Maschine-style scenes via
> `playlist.getLive*`/`triggerLiveClip` is viable**, gated on performance mode being on.

1. **Scenes and sections.** Maschine arranges by scenes of patterns; FL by placing patterns in
   the playlist, whose clips a script cannot read. SCENE uses the playlist markers (**built**), with
   limits: the API has no marker count or time, so the script takes the count and names from
   `getMarkerName` and finds the times by jumping through the markers while FL is stopped (the list can
   be stale after edits in FL until the next scan: opening SCENE, loading a project; the times are unknown
   when the scan and the names disagree, e.g. a marker at tick 0); markers cannot be added, deleted or
   renamed from a page any more; a quantized jump waits for FL's bar beat (not sample exact); there are no
   real sections (SHIFT + SCENE) and no scene content (patterns per scene). ARRANGER therefore shows the
   current pattern's steps (PATTERN_GRID) instead of the arrangement. **Update, 2026-10-20:** FL's
   Performance mode turned out to work once it is actually switched on (`playlist.getLive*` reads
   nothing only outside it — the original probe here was run with it off); SHIFT + SCENE now also
   opens LIVE, Maschine-scene-style clip launching across tracks (docs/mapping.md "LIVE",
   docs/sysex.md "Live grid"), a second, separate overlay from this one's marker-based SCENE.
   **Building the sets (putting clips into the performance grid) stays on the computer**
   (2026-10-21): no script call places, moves or deletes playlist clips (not in the stubs, not
   among the hidden functions, not in the 2026 release notes), and the one indirect route, FL
   placing a recorded pattern's clip where Song-mode recording started, does not work with
   performance mode on: the song position cannot be set to a column, and the owner's test
   recorded nothing into the pattern. The MK3 makes, fills and colors patterns (a unique color
   names the clip in LIVE) and plays the set; FL's Record → Clips turns a played set into an
   arrangement.
2. **Note editing** (EVENTS, VARIATION, step modulation beyond velocity/pitch): FL's MIDI
   controller scripts can't read or write piano-roll notes; only steps in the channel rack.
3. **Loading plug-ins and samples** (plug-in loader, SAMPLING): the API can't add a channel or a
   plug-in; it can only step presets of a loaded plug-in and drive FL's browser window.
4. **Macros, snapshots/LOCK, AUTO write**: no FL equivalent; mk3d would have to keep its own.
5. **Group vs sound levels**: FL has channels and mixer tracks but no groups; banks of 16
   channels stand in for groups.
6. **Pattern delete.** FL's API has no delete-pattern call, so PATTERN has no `DELETE`. SHIFT +
   DUPLICATE ("Double") only clones the pattern; PATTERN's own `DOUBLE` tab doubles the length and the grid
   steps (not piano roll notes). The pattern length is `setPatternLength` (PATTERN's knob 4,
   docs/fl-ilmcp.md), not a hold-REC page.
7. **SHIFT + pad actions without an FL call**: step undo/redo (pads 3, 4), nudge ◀ ▶ (7, 8) and clear
   automation (10) have no FL scripting equivalent; their pad LEDs stay off and nothing happens.
8. **Hold-to-peek on FL's side**: everything is drawn by mk3d, so overlays are cheap; only pin
   state persistence needs a small settings file.

## Order to build in (decided)

1. The page model: home page, main pages (second press = home), hold overlays with a pin tab on
   display button 1, latched tool pages, page-button LED rules, SHIFT at press time.
2. MIXER (in FL's look), with MUTE/SOLO holds acting on tracks.
3. Pad modes: KEYBOARD (today's pads) and PAD MODE (channels), GROUP A–H as channel banks;
   SELECT/MUTE/SOLO holds acting on channels.
4. STEP and PATTERN (+ ERASE, DUPLICATE where the API allows). **Done.**
5. Quick edit (VOLUME/SWING/TEMPO), SHIFT+pad actions, NAVIGATE, GRID. **Done.**
6. NOTE REPEAT **done** (with the ARP arpeggiator in KEYBOARD and CHORDS, software only). BROWSER (presets), FILE, SETTINGS and FIXED VEL **done** (step 6b, software only:
   nothing new reaches the MK3). SCENE on playlist markers **done** (step 6c, new FL script
   commands: reload the script in FL); ARRANGER redone as the pattern overview (PATTERN_GRID; reload the script in FL). CHORDS and the KEYBOARD scales **done** (step 6d, software only:
   nothing new reaches the MK3). Later: SHIFT + FIXED VEL (16 velocities), USER CHD, strumming.
