# Control mapping

What each MK3 control does. Global controls work the same on every page; the page on top owns
the rest. Code: `src/main.ts` (global), `src/modes/pageStack.ts` (the page buttons), `src/modes/`
(the pages), `src/strip.ts` (touch strip).

## Global controls

| Control      | Action                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shift        | Modifier. Its LED is bright while held                                                                                                                                                                                                                        |
| Play         | CC 102: play/pause                                                                                                                                                                                                                                            |
| Stop         | CC 103: stop                                                                                                                                                                                                                                                  |
| Rec          | CC 104: toggle record. Shift + Rec: CC 105, toggle count-in                                                                                                                                                                                                   |
| Restart      | CC 108: stop, then start (from the song start). **Shift + tap: song loop on/off** (the stack's `tap`, no restart); **Shift + hold (400 ms): the LOOP overlay** (see "LOOP" below). The LED is dim, bright while FL's song loop is active (LOOP_STATE) |
| Tap          | CC 107: tap tempo. Shift + Tap: CC 106, toggle metronome                                                                                                                                                                                                      |
| Pads 1–16    | Numbered like Maschine: pad 1 is the bottom-left pad, rows go up. What a hit does depends on the pad mode (see "Pad modes" below): KEYBOARD (default) plays notes `base + pad` (base 36 = C3, so 36–51, bottom-left = 36) on MIDI channel 1, which FL plays on the selected channel; PAD MODE plays the channel under the pad (note = its group-local index on MIDI channel 2; verified in FL 2026). Velocity from the hit (through the SETTINGS curve), or the fixed value while FIXED VEL is on; poly aftertouch from the pressure. A page that uses the pads (an overlay) takes them instead |
| Touch strip  | Four modes picked by PITCH / MOD / PERFORM / NOTES: channel pitch, mod wheel, a filter sweep or notes (see "Touch strip" below) |
| Pitch, Mod, Perform, Notes | The touch strip's mode, a radio group (exactly one bright): press = that mode, press the lit one = no mode (all dim; the strip LEDs then show the play position). Default PITCH, saved with the page state. Every page; SHIFT + button does nothing |
| Volume, Swing, Tempo | Quick edit: a radio group that turns the 4D encoder into an editor for the current page (see "Quick edit" below). Press = on (bright), press the lit one = off (dim) |
| Shift + pads | Not notes: Maschine's action row (see "SHIFT + pads" below) |
| Page buttons | Open pages, see "Pages" below. SHIFT is read when the button is pressed                                                                                                                                                                                       |
| Group A–H    | Pick the channel bank (see "Channel banks" below), on every page except the Mixer, which keeps them as its track buttons. LEDs: the current bank bright white, other banks that exist dim white, the rest off                                                  |

While FL isn't connected the screens show "Waiting for FL Studio…" and the pages get no events.

## Pages

Maschine's page model (`docs/workflow.md`), in `src/modes/pageStack.ts`. There is a **main page**
(CHANNEL or PLUG-IN: the two control pages, home) and at most one **overlay or tool page** on top.
Every page button is in a registry (button, or SHIFT + button, to page id and kind); a page that
is not built yet logs `page "<name>" is not built yet` once per press and changes nothing.

- **FL's windows follow the page buttons** (`src/modes/flWindows.ts`, the owner's wish 2026-10-18):
  opening a page with its button brings up its FL window and gives it the focus: MIXER → mixer,
  ARRANGER → playlist, STEP and PAD MODE → channel rack, KEYBOARD and CHORDS → piano roll (SHOW_WINDOW),
  BROWSER → the selected channel's plugin window (SHOW_EDITOR). A window that has the focus already is
  left alone (both commands toggle in FL's script). Overlays, FILE, SETTINGS and CHANNEL / PLUG-IN
  (editor follow) bring up nothing.
- **Main buttons** (CHANNEL, PLUG-IN, MIXER, ARRANGER, BROWSER, later SAMPLING): close the page on
  top and show that page. Pressing the button of the page already shown does nothing on the
  control pages and goes back to the last control page on the others.
- **Overlays** (SCENE, PATTERN, EVENTS, VARIATION, DUPLICATE, SELECT, SOLO, MUTE, NOTE REPEAT;
  SHIFT + VARIATION = NAVIGATE, SHIFT + FOLLOW = GRID; SHIFT + RESTART = LOOP, a *hold* overlay that
  opens only after 400 ms, a tap runs its own action): hold to peek, closed on release. Display
  button 1 is the pin tab, named after the page: pressing it pins the overlay so it stays after the
  release; pressing it again unpins (and closes it at once if its button isn't held). A pinned
  overlay closes on the next press and release of its button. Pin states are remembered per page
  and saved in `~/Library/Application Support/mk3d/pages.json`. The overlay never sees display 1.
- **Claimed buttons**: a main page can claim an overlay's button (`claimsPageButton(id)` on the
  page). While FL is connected the stack then gives the press and the release to that page (the
  release even if the main page changed in between) and opens no overlay; the page-button LED of
  a claimed button is the page's own. The Mixer claims MUTE and SOLO.
- **Tool pages** (STEP, PAD MODE, KEYBOARD, CHORDS, FILE, SETTINGS, MACRO): always latched, press to
  open, press again to close (on the release); another page button closes it first. PAD MODE,
  KEYBOARD and CHORDS also set the pad mode when they open ("Pad modes"); SHIFT + any of them sets
  the mode and opens no page. Their LEDs are a radio group (see below).
- **SHIFT is read at press time**; the release goes to the page the press opened.
- **Events**: the top page gets them first; what an overlay doesn't handle goes to the main page,
  so knobs keep working under a peek. Pads go the same way; a pad no page takes plays a note. A
  pad's move and release follow the page that took its press, even after that page closed.
- **Screens and LEDs**: the top page draws both screens. Its LEDs go over the main page's, then the
  page buttons: the button of the page on top and a main page under an overlay are bright, the other
  built pages dim, unbuilt pages off. CHANNEL and PLUG-IN: exactly one bright (the control page).
- When an overlay on top of a main page closes, the main page's `resume` resends its VIEW without
  resetting its state; without `resume` the stack calls `enter`. An overlay that needs another window of FL's data (PATTERN: `patternOffset`) declares
  it as a `viewPatch`, which the stack merges into every VIEW the main page sends meanwhile.

- **Page button LEDs**: PAD MODE, KEYBOARD and CHORDS are a radio group: exactly one is bright, the
  current pad mode, whichever page is open (or none), STEP's included. A page on
  top can keep a button's LED for itself (`ownsButtonLed`: STEP owns FOLLOW's). GROUP A–H are lit by the
  stack as banks first, and a page that owns them (the Mixer) overrides that.
