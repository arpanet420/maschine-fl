# Screen design: FL Studio's look on the MK3

The MK3 screens should feel like FL Studio 2026, so the hardware and the desktop read as one
tool. Researched 2026-10-19 on the user's Mac (read-only). Marks: **file** = read from FL's
files, **owner** = from the owner's FL 2026 screenshot, **guess** = derived, to check on the
hardware.

## Where FL keeps its look

- FL draws its mixer, knobs, faders, meters, LEDs and step buttons as vectors in code; the app
  has no widget bitmaps or asset catalog (`Contents/Libs/FLEngine_x64.dylib`, checked with REA
  and string scans). So mk3d redraws the shapes and takes only colors and fonts from FL.
- Colors come from theme files: `Contents/Resources/FL/Artwork/Themes/*.flstheme` (shipped) and
  the user's active theme `~/Documents/Image-Line/FL Studio/Settings/Themes/__current.flstheme`.
  INI-like text; colors are signed int32 Windows COLORREF `0xAABBGGRR` (low byte = red). Alpha
  `ff` = an explicit color, `00` = derived from the theme's Hue/Saturation/Lightness/Contrast.
  Keys: `Text`, `TextColor`, `Selected`, `Highlight`, `Mute`, `Option`, `StepEven`, `StepOdd`,
  `Meter0`–`Meter5`, `PRGridback`, … (file)
- UI font: **Barlow Medium** (and SemiBold), shipped in
  `Contents/Resources/FL/Shared/Artwork/Fonts/` under the SIL OFL. mk3d loads it from the
  installed app at runtime with `GlobalFonts.registerFromPath` (works in `@napi-rs/canvas`) and
  falls back to Helvetica Neue. FL's tiny `Fruity microfont` is unreadable at MK3 size.

## Tokens

From the user's active theme (Hue 0, Saturation −14, Lightness +8, Contrast +39) unless marked.

| Token                | Hex                               | Source                                     |
| -------------------- | --------------------------------- | ------------------------------------------ |
| background (gutters) | `#1b2229`                         | guess, darker than the panel               |
| panel                | `#2b3640`                         | owner                                      |
| panelRaised (tabs)   | `#36444f`                         | ≈ `PRGridback #34444e` (file)              |
| line                 | `#161c22`                         | guess                                      |
| text                 | `#d3cfc9`                         | `TextColor` (file)                         |
| dimText              | `#8d98a2`                         | guess                                      |
| highlight (current)  | `#fb9244` orange                  | `Highlight` (file)                         |
| selected             | `#4ae4a8` mint                    | `Selected` (file): selected fader cap/line |
| LED on / off         | `#78d008` / `#27331c`             | `Mute` (file) / guess                      |
| option (rec, solo)   | `#e85028`                         | `Option` (file)                            |
| meter                | `#a0dc40` → `#eec54e` → `#fd7830` | `Meter1/3/4` (file)                        |
| meter empty          | `#20292f`                         | guess                                      |
| fader cap / slot     | `#9aa3aa` / `#141a1f`             | guess                                      |
| knob body / rim      | `#222b32` / `#3a4650`             | guess                                      |
| step off (A / B)     | `#3a4752` / `#2f3b45`             | guess                                      |
| step on (A / B)      | `#e0707a` / `#9fb4c0`             | `StepOdd/StepEven` brightened (guess)      |

Keep at least three visible steps between dark layers: RGB565 bands close greys together.

## Widgets

All inside the 120 px column of the control they belong to (CLAUDE.md Layout rule).

- **Tab bar** (display buttons): 20 px, `panelRaised`, Barlow 14 px `dimText`; active tab
  `text` with a 3 px orange underline; 1 px `line` between tabs.
- **Mixer strip** (Mixer mode, one per column): a 112 px `panel` card with 4 px gutters. Track
  number on top (boxed in orange when selected), round mute LED (green = on, as in FL), track
  name rotated 90° on the left, stereo meter of two 10 px segmented bars (3 px cells, 1 px gaps,
  peak-hold tick), fader slot with a grey cap (mint cap and a mint line below it when selected),
  pan or volume value in the knob row at the bottom, a small route arrow drawn as a triangle.
  Master: a wider meter with dB ticks 3, 0, 3, 6, 9, 12.
- **Knob**: dark body with rim, 270° value arc in orange (mint when touched), bipolar arcs from
  12 o'clock, label 13 px `dimText` above, value 15 px `text` below.
- **Step row**: rounded squares in groups of 4 with alternating off shades; lit steps use the
  group's on color; the play position as a 2 px orange outline. On a 120 px column, one group of
  4 per column.

## Not known yet

- Whether FL 2026 reads `__current.flstheme` (dated Nov 2025, possibly carried over from 2025).
  If the user changes FL's theme, mk3d could read the same file at startup; not built.
- Glyph codepoints of FL's icon font (`ILGlyphsEx.ilfont`); icons are drawn as shapes instead.