- **State file**: `pages.json` holds `pinned` (the overlays' pin states), `padMode`
  (`keyboard`, `channels` or `chords`, default `keyboard`) and `pages` (the settings of pages with
  `persisted`: `noteRepeat`, `settings`, `scene`, `chords` = the scale and chord settings that
  KEYBOARD and CHORDS share: `scale`, `mode`, `type`, `position`).

- **ERASE** (hold modifier, not a page): the stack tracks it and tells the pages (`mc.erase`). Its
  LED is bright while held, dim otherwise. A pad no page takes while ERASE is held never plays: in
  PAD MODE it clears all steps of that channel in the current pattern (CLEAR_STEPS), in KEYBOARD and
  CHORDS it does nothing; the STEP page clears the step itself; an overlay that uses the pads (MUTE, PATTERN, …)
  still gets them. The pad's move and release are swallowed, and a note started before ERASE was
  pressed still ends.
- **SHIFT + DUPLICATE** ("Double"): clones the current pattern (CLONE_PATTERN) and opens no page;
  FL can't double a pattern's length.
- **SHIFT + FILE**: saves the project (UI action `save`, FPT_Save) and opens no page; the read-out card
  says `SAVED` (small line `SHIFT + FILE`).
- **FIXED VEL**: toggles fixed velocity (see "SETTINGS and FIXED VEL"); bright while on, dim while
  off, **off while SHIFT is held** (SHIFT + FIXED VEL, 16 velocities, is not built: nothing happens).

Built so far: CHANNEL, PLUG-IN, MIXER, ARRANGER, BROWSER, SCENE, PATTERN, DUPLICATE, MUTE, SELECT, SOLO, STEP, PAD MODE,
KEYBOARD, FILE, SETTINGS, NAVIGATE (SHIFT + VARIATION), GRID (SHIFT + FOLLOW) and LIVE (SHIFT + SCENE). VARIATION
alone is not built: its LED is off (a SHIFT + button page lights its button only while it is open).

## Pad modes and channel banks

- **Pad mode** (global, saved): `keyboard`, `channels` or `chords`, set by PAD MODE / KEYBOARD /
  CHORDS (or SHIFT + them). Code: `src/modes/padState.ts`, the fallback for pads no page takes (`main.ts` calls it).
  - `keyboard`: pad _n_ plays note `base + n` on MIDI channel 1 (FL plays it on the selected
    channel), poly aftertouch from the pressure. `base` starts at 36 and moves with the KEYBOARD
    page, within 0…112 so that pad 16 is at most 127. With a scale (KEYBOARD knob 1) pad _n_
    plays scale degree _n_ counted up from the base note, clamped to 127 ("Scales and chords").
  - `chords`: pad _n_ plays a chord: a note on MIDI channel 1 for every note of it, all with the hit
    velocity (or the fixed one), poly aftertouch to each of them ("Scales and chords").
  - `channels`: pad _n_ plays channel `bankStart + n` of the current bank: a note on MIDI channel 2
    with the channel's group-local index as note number, which the FL script plays itself
    (`docs/sysex.md`, "Pad notes for channels"). A hit also selects that channel when it is not
    selected yet. Pads past the last channel, and channels above index 127 (a note number cannot
    carry them), play nothing.
  - Each pad remembers where its down went: its aftertouch and release go to the same note, the
    exact notes of the same chord, or channel even if the mode, the base note, the scale, the chord
    settings or the bank changed while it was held.
  - Pad LEDs (when no page owns the pads): `keyboard` = the selected channel's color, C notes
    (the scale's roots with a scale) bright, the rest dim, held pressed; `chords` = the same with
    the root chords bright; `channels` = each pad its channel's color, the selected
    one bright, the others dim, held pressed, off past the last channel; a channel FL is playing
    (the sequencer, the playlist, another controller: ACTIVITY, `channels.getActivityLevel`) lights
    its pad pressed too, so the pads flash with the pattern like Maschine's. Colors come from the
    channel window FL reports (VIEW `channelOffset`); pages that show the pads patch it to the
    current bank, and entries FL reported earlier stay cached. `keyboard` and `chords` pads do not
    flash with playback: no script API says which note a channel plays (PLAN.md idea list). Nor do
    the MUTE, SELECT, SOLO and PAD MODE pages' pads yet.
- **Channel banks** (Maschine's groups A–H): 16 channels each, A = 1–16, B = 17–32, … The current
  bank is the one of the selected channel. **GROUP A–H** select the channel that was last selected
  in that bank (remembered per bank while mk3d runs), else the bank's first channel; a bank without
  channels does nothing. The overlays that use pads (MUTE, SELECT, SOLO) and the PAD MODE and
  KEYBOARD pages take the group buttons themselves, also over the Mixer page; PATTERN keeps its
  own `<<` `>>` for pattern banks and lets the group buttons fall through. Channel mode's list
  follows the selection as before.

## PAD MODE page (tool page, PAD MODE)

- Display 1 is the page tab `PAD MODE` (always lit). Right screen: the bank's 4×4 grid (channel
  number, name, color; the selected channel outlined in orange, muted ones dimmed and struck
  through) and the window text; display 7 and 8 are `<<` and `>>`, the previous and next bank like
  GROUP A–H (the label and the LED only where that bank exists). Left screen: the bank letter big,
  `channels 1–16 of 20`, and the selected channel's name.
- The page takes no pad: the pads play their channels, and their LEDs are the global fallback
  (held pads stay pressed). Display 2–6 do nothing and do not reach the page underneath.

## KEYBOARD page (tool page, KEYBOARD)

- Display 1 is the page tab `KEYBOARD` (always lit). Right screen: tabs `OCT-` `OCT+` `SEMI-`
  `SEMI+` over display 5–8 (blank and unlit where the base note cannot move that way), a 4×4 grid
  of the note names the pads play (bottom-left is the base note; C notes bright with an orange
  top line) and `MIDI 36–51`. Left screen: the selected channel and the range in FL's naming,
  where note 60 is C5 and 36 is C3 (`C3–D#4`).
- OCT± moves the base note by 12, SEMI± by 1, within 0…112. The pads play notes and light as the
  global fallback; GROUP A–H pick the channel bank.
- **Knob 1 = scale** (turn in detents of 120 counts): Chromatic (default: `base + pad` as always),
  Major, Minor, Harmonic minor, Melodic minor, Dorian, Phrygian, Lydian, Mixolydian, Locrian, Major
  pent., Minor pent., Blues. The base note is the root: pad 1 plays it and the scale's root pads
  (degrees 1, 8, 15 of a 7-note scale) are the bright ones. The knob and its value sit under
  display 1's column on the left screen; the left screen also shows the range (first–last pad's
  note) and the scale as `C Minor`; the grid shows each pad's note name. Knobs 2–4 are not the
  page's. The scale is shared with CHORDS and saved (`pages.chords`).

## CHORDS page (tool page, CHORDS)

Code: `src/modes/chords.ts` (scales, chords, settings: pure), `chordsPage.ts` (the page, KEYBOARD's
page with four knobs), `harmonyPanel.ts` (knobs, saving). Latched: CHORDS opens it and sets the pad
mode `chords`, CHORDS again leaves it, SHIFT + CHORDS sets the mode without the page. The page
takes no pad: the pads play chords through `PadState`.

- Display 1 is the page tab `CHORDS`. Display 5–8 are `OCT-` `OCT+` `SEMI-` `SEMI+` as on KEYBOARD
  (they move the root). Knobs 1–4 under the left screen's columns: **Scale** (as KEYBOARD),
  **Chord mode** (`Harmonizer` / `Chord set`), **Chord type** (`Octave` 1-8, `Fifth` 1-5, `Triad`
  1-3-5, `Sus4` 1-4-5, `Seventh` 1-3-5-7, `Ninth` 1-3-5-7-9; `—` in chord set) and **Position**
  (inversion 0…notes−1: the lowest n notes move up an octave; chord set allows 0…3 and a triad
  stops at 2). Knobs 5–8 are not the page's.
- **Harmonizer**: every pad plays its KEYBOARD note and the notes stacked on it inside the scale.
  A stack is counted in scale degrees of the scale's own notes (Triad = degrees 0, 2, 4 above the
  pad's, Octave = one octave up); with Chromatic the major scale is stacked from the pad's note.
- **Chord set**: pads 1–7 the diatonic triads I…vii of the scale from the base note (Major when the
  scale is Chromatic, pentatonic or Blues, else the selected scale), pad 8 = I an octave up, pads
  9–15 the diatonic sevenths, pad 16 = I7 an octave up.
- Every note is clamped to MIDI 0–127; notes that clamping makes equal sound once.
- A hit sends a note on for each note with the hit velocity (FIXED VEL: the fixed value) on MIDI
  channel 1 and a release sends the offs of exactly those notes. NOTE REPEAT is the arpeggiator
  here (one chord note at a time; see NOTE REPEAT, "ARP"). SHIFT + pad (transpose) and ERASE (nothing) are as on KEYBOARD.
- Screens: left = the tab, the selected channel, the scale and root (`C Minor`; in chord set the
  scale it really uses), mode, type and position, and the four knobs with their values. Right = the
  4×4 grid mirroring the pads with the chord name on each (`Cm`, `D°`, `Ebmaj7`; flats are written
  `b` because Barlow has no ♭ glyph), root chords in bold orange with an orange top line, and
  `root C3  MIDI 36`. Pad LEDs: the channel's color, root chords bright (harmonizer: the scale's
  roots, a C in Chromatic; chord set: the I chords, pads 1, 8, 9, 16), the rest dim, held pressed.
- Settings (scale, mode, type, position) are shared with KEYBOARD and saved as `pages.chords` a
  moment after the last turn and when the page closes.
- Unbuilt: USER CHD, PADS ON, strumming.

## STEP page (tool page, STEP)

Code: `src/modes/stepPage.ts`. Latched: STEP opens it, STEP again leaves it. The pad mode
(KEYBOARD or PAD MODE) underneath is not changed and comes back when it closes. STEP's LED is
bright while open; the PAD MODE / KEYBOARD radio pair stays lit as it is.

- **Pads** 1–16 are steps 1–16 of the current step page of the selected channel in the current
  pattern (VIEW `stepOffset` = page × 16, merged into the main page's VIEW). A press toggles the
  step (SET_STEP; held-step editing, velocity and pitch of a held step, comes later). With ERASE
  held, a press clears the step (SET_STEP off). Steps past the pattern length have no LED and ignore
  presses. Pad moves and releases are taken, so no pad plays a note under the page.
- **Pages**: display 7/8 (`<<` `>>`) and the arrow buttons step back and forward by 16 steps,
  limited to the pattern length (64 steps = 4 pages). Display 1 is the tab `STEP` (always lit; no
  pin). GROUP A–H still pick the channel bank, so the steps switch to that channel.
- **FOLLOW** (display 5, tab `FOLLOW`, and the FOLLOW button while STEP is open; both LEDs bright
  when on, default on): while playing, the page turns to the play head's page each time the head
  enters a page it was not on; paging by hand sticks until then. Turning it on while playing turns
  to the head at once. SHIFT + FOLLOW is GRID (below).
- **Play head** (pad: white; screen: orange outline): from SONG_POS, **assuming 16 steps per
  bar**: position in the pattern = `((bar − 1) × 16 + step − 1) mod pattern length`. Not verified
  in FL (the same open question as `SONGPOS_STEP_BASE` in `docs/sysex.md`); it is a guess for song
  mode, where the pattern may not start at a multiple of its own length.
- **Pad LEDs**: on = the channel's color, bright; off = the channel's color dim in steps 1–4 and
  9–12 and fainter (the palette's true dim step) in 5–8 and 13–16, so the groups of 4 alternate as
  in FL's channel rack; the play head white; off past the pattern length.
- **Left screen**: tab `STEP`; the selected channel's number and name in its color; `Pattern 3` and
  its name; `steps 17–32 of 64`; under that a 1×N overview of the pattern's pages (the shown page
  orange, the play head's page with a white bar) and `page 2 of 4`.
- **Right screen**: tabs `FOLLOW` (underlined when on), `<<` `>>` (only where the page exists); the
  16 steps as a 4×4 grid that mirrors the pads (step 1 bottom-left) in FL's step colors: off A/B
  shades and on colors alternate by rows of 4 (design.md), the step number in each corner and the
  play head outlined in orange. Steps past the pattern length are empty.
- Knobs, the 4D encoder and the other buttons fall through to the main page. The page needs
  FL's PATTERN (length) and STEP_GRID messages; the grid shows steps as off until FL's STEP_GRID
  for the selected channel and pattern arrives.

## Select overlay (hold SELECT)

- Pads 1–16 are the 16 channels of the current bank; a pad press selects that channel
  (SELECT_CHANNEL). GROUP A–H pick the bank. The selected channel's pad is bright, the others dim,
  off past the last channel.
- Left screen: pin tab `SELECT`, the selected channel's number, name and the bank. Right screen:
  the grid with the selected channel outlined. Display 2–8 do nothing; knobs, arrows and the 4D
  encoder fall through.

## Solo overlay (hold SOLO)

- Pads 1–16 are the 16 channels of the current bank; a pad press toggles that channel's solo
  (SET_CHANNEL solo, from FL's own solo flag in CHANNELS). Soloed channels are bright on the pads
  and outlined in red with an `S` on the grid, the others dim. GROUP A–H pick the bank.
- Left screen: pin tab `SOLO`, the window text and the number of soloed channels. The Mixer page
  still claims SOLO and solos mixer tracks.

## Pattern overlay (hold PATTERN)

- Pads 1–16 (note 36 = bottom-left pad) are the patterns of the current bank of 16, the bank of the
  current pattern when it opens (VIEW `patternOffset` = bank × 16). A pad press selects the pattern
  (SELECT_PATTERN, 1-based). Pad LEDs: the pattern's color, bright for the current one, dim for the
  others, off past the last pattern.
- Display 7 and 8 (right screen, columns 3 and 4: `<<` `>>`) page between the banks; the LED is dim
  when that bank exists, else off (and no label).
- Display 3 `DOUBLE` (left screen, column 3; Maschine's order is PATTERN, CLIP, DOUBLE, DUPLICATE) doubles
  the current pattern (DOUBLE_PATTERN): twice the length (at most 512 steps; at 512, or for patterns from
  128 up, the tab is faint, the LED off and the button does nothing) and the step sequencer's steps of every
  channel, with their step parameters, copied into the new half. Notes drawn in the piano roll cannot be
  read by a script, so they are not doubled; the left screen shows a read-out card for 4 s: `DOUBLE`,
  `16 -> 32 steps` and `notes copied`. One undo point. The FL script uses FL's hidden
  `patterns.duplicatePatternData(pattern)`, which copies every note including piano roll notes
  (confirmed on the owner's try), then sets the length to exactly twice the old one (the function
  alone leaves it at what the content spans); without that function it copies the steps.
- Display 4 `DUPLICATE` (left screen, column 4) clones the current pattern (CLONE_PATTERN) and
  display 5 `CREATE` (right screen, column 1) makes a new empty one (NEW_PATTERN); FL selects the
  new pattern and the overlay turns to its bank. FL's API has no pattern delete, so there is no
  `DELETE` tab (docs/workflow.md, "Hard to map").
- A pad with no pattern behind it (a free slot, as Maschine shows one) is lit dim white and the grid shows
  its number with `+`: pressing it creates that pattern and selects it (CREATE_PATTERN: `jumpToPattern(k)`,
  else `findFirstNextEmptyPat`; the script's PROBE line says which pattern number it got). ERASE + pad and the
  DUPLICATE overlay's pads (empty ones stay off and do nothing) keep their meaning.
- Left screen: pin tab `PATTERN` (lit when pinned), the current pattern's number and name big in its
  color, its length in steps, and the knob row under it (COLOR and LENGTH). Right screen: a 4×4 grid that
  mirrors the pads (number, name, color stripe, the current pattern outlined in orange) and the bank
  text `1–16 of 20`.
- **Knobs** (Maschine's pattern page, `PatternPageStudioPattern.lua`: POSITION, –, START, LENGTH; FL has
  no pattern position or start offset, so knobs 2 and 3 are empty and fall through to the page below;
  knob 1 is `COLOR`). One page: the arrow buttons are not the overlay's (they do what the page below
  makes of them).
  - **Knob 4 `LENGTH`** (left screen, column 4) = the length of the current pattern: one detent
    (120 counts) = the next or previous common length: 16, 32, 64, 128, 256, 512 steps (1, 2, 4, 8, 16, 32
    bars); from a length that is not on the list the first detent snaps to the nearest list value in that
    direction, and the ends stay put. SHIFT = fine, ±1 step, from 1 to 512. Each change sends
    SET_PATTERN_LENGTH (`patterns.setPatternLength`, in steps: verified in FL 2026, docs/fl-ilmcp.md) and the
    script answers with a PROBE line (`setPatternLength(3, 32) -> getPatternLength(3) = 32`, logged as
    `← FL probe: …`). The shown value is ours for 300 ms after a turn
    (the pending-value pattern), then FL's. The knob reads `2 bars`, `1 bar 4 steps` or `6 steps`.
    Patterns 128 and up cannot be resized (the command's pattern is a `u7`; the page says so), and an
    FL without the function shows `n/a` and `Not available in this FL version` (FEATURES) and sends
    nothing.
  - **Knob 1 `COLOR`** (left screen, column 1) = the pattern's colour: one detent steps through
    twelve colours (Red … Grey, wrapping; a colour that is not on the list reads `Custom` and the first
    turn starts at the end of the list it turns towards), SET_PATTERN_COLOR (`patterns.setPatternColor`,
    documented; the script sends the wire's `0xRRGGBB` unchanged and a PROBE line shows what FL read
    back), pending for 300 ms like the length. The colour bar on the left screen shows it.
- The 4D encoder falls through to the page underneath; display 2 does nothing.

## Touch strip (PITCH, MOD, PERFORM, NOTES)

Code: `src/strip.ts` (`StripControl`); the page stack (`src/modes/pageStack.ts`) owns the four buttons,
their LEDs, the saved mode and the read-out; `main.ts` feeds the strip's reports (bytes 30–31 of the
input report, position 0–1024, 0 = no finger, ~11 ms apart; docs/protocol.md) to it. The buttons are a
radio group like VOLUME/SWING/TEMPO: a press picks the mode (bright, the others dim), a press on the lit
one leaves no mode (all dim). The mode is saved in `pages.json` (`stripMode`, default PITCH). It works
on every page. **SHIFT + strip does nothing yet** (a touch under SHIFT counts as no touch, and SHIFT
pressed mid-touch ends the effect); SHIFT + button does nothing either.

- **PITCH**: the selected channel's pitch, as STRIP `pitch` (docs/sysex.md; FL does not apply raw pitch
  bend from our port, so the script calls `channels.setChannelPitch`, which works for every generator):
  the centre is no bend (8192), the ends are full bend of the pitch range; on release the bend springs
  back (a release is always sent). Messages are coalesced to one per 15 ms while sliding. LEDs
  (Maschine's `updateLEDsPitchMode`): a bar from the centre LED to the finger in the selected channel's
  colour, the finger LED white; untouched only the centre LED, white.
- **MOD**: 0–127 from left to right; it stays where the finger left it, remembered per FL channel
  (Maschine's `getLastTouchstripValueForSound`): switching channels shows that channel's last value
  (nothing lit while it has none; nothing is sent on a switch). For a VST (PLUGIN `paramCount` >= 4224)
  it is STRIP `mod`, which the script writes to the wrapper's MIDI CC 1 parameter (4096 + 1); for any
  other plugin mk3d sends the raw CC 1 on MIDI channel 1 as before. LEDs: a bar from the left to the
  value in the channel colour, the value LED white.
- **PERFORM** (Maschine's perform FX; FL has none per channel): a momentary **filter sweep** as STRIP
  `perform`: the script finds the plugin's filter cutoff parameter (once per plugin, from the parameter
  names: `cutoff`, or `freq` with `vcf`/`filter`/`flt`; Diva: `VCF1: Frequency`; logged as a PROBE line),
  remembers its value at the first touch value, sets it from the position (left = closed, right = open)
  and restores the remembered value on the release, which mk3d also sends on a mode change, SHIFT, a
  page change, a channel change and a disconnect. Without such a parameter (FL's own instruments) the
  channel cutoff is swept instead. Nothing happens without a selected channel. LEDs: a bar from the
  left, white at the finger; untouched off.
- **NOTES**: the strip plays notes. In KEYBOARD and CHORDS: 2 octaves of the KEYBOARD scale from the
  base note (the CHORDS page's scale and the base note: Chromatic = 24 semitones, Major = 14 degrees)
  in equal zones, on MIDI channel 1. In PAD MODE: the 16 channels of the bank (MIDI channel 2, like the
  pads; a zone with no channel plays nothing; a touch also selects the channel). Touching plays the
  zone's note, velocity 100 or the FIXED VEL value while it is on; sliding into another zone ends the
  note and plays the new one; the release ends it. A note never hangs: it ends on a mode change, a page
  change (that touch then plays no more until the finger lifts), SHIFT, and a disconnect or shutdown.
  LEDs: the first LED of every zone dim in the channel colour, the playing zone bright, the finger white.
- **No mode**: the LEDs show the play position while FL plays (white bar from the left, off when
  stopped; Maschine's `updateLEDsPlayPositionMode`). Touches do nothing. `src/playPosition.ts`: the
  position is within the **current pattern** (steps modulo its length) in pattern mode, and within the
  **song loop** (LOOP_STATE) in song mode when one is active, else within the current pattern. SONG_POS
  comes about every 50 ms with 16 steps to the bar and 24 ticks to the step (PPQ 96), so the position is
  estimated between messages from the tempo and the time since the last one (as NOTE REPEAT does), held at
  the end of the range until the next message shows the wrap, and never steps back except at a wrap. A
  40 ms timer in `main.ts` redraws the LEDs only when the lit LED changes. (The old reading used the step
  alone, so it moved in jumps with the jitter of FL's service pass, and in song mode wrapped the absolute
  position by the pattern's length.)
- LEDs go through `palette.ts` (the channel colour, `bright`/`dim`, and white). The strip LEDs are only
  recomputed when something they show changed (the finger's LED, the zone, the value; the play position
  when its bar grows), not on every report.
- **Read-out**: no page of its own; the quick-edit card on the left screen, titled `TOUCH STRIP`, shows
  `PITCH +0.43`, `MOD 87`, `CUTOFF 62 %` or `NOTE D#4` (PAD MODE: `CHANNEL 5`) with the channel's name
  under it while touched and for 1 s after the release.
- FL side: pitch, mod (VST) and perform go to FL as the STRIP command (docs/sysex.md); `OnPitchBend`
  and `OnControlChange` still leave pitch bend and CC 1 on MIDI channel 1 unhandled for the raw CC 1
  of plugins without CC parameters. **Not verified in FL** until the owner tries it: `setChannelPitch`
  on VSTs, the CC parameter index 4097, the cutoff name match.

## Duplicate overlay (hold DUPLICATE)

Code: `src/modes/duplicateOverlay.ts`, built on the PATTERN overlay's bank (`PatternBankPage`).

- Pads 1–16 are the patterns of the current bank (VIEW `patternOffset`, the bank of the current
  pattern when it opens); a pad press clones that pattern (CLONE_PATTERN, 1-based). Display 7 and 8
  (`<<` `>>`) page between the banks. Pad LEDs and the grid are the PATTERN overlay's.
- Left screen: pin tab `DUPLICATE`, the current pattern, its length and the hint
  `press a pad to duplicate`. Display 2–6 do nothing.
- SHIFT + DUPLICATE clones the current pattern without the page (see "Pages").

## Mute overlay (hold MUTE)

- Pads 1–16 are the 16 channels of the current bank (VIEW `channelOffset` = the bank, patched into
  the main page's VIEW). A pad press toggles that channel's mute (SET_CHANNEL mute). Pad LEDs: the
  channel's color, bright = playing, dim = muted, off past the last channel. GROUP A–H pick the
  bank (they no longer toggle channels).
- Left screen: pin tab `MUTE`, the window text `1–16 of 20` and the number of muted channels. Right
  screen: the pad grid with channel names; muted ones are dimmed and struck through.
- Knobs, arrows and the 4D encoder fall through; display 2–8 do nothing.

## NOTE REPEAT (hold NOTE REPEAT)

Code: `src/modes/noteRepeatOverlay.ts` (the page) and `src/modes/repeatScheduler.ts` (the clock).
Display 1 is the pin tab `NOTE RPT`. In KEYBOARD and CHORDS the button opens the arpeggiator
instead ("ARP" below), as in Maschine; this part is PAD MODE's. While the overlay is
held or pinned, **held pads repeat** their note instead of playing once; releasing a pad ends its
repeats, closing (or unpinning, or another page replacing) the overlay ends them all, with every
note off sent. The pads keep their pad mode and send what a single hit sends, through `PadState`
(`startRepeat`, `soundRepeat`, `silenceRepeat`): KEYBOARD repeats `base + pad` on MIDI channel 1,
PAD MODE the pad's channel (MIDI channel 2, note = the channel's index; the first hit also selects
it). SHIFT + pad and ERASE + pad keep their actions, and the STEP page cannot be open under an
overlay, so nothing repeats there. GROUP A–H still pick the bank.

- **Rate**: display 2–4 (left screen) and 5–8 (right screen): `1/4` `1/8` `1/16` `1/32` `1/8T`
  `1/16T` `1/32T`, default `1/16`, the current one bright. Knob 1 steps through the same list
  (120 counts a step).
- **Gate** (knob 2): 10–100 % of the interval, default 50 %. **Swing** (knob 3): 0–50 %, delays every
  second repeat by that share of the interval, default 0. SHIFT = fine. Rate, gate and swing are
  saved with the pin states (`pages.noteRepeat` in `pages.json`; a rate change at once, knob turns
  400 ms after the last one or when the overlay closes).
- **Velocity**: the first note is the hit's velocity; later repeats use the pad's pressure as
  velocity (`round(pressure × 127)`, at least 1). No aftertouch is sent while repeating.
- **Timing**: interval = 60 / BPM × 4 / denominator (× 2/3 for triplets); BPM is `fl.tempo`, 120
  while it is 0. All held pads share one grid. The first note sounds at the press; a pad hit within
  a quarter interval before a slot waits for the next one. While FL plays, the grid is FL's: bar 1
  is the origin and the position is the last SONG_POS plus the time since it arrived (16 steps per
  bar, 24 ticks per step: NOT VERIFIED, with the other SONG_POS bases); a SONG_POS older than
  500 ms counts as stopped. While FL is stopped the grid runs free from the press. A tempo change
  moves the next slot without restarting the grid. One timer is set to the next due slot or note
  off (absolute times from `performance.now()`); a slot more than half an interval late is skipped,
  never played in a burst. Before each on, a note still sounding is ended.
- **Screens**: left, the pin tab, `Note Repeat`, the rate big, the tempo and whether the grid is
  FL's or free, and Rate / Gate / Swing under knobs 1–3; right, the rate tabs on display 5–8 and
  two beats of repeats (start and length of each note, odd repeats mint).
- **LEDs**: the NOTE REPEAT button bright while open, dim otherwise; display 1 bright when pinned;
  display 2–8 the current rate bright, the others dim. The pads are the pad mode's; a repeating pad
  is pressed while its note sounds, so it flashes with each repeat.
### ARP (NOTE REPEAT in KEYBOARD and CHORDS)

Code: `src/modes/arpPanel.ts` (controls, screens, LEDs), `src/modes/arpeggiator.ts` (the notes and
the engine), the clock is `repeatScheduler.ts`. Maschine's NOTE REPEAT button opens `ARP` instead of
`NOTE RPT` when the pads are in keyboard mode (RepeatPageStudio.lua); mk3d does the same for
KEYBOARD and CHORDS, in `NoteRepeatOverlay` (same overlay rules: hold to peek, pin tab, display
button 1). PAD MODE stays Note Repeat. If the pad mode changes while the overlay is open
(SHIFT + PAD MODE ...), what played stops and the other kind takes over. Software only: no FL script
change, nothing new to the MK3.

- **What plays**: the notes of the held pads, one at a time, on the shared repeat grid (tempo-locked,
  SONG_POS-aligned, free running while FL is stopped: exactly as Note Repeat; the engine is one
  "pad" of the `RepeatScheduler`). KEYBOARD = each held pad's note, CHORDS = every note of each held
  pad's chord (fixed when the pad is hit). The first note sounds at the press, the rest on the grid.
  A pad pressed or released changes the set from the next step on; the grid and the step counter go
  on. Notes go out as a hit's do (MIDI channel 1, to the selected channel) through `PadState`
  (`arpNotes`, `arpOn`, `arpOff`; a lost device ends them in `releaseAll`).
- **Type** (knob 1, 120 counts a step): `Up`, `Down`, `Up/Down` (1 2 3 2: the ends are not
  repeated), `Down/Up`, `Played` (press order), `Random` (never the same note twice in a row, unless
  it is the only one), `Chord` (all notes of the set together on every step). **Octaves** (knob 3,
  1–4, 200 counts a step) repeats the set an octave up per octave (a note above 127 is clamped and
  a duplicate sounds once; Chord plays the whole chord an octave higher on each round).
- **Rate** (knob 2): the seven rates of Note Repeat. **Gate** (knob 4): 10–100 %. **Swing**
  (knob 5, right screen, as Note Repeat's): 0–50 %. SHIFT = fine on Gate and Swing. Arp settings
  are separate from Note Repeat's and saved in its state (`pages.noteRepeat.arp`: type, rate,
  octaves, gate, swing, hold); Note Repeat's own are unchanged.
- **HOLD** (display 3, bright when on, persisted): released notes keep playing; the first press after
  all pads were released starts a new set (a pad pressed while another is still down joins the set).
  HOLD off drops the pads that are not down (an empty set stops, offs sent). Closing the overlay (or
  unpinning, another page replacing it, the device going away) stops everything, HOLD included; the
  HOLD setting itself stays. No note hangs: every on has its off (the notes of a step end at the
  gate or before the next step, and when the set empties).
- **Velocity**: the hit velocity of the pad that owns the note (a note two pads share belongs to the
  first pressed); FIXED VEL wins. Maschine's `Dynamic` is not built, nor are page 2 (Retrigger,
  Repeat, Offset, Inversion, Min/Max key), Sequence, Rate unit, LOCK (display 2) and GATE RESET
  (display 4): display 2 and 4 are empty.
- **Presets** (display 5–8): `UP 16TH` (Up, 1/16, 1 oct, 50 %), `DOWN 16TH`, `UP/DN 8TH` (Up/Down,
  1/8, 2 oct, 60 %), `RANDOM 16T` (Random, 1/16T, 2 oct, 40 %): they set Type, Rate, Octaves and
  Gate at once (Swing stays); bright while the current settings equal the preset.
- **Screens**: left, tab `ARP` (pin, underlined when pinned) and `HOLD` (underlined when on),
  `Arpeggiator`, `Up · 1/16` big, the tempo line and Type / Rate / Octaves / Gate under knobs 1–4.
  Right, the preset tabs, `Sequence`: one round as note names (`C3 D#3 G3 ...`, up to 3 rows, then
  `+n more`) with the step that played last highlighted (empty: `Hold keys to arpeggiate`), and
  Swing under knob 5.
- **LEDs**: the NOTE REPEAT button bright while open; display 1 bright when pinned; display 3 bright
  with HOLD; display 5–8 the matching preset bright; display 2 and 4 off. Pads as in the pad mode;
  a pad whose note plays is pressed (flashes with each step; in CHORDS the pad of the chord the
  note belongs to), a pad HOLD keeps is bright between its flashes.

- `Mode.leave()` is new: the stack calls it when a page on top is closed, replaced or the device
  goes away. `Mode.persisted` lets a page save settings with the stack's state.

## Layout rule

Display buttons 1–4 sit above the left screen and 5–8 above the right one; knobs 1–4 sit below the
left screen and 5–8 below the right one. Every screen is 4 columns of 120 px, and what a control
does is drawn on the screen it belongs to, in the column right above or below it: button labels
as tabs along the top edge, knob labels and values along the bottom. A touched knob highlights
its column and shows its name and value large on that same screen.

## Channel mode

Left screen (display buttons 1–4 above, knob 1 below):

- Tabs: _Mute_, _Solo_, _Editor_ and an empty one. _Mute_ and _Solo_ are lit while on for the
  selected channel; _Editor_ has no state.
- Middle: the 16-channel window (page text `1–16 of 20` under the list), the selected channel
  highlighted, muted channels dimmed. The color stripe is the channel's color and the number on
  the right is the channel number. The list scrolls to keep the selection in view.
- Bottom: knob 1 _Channel_ with the selected channel's number and name; columns 2–4 are empty.

Right screen (display buttons 5–8 above, knobs 5–8 below):

- Tabs: none (display buttons 5–8 are unused and their LEDs off).
- Top of the middle: the transport bar (position, BPM, metronome). Below it the selected channel's
  name big in its color, its plug-in (or "Sampler") and its mixer track.
- Bottom: knobs 5–8 _Volume_, _Pan_, _Pitch_ and _Mixer_ (the mixer track).

Display button LEDs: dim when the button has a function, bright when it is on (Mute or Solo of the
selected channel), off when unused (display 4–8, and 1–3 without a channel).

| Control                 | Action                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Display 1               | Toggle mute of the selected channel                                                           |
| Display 2               | Toggle solo of the selected channel                                                           |
| Display 3               | Show the channel's editor (plug-in or sampler window)                                         |
| Knob 1                  | Previous/next channel, one per 40 counts (the remainder carries over, so slow turns work)     |
| Knob 5                  | Volume (%)                                                                                    |
| Knob 6                  | Pan (`C`, `L40`, `R40`)                                                                       |
| Knob 7                  | Pitch (semitones: the knob's −1…1 times the channel's pitch range)                            |
| Knob 8                  | Mixer track the channel is routed to (`Master`, the track's name or `Insert N`)               |
| Knobs 2–4, display 4–8  | Unused                                                                                        |
| 4D encoder turn         | Previous/next channel; the window moves a page when the selection leaves it                   |
| 4D encoder tilt up/down | Previous/next channel (left/right unused)                                                     |
| 4D encoder push         | Show the channel's editor                                                                     |
| Arrow left/right        | Previous/next page of 16 channels                                                             |
| Group A–H               | Pick the channel bank (page stack, "Channel banks"); the list follows the selection           |

Knob behavior:

- Volume, pan and pitch (knobs 5–7) move `1/1200` of their range per count (a full turn
  is 1000 counts), so about 1.2 turns cover the range. Shift divides that by 10. The value
  is clamped to its range and sent to FL as an absolute value.
- For 300 ms after the last turn the value on screen and the base of the next turn are ours, not
  FL's, so a fast turn doesn't jump back while FL catches up.
- The mixer track moves one step per 30 counts, between 0 and the last mixer track.
- Knobs only act on the channel FL reports as selected. If you just changed channel and FL hasn't
  confirmed yet, the turn is dropped.
- If you select a channel in FL that is outside the window, the window jumps to its page. Paging
  with the arrows does not move the selection.

Notes:

- Mute and Solo (display 1 and 2) read FL's flags in CHANNELS (`isChannelMuted`,
  `isChannelSolo`), so a solo set or cleared in FL shows on the tab and the LED too. Display 2
  sends the opposite of FL's flag.
- Editor follows selection (FL script): when a generator plug-in window is focused and belongs to
  the selected channel, selecting another channel (knob 1, 4D encoder) opens and focuses that
  channel's editor, and closes the old one if the script itself opened it. A window the script saw
  open (focused earlier, or opened with Editor) is left open. FL cannot report which editors are
  open, so a window you close with the mouse can stay in the script's list until the channel count
  changes or mk3d reconnects. Nothing happens while the mixer or another window is focused.
- Channel mode sends VIEW with `mixerOffset 0`, `patternOffset 0`, `stepOffset 0`, no meters and
  plug-in params 0–7 (`channelOffset` is the first channel of the window).

## Plugin mode

Drives the selected channel's own plug-in (u-he Diva, ...) through FL's parameter list, so the
plug-in's GUI knobs move. The pages come from a `PageSource` (`src/modes/pluginPages.ts`);
`FlParamPages` builds them from FL's parameter names, NKS pages can follow. Parameters with an
empty name are skipped, page _n_ is the next 8 named parameters. A page is named after the prefix
before `": "` that all its names share (VST3 names look like `Filter: Cutoff`), else _Page n_;
knob labels drop that prefix. Without a prefix in common the knob shows its full name.

Left screen (display buttons 1–4 above, knobs 1–4 below):

- Tabs: the names of pages 1–4 of the current bank of 8 pages; the current page is lit.
- Middle: the plug-in's name big, the channel's name in its color and `page x / y`.
- Bottom: knobs 1–4 of the current page: label, arc and FL's value text.

Right screen (display buttons 5–8 above, knobs 5–8 below):

- Tabs: the names of pages 5–8 of the current bank; the current page is lit.
- Top of the middle: the transport bar. Below it the current page's name big.
- Bottom: knobs 5–8 of the current page.

A touched knob highlights its column and shows its full parameter name and value large in the
middle of its own screen. Without a valid plug-in on the selected channel both screens say
_No plugin on <channel name>_ and the knobs do nothing.

Display button LEDs: dim when the page exists, bright for the current page, off otherwise. Arrow
LEDs: dim when there is a page in that direction. Mute is unused (off); the group buttons are the channel banks (lit by the page stack).

| Control          | Action                                                                    |
| ---------------- | ------------------------------------------------------------------------- |
| Display 1–8      | Jump to the page in that tab (page `bank × 8 + n`)                        |
| Arrow left/right | Previous/next page; the bank of tabs follows                              |
| Knob 1–8         | Parameter 1–8 of the current page (`setParam`). Unused columns do nothing |

Knob behavior:

- A knob moves its parameter `1/1200` of the range per count, Shift divides that by 10; the value
  is clamped to 0…1 and sent to FL as an absolute value.
- For 300 ms after the last turn the value on screen and the base of the next turn are ours, not
  FL's (same as Channel mode). A turn is dropped until FL has reported the parameter once.
- Whether `plugins.setParamValue` also moves the plug-in's own GUI knob is up to FL's VST host
  (not yet seen on hardware).

Notes:

- On entering, on a page change and when the plug-in's names arrive or change, the mode sends VIEW
  with the current page's parameter indexes (fewer than 8 on a short page), `mixerOffset 0`,
  `patternOffset 0`, `stepOffset 0`, no meters, and the channel window of the selected channel's
  page of 16 (same as Channel mode). VIEW is only resent when it differs from the last one.
- The page resets to 1 when the plug-in (channel or name) changes. FL sends the names of all
  parameters in PARAM_NAMES (`docs/sysex.md`) when the plug-in changes; until they have arrived the
  pages are incomplete.

## Mixer page (MIXER)

A main page (`src/modes/mixerMode.ts`; drawing in `src/render/mixerStrip.ts`): Maschine's mixer
with FL's data, in FL's mixer look (`docs/design.md`, "Mixer strip"). MIXER again goes back to the
last control page. Pads are not used (they play as the pad mode says).

- **Banks of 8 tracks**: track 0 is Master, then Insert 1…; bank _n_ is tracks 8n…8n+7. VIEW
  `mixerOffset` = the bank's first track and `meters` on while the page is shown (the channel
  window follows the selected channel's page, as on the other pages). On entering, the bank of
  FL's selected track; a selection made in FL moves the bank, paging with the arrows does not
  move the selection. Arrow LEDs: dim when that bank exists, else off.
- **Strips**: the 8 columns (4 per screen) are the 8 tracks. Display buttons 1–8 and GROUP A–H
  select track 1–8 of the bank (SELECT_TRACK).
- **Knobs 1–8**: volume of track 1–8 of the bank (SET_TRACK volume), or pan. A **push of the 4D
  encoder** toggles volume and pan for all knobs (`VOL` / `PAN` on the strips). Same step as the
  other pages (`1/1200` of the range per count, Shift a tenth), and the same 300 ms pending
  value so a fast turn does not jump back while FL catches up. A track FL has not reported yet,
  or past the last track, is ignored.
- **4D turn**: volume (or pan) of the selected track, `1/100` per detent (Shift a tenth).
  **4D tilt ◀ ▶**: previous/next track; the bank moves when the selection leaves it. Tilt up
  and down are not used.
- **MUTE / SOLO held**: the page claims both buttons (see "Claimed buttons"), so no overlay opens.
  While MUTE (or SOLO) is held, the display and group buttons toggle mute (solo) of that strip
  (SET_TRACK mute/solo) instead of selecting it; MUTE wins if both are held. The toggle reads
  FL's state, or the value we set ourselves for 300 ms, so a quick second press undoes the first.
- **Touching a knob** highlights that strip (raised card, mint outline) and shows the value big
  on the strip, on the screen the knob belongs to, on the half of the body the fader cap is not in.

LEDs: display buttons bright for the selected track, dim for the other tracks, off past the last
one. GROUP A–H in the track's color, bright for the selected track, dim for the others, off past
the last. While MUTE (SOLO) is held, both rows show that state instead: bright = muted (solo).
MUTE and SOLO are bright while held, else dim.

Screens, per strip (120 px column, 112 px `panel` card, 4 px gutters):

- Tab bar: the display-button labels are the track numbers (`M` for Master); the selected
  track's number is boxed in orange.
- Top of the card: a thin bar in the track's FL color, the round mute LED (green `ledOn` =
  playing, dark `ledOff` = muted), an orange `S` badge left of it for solo and a red dot right of
  it for armed.
- Body: the track name rotated 90° on the left (bright and bold when selected), a stereo peak
  meter of two segmented bars (3 px cells, 1 px gaps; green, yellow from −18 dB, orange from
  −6 dB; a peak-hold tick that holds 0.7 s and then falls), and the fader: a grey cap at the
  volume's height (FL's normalized volume, linear, 0.8 = 0 dB with a small tick on both sides),
  mint cap and a mint line along the slot for the selected track. Master also gets dB marks
  beside its meter (6, 3, 0, then 6, 12, 24, 36, 48 below, unsigned as in FL).
- Meter scale: FL's peak is linear 0–1 (`docs/sysex.md`); the bars show it in dB, −60 dB at the
  bottom to 0 dB at the fader's 0 dB tick (so the two line up) and on to +6 dB at the top. FL
  sends the peak clamped to 1.0 (0 dB), so the part above the tick stays empty.
- Knob row at the bottom, right above the knobs: `VOL` or `PAN` and the value, volume as a
  percentage of FL's normalized value and pan as `C`, `L30`, `R20`.
- Strips past the last track are empty panels. There is no transport bar on this page.

TODO: the volume is shown as a percentage of FL's normalized value because FL's own dB text is
not in the protocol yet (it would come from `mixer.getEventValueString` in the FL script, as a
new field in MIXER or a `MIXER_TEXT` message).

## Quick edit (VOLUME, SWING, TEMPO)

Code: `src/modes/quickEdit.ts`, run by the page stack so every page gets it. The three buttons are a
radio group: a press turns that mode on (LED bright, the other two dim), a press on the lit one turns
it off. SHIFT + the button does nothing. While a mode is on, **4D turns** edit its value instead of
reaching the page (push and tilt still go to the page); a turn is 1/100 (volume, swing) or ±1 BPM /
semitone, SHIFT 1/1000 and ±0.01.

| Mode   | Nothing held                                 | While a pad is held                                         |
| ------ | -------------------------------------------- | ----------------------------------------------------------- |
| VOLUME | FL's main volume (SET_MAIN_VOLUME)           | the channel's volume (SET_CHANNEL)                          |
| SWING  | main swing (SET_SWING)                       | the same                                                    |
| TEMPO  | tempo (SET_TEMPO, 10–522 BPM)                | the channel's pitch (`TUNE`, SET_CHANNEL pitch, ± its range) |

The held pad's channel is the one the pad plays in PAD MODE, else the selected channel. Values use
the pending-value pattern (ours for 300 ms after a turn, then FL's).

VOLUME without a pad edits what FL calls the **main volume** (`REC_MainVol`, the toolbar knob), not
the Master mixer fader. It arrives in TRANSPORT (`norm mainVolume`, after the swing) and is written
with SET_MAIN_VOLUME. It is shown as the percentage of its normalized value (FL's own hint may show
another scale). A script that doesn't send it leaves the value unknown: a turn does nothing and no
read-out shows until it arrives.

**Read-out**: a card over the middle of the left screen (under the tabs, above the knob labels):
the level (`MAIN` or the channel's name), the mode (`VOLUME`, `SWING`, `TEMPO`, `TUNE`), the value
big (`78 %`, `26 %`, `120.00 BPM`, `+3.00 st`) and a bar. Shown while a mode is on and the 4D was
turned in the last 2 s, or while a pad is held.

## SHIFT + pads

Code: `src/modes/shiftPads.ts`, run by the page stack. While SHIFT is held the pads don't play and
no page gets them: they are Maschine's action row (pad 1 bottom-left).

| Pad | Action                                  | Pad | Action                                           |
| --- | --------------------------------------- | --- | ------------------------------------------------ |
| 1   | undo (UI)                               | 9   | clear: CLEAR_STEPS, selected channel             |
| 2   | redo (UI)                               | 10  | clear automation (no FL equivalent)              |
| 3   | step undo (no FL equivalent)            | 11  | copy: the step clipboard (UI 10)                 |
| 4   | step redo (no FL equivalent)            | 12  | paste: the step clipboard (UI 11)                |
| 5   | quantize (UI, `quickQuantize(…, 0)`)    | 13  | transpose −1 semitone (TRANSPOSE)                |
| 6   | quantize starts (UI, `…, 1`)            | 14  | transpose +1 semitone                            |
| 7   | nudge ◀ (no FL equivalent)              | 15  | transpose −12 (octave)                           |
| 8   | nudge ▶ (no FL equivalent)              | 16  | transpose +12 (octave)                           |

13–16 transpose the selected channel's recorded notes in the current pattern (TRANSPOSE, docs/sysex.md), in every
pad mode; the KEYBOARD base note keeps its own controls (display buttons 5–8). The FL script rewrites the pitch of
every step that is on. **Known bug:** FL reports piano roll notes as grid bits too, so on a piano roll channel this
moves one note per step position and can split chords (owner, 2026-10-19). FL's API cannot select or move piano roll
notes, and the piano roll's arrow keys only scroll with nothing selected (tried, reverted). Read-out card: `TRANSPOSE`, `+1 st` / `−12 st`, the channel's
name. LEDs while SHIFT is held: available
actions dim white, the pressed one bright white, unavailable ones off (the no-FL pads, quantize and
clear and transpose without a selected channel). A pad held before SHIFT still
ends its note. A page can claim the pads under SHIFT (`usesShiftPads`): GRID does.

**Copy and paste are a step clipboard in the FL script**, not `ui.copy/paste` (those act on whatever
window has the focus, so nothing visible happened). Copy stores the selected channel's steps of the
current pattern (one flag per step of the pattern's length) in the script; paste writes them into the
selected channel of the current pattern, up to the shorter of the two lengths, after one undo point;
steps beyond the clipboard are left alone. Cut (UI 9, no pad) is copy + clear as one undo point. The
clipboard lives until the script is reloaded. Clear and paste save one undo point (`general.saveUndo`,
`MK3: clear steps` / `MK3: paste steps`) before changing anything and send the grid once afterwards,
so undo steps over the whole edit.

**Feedback**: every action that ran shows a card for 1.5 s in the quick-edit read-out area of the left
screen (a turn of the 4D or a quick-edit button replaces it) and is logged (`→ FL undo`, `→ FL clear
steps (Kick)` …). The card has the action big (`UNDO`, `REDO`, `CLEAR`, `COPY`, `PASTE`, `QUANTIZE`,
`QUANT. STARTS`, `TRANSPOSE`) and a detail line: the channel's name for clear, paste and
quantize, `64 steps of Kick` for copy, `+12 st` / `−1 st` for transpose (the channel's name small above it), and for
undo/redo FL's undo hint with `position / count` small (from UNDO_STATE, so it fills in a moment after
the press). An action that cannot run shows nothing. Each action runs once per pad press, on the
pad's down; the pressure re-reports while the pad is held do nothing.

## NAVIGATE (hold SHIFT + VARIATION)

Code: `src/modes/navigateOverlay.ts`. Display 1 is the pin tab `NAVIGATE`. Display 2–6 show the
Mixer, Channel rack, Playlist, Piano roll and Browser (SHOW_WINDOW 0–4: a focused window is hidden
instead), display 7 `PLUGIN` opens the selected channel's plug-in window (SHOW_EDITOR). **4D tilt**
= FL's up/down/left/right and **push** = enter (UI actions); the turn goes on to the page or the
quick edit.

- LEDs (from UI_STATE): bright = focused, dim = shown, off = hidden; PLUGIN bright while a plug-in
  window has the focus, dim with a selected channel.
- Left screen: tabs `NAVIGATE` `MIXER` `RACK` `PLAYLIST`; the title and the focused window in the
  first column, a tile with a small drawing of each of the first three windows under its button.
  Right screen: tabs `PIANO` `BROWSER` `PLUGIN`, their tiles, and a key for the tiles' look
  (focused: orange outline, shown, hidden: dark).

## LOOP (hold SHIFT + RESTART)

Code: `src/modes/loopOverlay.ts` (built on `MarkerPadsPage`, like SCENE). The **song loop** is FL's
playlist time selection (`arrangement.selectionSet(start, end)` in ticks, `selectionClear()`,
`selectionIsActive()`; hidden functions, NOT VERIFIED: docs/fl-ilmcp.md). Positions are worked out in
steps (16th notes, 4 beats a bar) from bar 1 and sent as ticks (`fl.ppq` ticks a beat).

- **SHIFT + tap RESTART** (released before 400 ms): loop on or off, no page; the card
  `LOOP ON bar 5 – bar 9` / `LOOP OFF` shows on the left screen. Off = `selectionClear`; on = the
  remembered range: the last loop mk3d set or saw switched off (saved with the page state in
  `pages.json`), else the current marker's section when there are markers, else the first four bars.
  A plain tap is still restart, and so is any press while FL isn't connected or SHIFT is up.
- **SHIFT + hold RESTART** (400 ms, `HOLD_MS`) opens the overlay; release closes it unless pinned
  (display 1 `LOOP` is the pin tab). Pads keep working under SHIFT (`usesShiftPads`). Release SHIFT
  while holding RESTART to turn in bars; with SHIFT down knobs and the 4D encoder work in steps.
- **Knob 1 `Start`** = the loop's start in bars (the loop moves, its length stays), **knob 2 `Length`**
  = its length in bars; one detent (120 counts) = 1 bar, SHIFT = 1 step. **4D turn** moves the whole
  loop by a bar (SHIFT: a step); **tilt ◀ ▶** (Maschine's PREV/NEXT) picks the start or the end for
  the turn, the same tilt again gives the whole loop back. The loop is at least a step long, starts
  at bar 1 or later and ends within 256 bars. Any change turns the loop on and is pending (ours) for
  300 ms before FL's answer shows.
- **Display 2** `ON` / `OFF` (lit while the loop is active) toggles the loop; **display 3** `CLEAR`
  clears it and forgets the remembered range.
- **Pads** are the playlist's markers, banks with display 7 and 8 (`<<` `>>`), as in SCENE: a press
  sets the loop to that marker's section (up to the next marker, four bars for the last one; none
  for a marker whose time is unknown). The pad of the looped marker is bright, the others dim.
- Left screen: pin tab `LOOP`, `ON`/`OFF`, `CLEAR`; the range big (`bar 5 – bar 9`, `5.3` for a
  position off the bar line), the length (`4 bars`), what the 4D turn moves, the knob row. Right
  screen: the marker grid with the looped section outlined in mint, or without markers a bar ruler
  (16 bars or more from the loop's start, the loop filled in orange).
- FL without the functions (FEATURES): the page says `Not available in this FL version` and nothing
  is sent. After every SET_LOOP the script reads back and sends a PROBE line (`selectionSet(0, 1536)
  -> active=1 start=0 end=1536`), logged `← FL probe: …`, so the first try shows the units.
- RESTART's LED: dim, bright while LOOP_STATE says a loop is active.

## GRID (hold SHIFT + FOLLOW)

Code: `src/modes/gridOverlay.ts`. FOLLOW alone keeps its STEP-page meaning. Display 1 is the pin tab
`GRID`. The pads are FL's snap values, a press sets one (SET_SNAP): Line 0, Cell 1, None 3,
1/6 step 4, 1/4 step 5, 1/3 step 6, 1/2 step 7, Step 8, 1/6 beat 9, 1/4 beat 10, 1/3 beat 11,
1/2 beat 12, Beat 13, Bar 14, Events 16, Markers 17 (the stub's Bar/Events/Markers clash with the
bar fractions: NOT VERIFIED). The pads keep working under SHIFT, which is usually still down from
opening it. LEDs: the current snap bright white, the others dim white. Left screen: the current
snap's name big; right screen: a 4×4 grid of the names that mirrors the pads, the current one
outlined.

## BROWSER (main page, BROWSER)

**Sources.** The left screen's display buttons 1-2 choose where the page gets its list from: display 1
`PRESETS` (the page described below, the default each time the page opens) and display 2 `PLUG-INS` = **FL's
Plugin picker** (Generators and Effects, category tabs at the bottom; **verified** in FL 2026, docs/fl-ilmcp.md
"Plugin loader trial"). Display 3 has no source (no label, LED off). The VIEW has the `presets` flag only on
`PRESETS`.

- **PLUG-INS**: display 2 sends BROWSE 8 `pluginPicker` (`globalTransport(FPT_F8, 1)`, a toggle) and mk3d
  remembers `pickerOpen`; display 2 again while open closes it. While it is open: **4D turn** = UI_KEY down / up
  (one per detent, at most ~15 per second), **4D tilt** up / down = up / down and left / right = left / right
  (the category page), **4D push** = UI_KEY enter, which adds the highlighted plugin as a **new channel**;
  display 8 `CLOSE` = BROWSE 8 again. FL gives nothing about the highlighted plugin, so mk3d cannot show its
  name: the user looks at FL's screen. After the push mk3d assumes FL closed the picker (`pickerOpen` off),
  goes back to `PRESETS` (the new channel is FL's selected one, so the list follows it) and, when FL's
  channel count grows within ~3 s, shows the read-out card `ADDED` / the new channel's name.
  Left screen: `PLUG-IN PICKER` and the help (`Turn 4D: browse`, `Tilt 4D < >: category`, `Push 4D: add as new
  channel`, `Shown in FL Studio`); closed: `PUSH PLUG-INS (display 2) TO OPEN FL'S PLUGIN PICKER`. Right
  screen: tab `CLOSE` on display 8, the selected channel and the channel count.
- Leaving the page (or going back to `PRESETS`) while the picker is open sends UI_KEY escape (closes it
  without adding anything). Nothing else changes in FL on leaving.

Code: `src/modes/browserPage.ts`. Maschine's browser, here the selected channel's **plugin presets**:
turn to choose, push to load. A **cursor** (the highlighted row) is separate from the **loaded**
preset.

- **4D turn** (one detent = one row), **4D tilt up/down** and **knobs 5 and 8** (under the list, one detent
  per 120 counts) move the cursor without loading anything; the list scrolls to keep it visible. The cursor
  stops at both ends of the bank. When the list moves beyond the names mk3d has, it asks FL for the
  next ones (PRESET_WINDOW; names already sent are remembered).
- **4D push** and **display 8 `LOAD`** (dim while the cursor is on another preset than the loaded
  one, off otherwise) load the cursor's preset (PRESET_LOAD: the script steps `nextPreset` / `prevPreset` the
  short way round). A cursor on the loaded preset does nothing.
- **Display 5 `PREV` and 6 `NEXT`** load the previous or next preset at once (PRESET_STEP, wrapping)
  and move the cursor with it; pressed quickly they build on the preset being loaded, not on what FL has
  reported so far.
- Every load shows the SHIFT + pad read-out card: `LOADED`, the preset's name, small line `BROWSER`.
- The pads, GROUP A–H and the other knobs work as on any page (the pads play, to audition).
  FL's API has no "add plugin" call; new instruments go through FL's Plugin picker (PLUG-INS, above).
- **VIEW**: the page's VIEW has the `presets` flag (bit 2), no other page's does, so FL's script reads
  and sends presets only while BROWSER is shown (also under a held overlay). It sends the VIEW again
  when the selected channel changes (FL answers with PRESETS: the count, the current index and 8
  names). The cursor starts on the loaded preset and goes back to it when the channel, plugin or bank
  changes.
- Left screen: the plugin and channel (`Sampler · Channel 3`), `LOADED` small and the loaded preset's
  name big in orange, `18 / 128` under it. When the cursor is elsewhere: `PUSH 4D TO LOAD` and the
  cursor's name and number. When the current preset is unknown: `–` and `Current preset unknown —
  PREV/NEXT steps from FL's current one` (then the cursor can still browse).
- Right screen: tabs `PREV` `NEXT` over display 5 and 6 and `LOAD` over display 8; 7 rows (`listing()` in the page: index, name,
  `cursor`, `loaded`): the cursor row is a filled bar in FL's selected colour (mint) with dark text, the
  loaded row has orange text and a `▶` marker (both on one row: bar and dark marker); a scroll bar on the
  right edge shows the window's place in the bank, with an orange tick where the loaded preset is. Under
  the list, over knobs 5 and 8 (right screen, first and fourth column): `SCROLL` and the cursor's
  `n / count`. Rows whose
  names FL has not sent yet show `…`.
- **Notices** (left screen, no tabs on the right): `No presets for <plugin>` (count 0, or a plugin
  without programs), `No presets for this channel` (no plugin), `No channel selected`, and
  `Reading presets…` until the first PRESETS arrives.
- LEDs: display 5 and 6 dim while there are presets, 4D tilt up/down dim orange (left/right off), the
  rest off.
- NOT VERIFIED (docs/sysex.md): how `FPN_Patch` / `FPN_Preset` / `getPresetCount` behave for VST,
  VST3 and FL's own plugins (for Diva the channel's name, not `FPN_Patch`, is the preset's name, so
  the script matches that too), whether a step wraps around at the ends, and how well PRESET_LOAD
  (2 steps per service pass) holds up with slow VST program changes.

## FILE (tool page, FILE)

Code: `src/modes/filePage.ts`. Latched: FILE opens it, FILE again leaves it (SHIFT + FILE saves, above).
Display 1 is the tab `FILE` (always bright), **2 `SAVE`** (UI `save`, FPT_Save), **3 `NEW VER`**
(UI `saveNew`, FPT_SaveNew), **5 `UNDO`** and **6 `REDO`** (UI `undo`/`redo`, the same as SHIFT + pad 1
and 2). Every press shows the SHIFT + pad read-out card (`SAVED`, `NEW VERSION`, `UNDO`, `REDO`; small
line `FILE`; undo and redo with FL's hint and `position / count`) and is logged (`→ FL save project`,
`→ FL save new version`, `→ FL undo`, `→ FL redo`). Left screen: tabs `FILE` `SAVE` `NEW VER`, FL's
undo state (`position / count` and the hint) and the last action done on the page. Right screen: tabs
`UNDO` `REDO` and the undo hint, big. LEDs: display 1 bright, 2, 3, 5 and 6 dim.

## SETTINGS and FIXED VEL (tool page SETTINGS, button FIXED VEL)

Code: `src/modes/settingsPage.ts`, `src/modes/padSettings.ts`. mk3d's own settings, saved in
`pages.json` under `pages.settings` (`fullScale`, `exponent`, `fixedVelocity`, `fixedOn`; a knob turn
400 ms after the last one, or when the page closes).

- **Knob 1 = full scale**: the pad hit value (0–4095) that gives velocity 127 (300–4095, default 3600).
  **Knob 2 = curve**: the exponent in `velocity = (hit / fullScale) ^ exponent` (0.25–2, default 0.6;
  below 1 makes soft hits louder). **Knob 3 = fixed velocity value** (1–127, default 100). SHIFT =
  fine; a slow turn adds up. The pad processor reads the very same `PadConfig` object, so a change
  counts from the next hit; at start-up the saved values are used, and `--velocity-full` /
  `--velocity-curve` win over them.
- Left screen: tab `SETTINGS`, a graph of the velocity curve of the current settings (hit value on x,
  velocity 1–127 on y; with FIXED VEL on the curve is dimmed and the fixed line is drawn in mint), and
  Full scale / Curve / Fixed vel under knobs 1–3 (columns 1–3). Right screen: the three values as text.
- **FIXED VEL** (button): fixed velocity on or off, bright while on. While it is on, **every pad note**
  (KEYBOARD, PAD MODE and NOTE REPEAT, the first note and every repeat) goes out with the fixed value
  instead of the hit's or the pressure's: `PadState` applies it where it sends a note on. The press
  shows a card (`FIXED VEL ON` with the value, `FIXED VEL OFF`; small line `PAD VELOCITY`), is logged
  and saved. SHIFT + FIXED VEL (16 velocities) is not built.

## ARRANGER (main page, ARRANGER) and SCENE (hold SCENE)

### ARRANGER: the pattern overview

Code: `src/modes/arrangerPage.ts`. FL's script cannot see the playlist's clips or the piano roll's notes
(the 2026-10-18 playlist probe, docs/workflow.md), so ARRANGER shows what it can read, like Maschine's
pattern view: **sounds × steps** of the current pattern. The grid comes from PATTERN_GRID (docs/sysex.md,
"Pattern overview"). ARRANGER is a main page (LED bright when shown; a second press goes home, like MIXER).
Opening it shows and focuses FL's playlist (SHOW_WINDOW 2, unless it has the focus already; see "FL's windows follow the page buttons"). FL's
Performance mode, which would show the clips, has no script API; it is a later option.

- **VIEW**: `patternGrid` on (flag 4, no other page has it), `channelOffset` = the bank of the row
  cursor, `stepOffset` = step page × 16 (the script sends that page first), `patternOffset` = the pattern
  bank of the pads; meters and presets off. Under an overlay the main page's VIEW stays.
- **Right screen**: up to 8 channel rows × 16 steps of the current step page. A step is on in the channel's
  color; off in FL's dark step colors, alternating every 4 steps as on the STEP page; the play head's column
  is lit white over every row; steps past the pattern's end are blank; the row cursor is outlined in orange.
  A channel whose PATTERN_GRID flag says it has no step row shows `piano roll`, dimmed, across the row (only
  when FL says so; unknown shows steps). Above the rows the step numbers (`1 5 9 13`), under them the footer
  `steps 17–32 of 64` (a pattern over 256 steps shows `of 256+`: the script sends 256). Tabs: 5 `PREV PAT`
  and 6 `NEXT PAT` (select the pattern before / after; the LED is off at the ends), 7 `<<` and 8 `>>`
  (step page; dark at the ends). The knob row at the bottom has `Rows` (knob 5, `12/24` = the cursor's
  channel of all) and `Steps` (knob 6, `2/4` = page of pages) in the first two columns.
- **Left screen**, the same rows in the same lines: color bar, channel number, name (dim when muted, an `S`
  in FL's solo red when soloed), the cursor row highlighted and outlined. Above the rows the pattern's number,
  name, color and length; under them `Group A   1–16 of 24`. Tabs: 1 `ARRANGER` (title), 2 `SONG` (bright in
  song mode; press toggles pattern/song, SET_LOOP_MODE); 3 and 4 are empty. The left knobs are empty.
- **4D encoder**: a turn moves the row cursor through the bank's 16 channels (the 8 rows scroll to keep it
  in view; it stops at the ends of the bank), a push selects the cursor's channel in FL (SELECT_CHANNEL),
  tilt ◀ ▶ pages the steps. **Knob 5** moves the row cursor too (one detent of 120 counts = one row),
  **knob 6** pages the steps. **GROUP A–H** pick the bank as on every page: the stack selects a channel
  there and the cursor follows FL's selection (it follows whenever the selected channel changes, not for a
  volume change).
- **FOLLOW** (the FOLLOW button, LED bright while on, on by default): while FL plays the step page turns to
  the play head's page when the head enters another one, as on the STEP page (paging by hand sticks until
  then). Position in the pattern = ((bar − 1) × 16 + step − 1) mod the pattern length.
- **Pads 1–16** are the patterns of the pattern bank (colors and LEDs as PATTERN's pads: current bright,
  others dim, past the last pattern off; the bank follows the current pattern). A press selects the pattern
  (SELECT_PATTERN), and the grid then shows it. ERASE + pad does nothing (FL has no pattern delete).
  DUPLICATE (held) and SHIFT + DUPLICATE clone the pattern as on every page, so ARRANGER does not repeat
  them. Moves and releases of a pad are swallowed: no pad plays a note.
- **SCENE** works over this page as an overlay (below); the page's VIEW is sent again when it closes.
- RUN_PROBE (the playlist probe) is no longer sent when ARRANGER opens; only with `MK3D_PROBE=1` in the
  environment. The old marker controls (position knob, zoom/scroll, `ADD MKR`, `PREV MKR`/`NEXT MKR`) are
  gone; their FL commands stay in the protocol.

### SCENE (hold SCENE)

Code: `src/modes/sceneOverlay.ts`, the shared part in `src/modes/markerPage.ts`. FL has no scenes, so a
**playlist marker** stands for a scene or section; FL's script lists the markers by name and finds their
times by scanning while FL is stopped, and sends them as MARKERS (docs/sysex.md, "Markers"). The overlay
asks for a fresh scan when it opens (REQUEST_MARKERS). Markers whose times are unknown (the scan
disagreed with the names, e.g. a marker at tick 0) are listed by name with the corner text `Bar ?`; a press
on one does nothing in FL.

**Pads and grid**: the pads are the markers of the current bank of 16 (pad 1 = the first marker of the bank,
bottom-left like the other grids), each in a color from a fixed rotation (FL's step red, orange, yellow,
mint, blue, violet by marker index); the marker the song position is in is bright, the others dim, pads
past the last marker are off. The marker the song is in is the last one at or before SONG_POS, turned
into beats with the PPQ of MARKERS (16 steps per bar, as the STEP page assumes). Display 7 `<<` and
8 `>>` (right screen) page between the banks, and show only when there is another bank. The right screen
is a 4×4 grid of the marker names in FL's look, pad 1 bottom-left, the corner text `Bar n`, the current
marker outlined in orange. Without markers the pads are off and the right screen says `No markers — ADD
MKR sets one at the play position` (ADD_MARKER is no longer on any page; add markers in FL). The bank
starts at the current marker's, and follows a marker mk3d jumped to once FL reports the jump. ERASE + pad
does nothing (FL's script cannot delete a marker).

**SCENE** (overlay, hold; display 1 is the pin tab `SCENE`; LED bright while open, dim otherwise).
A press switches like Maschine's scenes: **at the next bar while FL plays, at
once while it is stopped** (JUMP_MARKER with `quantized` only while playing). Display 2 `NOW`
toggles quantized and immediate (underlined = immediate); the choice is saved in `pages.json`
(`pages.scene.immediate`). A queued jump flashes its pad (pressed variant against dim, 250 ms) and
outlines its cell in mint, and the left screen says `Queued: <name>`, until SONG_POS shows it happened
(the song is in that marker again from an earlier position, or FL stopped). Left screen: the current
marker big, the jump mode. Right screen: tabs `<<` `>>` and `1–16 of n` under the grid. SHIFT + SCENE
(sections) stays unbuilt: nothing happens.

NOT VERIFIED (docs/sysex.md): that `channels.isGridBitAssigned` tells piano roll channels from step
channels (ARRANGER), the marker scan's assumptions (marker order, a marker at tick 0, pattern loop mode) and
`OnUpdateBeatIndicator` timing for quantized jumps (SCENE).

### LIVE (hold SHIFT + SCENE)

Code: `src/modes/liveOverlay.ts`. Maschine-scene-style clip launching on FL's playlist: pad 1 = the
first **scene** of the current window (bottom-left, like every other grid), a press fires that
scene (docs/sysex.md "Live grid"). This only works once FL's **performance mode is switched on**
(confirmed live, 2026-10-20: outside it every block reads as empty); the left screen says so when
it is off.

A scene is FL's own term — "any group of Clips, on independent tracks, that can be triggered to
start playing together" — not a single track's blocks (the first build got this wrong, owner
caught it 2026-10-20: a layout with clips on three different tracks only ever showed and fired
track 1). A press makes the call Image-Line's Akai Fire script makes for a scene launch:
`triggerLiveClip` with `TLC_ColumnMode` (FL's scene flag) on the first of `LIVE_TRACK_SCAN` (8)
tracks that is filled at that block, plus `TLC_MuteOthers | TLC_Fill` (and `TLC_GlobalSnap` while
FL's snap is on); the pad's release sends the same call with `TLC_Release`. The second build missed
the flag, fanned the press out per track with flags 0 and never released (docs/sysex.md "Live
grid").

**Pads**: 16 scene columns, each the column across up to 8 tracks (LIVE_TRACK rows while this
overlay is open), in its first filled track's FL color: playing bright; scheduled (queued for its
trigger snap) flashing brightest/off every 250 ms like SCENE's queued jump, whether FL plays or
waits for PLAY (FL itself keeps the column that starts on PLAY queued while it is stopped, so that
pad flashes); idle faint; empty off. (The first version blinked bright/faint on the half beat and
stayed dim while stopped; owner, 2026-10-21: too subtle to see.) Display 4 `STOP` stops every
scanned track (verified on hardware 2026-10-21).
Display 7 `<<` and 8 `>>` page the scene window (`<<` dims at block 0; `>>` has no last page, the
API gives no block count for an open-ended timeline).

**Screens** (made to be read without looking at FL; `npm run pagepng` draws them as
`out/ui-live-*.png`): both screens share one row per track, so the left screen's names label the
right screen's rows.
- Right: the clip matrix, column numbers (the scenes the pads fire: orange while one of its clips
  plays, mint while one is queued) over 8 track rows × 16 blocks in the clips' colors; a playing
  clip is solid with a light frame, a queued one framed in mint (flashing with the pads), an idle
  one dimmed, an empty block a dash; a muted track's row is faded. A clip is labelled with its
  pattern (`P3` for FL's default "Pattern 3", else the first letters of the name, e.g. `Bas`), a
  playing one without a label gets a play triangle.
- Pattern names: the API names no clip, so mk3d matches the block's color against the patterns it
  knows (PATTERNS, the window around the current pattern); a clip has its pattern's color unless it
  was recolored. Only a color exactly one pattern has gives a name, so patterns left in FL's
  default color, or sharing one, stay unlabelled. NOT VERIFIED on hardware that
  `getLiveBlockColor` equals `getPatternColor` for an unrecolored clip.
- Left: the `LIVE` and `STOP` tabs; a header with a play triangle (green while FL plays), `Bar n`
  and four beat dots (the current beat orange), plus `Queued — press PLAY` in mint while a clip is
  queued and FL is stopped, or `Performance mode is off in FL` instead; then the track rows: the
  track color, its name, `M` / `S` badges, and on the right what it plays (orange triangle) and
  has queued (mint outline triangle): the pattern's full name, or the block number when the color
  names no pattern.

Not built: SHIFT + pad or ERASE + pad actions (a pad press only triggers; ERASE does nothing), a
single-clip launch (the Fire launches one clip without ColumnMode; LIVE only fires scenes), and
reading more than `LIVE_TRACK_SCAN` tracks for the grid (a project using more tracks than that for
performance-mode clips will not see them lit, though ColumnMode still fires them; raising it costs
more FL calls per pass, currently unchunked — see docs/sysex.md). A pad still held when the overlay
closes never sends its release.

## Later modes

The STEP page is built (above); what is left of it is knobs for the held step's velocity and pitch
(held-step editing). Planned in PLAN.md phase 6 and `docs/workflow.md`: SHIFT + SCENE
(sections), SHIFT + FIXED VEL (16 velocities), CHORDS' USER CHD / PADS ON / strumming. Their buttons are off until then (see "Pages").
