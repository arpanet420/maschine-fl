# NKS in Plugin mode

How Native Instruments' NKS describes a plugin's knob pages, how Maschine draws them, and how
mk3d can use the same data for any NKS plugin in FL Studio, with FL's own parameter list as the
fallback. Researched 2026-10-18 on the user's Mac (read-only: NI files were only read or copied
to a scratch folder). u-he Diva is the test plugin; nothing below is specific to it.

Status words: **seen** = read from files on this Mac, **inferred** = reasoned from the data,
**verify** = must be checked live in FL Studio 2026 (listed at the end).

## Summary

- An NKS preset (`.nksf` instrument, `.nksfx` effect) is a RIFF file. Its `NICA` chunk holds the
  knob pages: a list of pages, each exactly 8 slots of `{id, name, section?}`. `id` is the
  plugin's parameter ID, `name` a short knob label, `section` starts a labelled group of knobs.
  NKS v1 has **no page names**. (seen)
- The mapping lives **in every preset**, not once per plugin. Most vendors write the same `NICA`
  into all presets; u-he adapts it per preset (Diva: 1356 presets, 997 different mappings). There
  is no plugin-level mapping file on disk, and Maschine's `komplete.db3` holds preset metadata only.
  (seen)
- `PLID` identifies the plugin: `VST.magic` (VST2 unique ID) or `VST3.uid` (4 × u32 = the VST3
  class ID) plus `pluginName`/`pluginVendor`. (seen)
- FL's API only gives the plugin's name, but FL's own plugin database
  (`~/Documents/Image-Line/FL Studio/Presets/Plugin database/Installed/**/*.nfo`) maps that name
  to the VST2 magic, the VST3 class ID and the VST3 plugin's VST2 compatibility IDs. That gives an
  exact name → `PLID` match for any NKS plugin. (seen)
- For VST2, `NICA.id` is the VST2 parameter index, and FL's parameter index should be the same.
  For VST3 it is the VST3 ParamID, which equals FL's index only if the plugin numbers its
  parameters 0, 1, 2… in order. Every mapping is checked against FL's parameter names before use.
  (inferred, verify)
- Maschine 3's hardware UI is plain Lua inside the app bundle. It shows a section label only where
  a section starts, stretches it over the following knobs, keeps the left and right 4 knobs
  separate, and uses Page ◀ ▶ to change pages. (seen)

## Where NKS data lives

All paths read-only.

| What              | Where                                                                               | Content                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product registry  | `/Library/Preferences/com.native-instruments.<RegKey>.plist`                        | `ContentDir` (HFS path, e.g. `Macintosh HD:Library:Application Support:u-he:Diva:NKS:Diva:`), `InstallDir`, `ContentVersion`. One plist per NKS product, written by the vendor's installer  |
| Product hints     | `/Library/Application Support/Native Instruments/Service Center/<RegKey>.xml`       | `<Name>`, `<BinName>` (bundle name), `<PluginID>` (VST2 ID in hex, `0000` for VST3-only), `<Company>`, UPID. Not every product has one (Satin, ColourCopy, Twangstrom don't)                |
| Factory presets   | the `ContentDir` above, any depth                                                   | `.nksf` / `.nksfx`                                                                                                                                                                          |
| User presets      | `~/Documents/Native Instruments/User Content/<product>/`                            | `.nksf` / `.nksfx` saved by the user (empty on this Mac)                                                                                                                                    |
| Logos and artwork | `/Users/Shared/NI Resources/image/<vendor>/<product>/`                              | `MST_logo.png` (240×196, white on transparent, for Maschine's screens), `MST_artwork.png`, `MST_plugin.png` (GUI thumbnail), `VB_logo.png`, `OSO_logo.png`, NKS2 tiles (`.webp`)            |
| Colors and names  | `/Users/Shared/NI Resources/dist_database/<vendor>/<product>/`                      | `color.json` (`VB_bgcolor`, optional `NKS2_Control_Color`), `NKS_color.json`, `NKS2_control_color.json` (`{"color": "EB4747"}`), `shortname.json` (`MST_shortname` etc.), `categories.json` |
| Preset database   | `~/Library/Application Support/Native Instruments/Maschine 3/komplete.db3` (SQLite) | Preset metadata (`k_sound_info`: name, author, vendor, bank chain, file name) and the content folders (`k_content_path`: path, UPID). **No parameter mappings.**                            |

Folder names under `NI Resources` are the lowercased product name (`u-he/diva`,
`izotope/ozone 12 equalizer`). Names with characters such as parentheses get the stripped name
plus `_` + MD5 of the original (`divax64_6cd2…` = MD5 of `Diva(x64)`, a Windows-only duplicate;
`universal audio uadx_33b7…` = MD5 of `Universal Audio (UADx)`). Don't rebuild these names:
every folder has a `<name>.meta` XML with the real `<vendor>` and `<name>`, so index the `.meta`
files and look up by (vendor, name).

Installed here: 5312 `.nksf`/`.nksfx` files for 29 plugins (u-he Diva, Repro-1/5, Satin,
ColourCopy, Twangstrom; iZotope Ozone 12 modules; UADx Pultec/LA-2A; Arturia SQ80 V, Mix
DRUMS; XILS-lab polyKB; Waldorf Streichfett; Plogue chipspeech). Spotlight also finds NKS packs
in `~/Downloads`; those are not registered with NI and the index should ignore them.

## File format

RIFF, little-endian sizes: `"RIFF" u32 size "NIKS"`, then chunks `id(4) u32 size body` (padded
to even). Chunk order differs by vendor (u-he: `NISI NICA PLID PCHK`; iZotope: `PLID NISI NICA
PCHK`; UA: `NISI PCHK PLID NICA`), so read by ID. Every body except `PCHK` is `u32 version`
(always 1) followed by one MessagePack value. `PCHK` is the plugin's state blob.

### PCHK and loading NKS presets (2026-10-19)

For u-he plugins (Diva, Repro-1/5, Satin, ColourCopy, Twangstrom — the ones installed here),
`PCHK` is **not an opaque blob**: strip the leading `u32 version` and the rest is byte-for-byte
u-he's own plain-text `.h2p` patch format (seen, `MidRangePad.nksf`'s `PCHK`, 5536 bytes → `u32
1` + 5532 bytes of text starting `#pgm=MidRangePad\n/*@Meta\n\nBank:\n…`, matching the structure
of a real `.h2p` found on this Mac at `~/Library/Audio/Presets/u-he/Repro-5/Robotica/BASS
Interface.h2p`: `/*@Meta … */`, `#AM=<plugin>`, `#Vers=`, `#Endian=little`, `#nm=`, `#ms=…`
lines, then the encoded parameter block). A standalone `.h2p` on disk has no `#pgm=` line (the
patch name comes from the filename instead); dropping that one line turns a `PCHK` into a loadable
`.h2p` file.

u-he plugins scan their own preset folders
(`~/Library/Audio/Presets/u-he/<Plugin>/<Bank>/<Name>.h2p`) independently of FL, through the
plugin's own preset browser inside its GUI — no FL scripting involved. **Verified in FL
(2026-10-20):** `MidRangePad.nksf`'s `PCHK`, with the `#pgm=` line stripped, saved as
`~/Library/Audio/Presets/u-he/Diva/NKS Import Test/MidRangePad (from nksf PCHK).h2p`, shows up in
Diva's own Patches browser under bank "NKS Import Test", loads and sounds like the source NKS
preset. **The conversion itself works.**

**But it is not reachable from the MK3 hardware.** mk3d's existing BROWSER page already drives
`plugins.getPresetCount()/nextPreset()/prevPreset()` (`docs/mapping.md`, "BROWSER"), and on Diva
that is a **different, unrelated list** from the Patches browser above: it showed 129 entries
named "Program `<n>`", and stepping through them on the hardware changed the channel/plugin name
to "Program `<n>`" but left Diva's own Patches browser selection untouched (verified live,
2026-10-20). This matches the suspicion already logged in `device_MK3Bridge.py` (~line 142): for a
VST, FL's preset-name lookup doesn't match the real patch names, and FL instead names the channel
after "the VST's current program" — a separate, generic VST-program-slot mechanism, decoupled from
whatever internal patch library the plugin draws its own GUI browser from. There is no known
FL scripting hook into that internal browser.

**Net result:** `PCHK` → `.h2p` conversion is a genuine, confirmed capability — useful as a
one-time **migration tool** ("port my NKS library into Diva/Repro-5/Satin/ColourCopy/Twangstrom's
own native browser," run once outside FL, e.g. a small CLI in mk3d) — but it does **not** give the
MK3 hardware a way to browse or load those presets; that still requires opening the plugin's own
GUI. Loading NKS presets *from the hardware* stays out of scope, as the original plan said, for a
different reason than originally thought (not "the API can't set a plugin's state", but "the API's
preset list and the plugin's real patch library are different things").

**Not covered by this trick:** the other PCHK producers here (iZotope Ozone 12, UADx, Arturia,
Waldorf, Plogue) are not u-he and almost certainly use their own vendor-specific state format, not
`.h2p` text — each would need its own PCHK inspection before the same approach could apply. u-he
alone accounts for 5 of the 29 indexed NKS product families, but it's the one already verified
and in daily use (Diva, throughout this project).

### NISI (preset info)

Map with `name`, `vendor`, `author`, `comment`, `deviceType` (`INST`/`FX`), `bankchain`
(`[product, bank, subbank]`; `bankchain[0]` is the product name, e.g. `Diva`, `Ozone 12
Equalizer`), `types` (`[[type, subtype]…]`), `modes`, and on newer files `uuid`, `characters`.
`vendor` + `bankchain[0]` equal the `<vendor>`/`<name>` of the `NI Resources` `.meta` files for
every product here.

### PLID (plugin ID)

| Form                                                                   | Example                                                                                 | Seen in                                     |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------- |
| `{"VST.magic": u32}`                                                   | `1147754081` = `0x44695661` = `'DiVa'`                                                  | u-he, Arturia, XILS, Waldorf, Plogue        |
| `{"VST.magic": 0, "VST3.uid": [u32 ×4], "pluginName", "pluginVendor"}` | `[0x5653545A, 0x425A554F, 0x7A6F6E65, 0x2050726F]`, `"Ozone 12 Equalizer"`, `"iZotope"` | iZotope, UADx (UA also adds `"version": 1`) |

The four u32 written as 32 hex digits are the VST3 class ID exactly as FL prints it in its
`.nfo` files (`{5653545A-425A-554F-7A6F-6E652050726F}`). No AU form appears on this Mac.

### NICA (controller assignments)

`{"ni8": [page, page, …]}` (UA adds `"version": 1`). Every page has exactly 8 slots (all 40 134
pages here). A slot is:

| Key        | Meaning                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `id`       | Plugin parameter ID. Missing = unassigned slot (its `name` is then absent, `"unassigned"` or `"unset"`)                              |
| `name`     | Knob label, short and hand-written (`Cutoff`, `Reso`, `1 > 2`), not the plugin's own parameter name                                  |
| `section`  | Present on the slot where a section starts (`Filter`, `AmpEnv`, `LFO1`). Slots after it without `section` belong to the same section |
| `autoname` | `true` when the name was generated (Arturia, iZotope, UA; mostly on empty slots). No effect on layout                                |
| `vflag`    | Always `false` here; meaning unknown                                                                                                 |

Every page here has at least one `section`, nearly always on its first assigned slot. Arturia's
Mix DRUMS sometimes puts it on an empty slot just before the knobs it labels (`Low` on empty
slot 1, then `Dry Level`, …), so treat a section as belonging to the slot it is on, assigned or
not, as Maschine does. Example, Diva's most common mapping (10 pages):

```
0  Filter: Cutoff#148 Reso#149 Env2#151 LFO2#153 | ModEnv: Attack#44 Decay#45 Sustain#46 Release#53
1  VCO1: Shape#91 | VCO2: Shape#92 Tune#87 | VCO3: Shape#93 Tune#88 | FM: 1>23#94 | – –
3  Lowpass: Cutoff#148 Reso#149 Mod#150 Depth#151 Mod#152 Depth#153 KYBD#154 FilterFM#155
4  AmpEnv: Attack#33 Decay#34 Sustain#35 Release#42 Velocity#37 KYBD#43 – –
8  Chorus1: Active#1 Type#179 Rate#180 Depth#181 Wet#182 – – –
```

The same parameter can appear on several pages (Cutoff #148 on pages 0 and 3).

Maschine 3's binary also parses an NKS2 layout (`nks2_layout`, `nks1_layout`, `view_address`,
`groups` → `sections` → `parameters`, `plugin_data`). None of the installed products ship that
data as files, so it is out of scope; the reader must skip unknown chunks and keys.

### Per-preset vs per-plugin mapping

| Plugin                                                                   | Presets | Different `NICA`s                                                                         |
| ------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------- |
| u-he Diva                                                                | 1356    | 997 (pages 3, 6, 7 are fixed; pages 0–2 follow the oscillator/filter model of the preset) |
| u-he Repro-1                                                             | 544     | 241                                                                                       |
| u-he Satin                                                               | 262     | 4                                                                                         |
| u-he Repro-5                                                             | 989     | 2                                                                                         |
| Plogue chipspeech                                                        | 105     | 3                                                                                         |
| all others (iZotope, UA, Arturia, XILS, Waldorf, ColourCopy, Twangstrom) | –       | 1                                                                                         |

u-he builds the mapping inside the plugin (`NKS_DefaultMapping`, `.nksmap` strings in its binary)
and writes the result into each preset. There is no plugin-level mapping to read. When mk3d
doesn't know which preset is loaded, the plugin's **default mapping** is the most common complete
`NICA` across its presets (ties: a preset named like `INIT`/`Default`, then the alphabetically
first). For Diva that is a real preset's mapping (29 presets share it, shown above), so its pages
fit together, unlike mixing the most common page at each position.

## Matching FL's plugin to its NKS data

FL's script gets `plugins.getPluginName(index)` (`"Diva"`) and nothing about the format or ID.
FL's plugin database fills the gap. Every scanned plugin has an `.nfo` per format (and sometimes a
`… 2.nfo` duplicate) under `Installed/{Generators,Effects}/{VST,VST3,AudioUnit,CLAP}/`:

```
ps_name=Diva                                   ps_file_plugclass_0 = 4 VST2, 7/8 VST3, 10 AU, 12 CLAP
ps_file_filename_0=/Library/Audio/Plug-Ins/VST/u-he/Diva.vst
ps_file_magic_0=1147754081                     VST2 unique ID  → PLID VST.magic
ps_file_guid_0={D39D5B69-D6AF-42FA-1234-567844695661}          VST3 class ID → PLID VST3.uid
ps_compatibility_0={56535444-6956-6164-6976-610000000000},…    VST3 only: the VST2 plugins it replaces
ps_file_vendorname_0=u-he
ps_file_idstring_0=com.u-he.Diva               CLAP ID
```

A VST3 compatibility ID is Steinberg's VST2 wrapper ID: bytes `"VST"`, then the 4-byte VST2
unique ID, then the lowercased name (`56 53 54 | 44 69 56 61 | 64 69 76 61…` = `VST` `DiVa`
`diva`). So bytes 3–6 give the VST2 magic of the plugin a VST3 build is compatible with. (seen in
Diva's `.nfo` and its `moduleinfo.json`)

Lookup for FL name `N`:

1. All `.nfo` entries with `ps_name == N` (case-insensitive). Each yields keys: VST2 →
   `vst2:<magic>`; VST3 → `vst3:<32 hex>` and `vst2:<magic>` from each compatibility ID; AU and
   CLAP → none.
2. Look the keys up in the NKS index (keyed by `PLID`). First hit wins; VST3 class ID before the
   compatibility ID.
3. No key hit (AU, CLAP, a plugin FL hasn't scanned): match `N` against the NKS products' names
   (`PLID.pluginName`, `NISI.bankchain[0]`, Service Center `<Name>`/`<BinName>`), preferring the
   one whose vendor equals the `.nfo` vendor. Name matches get the stricter check below.
4. Nothing: FL's parameter list (`FlParamPages`).

FL may host the same plugin as VST2, VST3, AU or CLAP and gives the same name for all of them, so
step 1 can return several formats; they all lead to the same NKS product, and the ID check
decides whether the mapping fits the instance that is actually loaded.

## NICA IDs and FL's parameter indexes

| Format FL loaded                      | What `NICA.id` means (NKS SDK) | FL's `plugins.getParamValue(i)` index                                                   | Expected                                                                                              |
| ------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| VST2                                  | VST2 parameter index           | FL's VST wrapper keeps the plugin's own indexes first (FL then adds its own up to 4240) | equal (verify)                                                                                        |
| VST3                                  | VST3 `ParamID`                 | position in the plugin's parameter list                                                 | equal only if ParamIDs are 0…n−1 in order (iZotope/UA IDs here are small: 8–74; verify)               |
| VST3 of a VST2-NKS plugin (Diva VST3) | VST2 index                     | as above                                                                                | equal if the VST3 build keeps VST2 numbering, which its declared VST2 compatibility suggests (verify) |
| AU, CLAP                              | not covered by these files     | plugin-defined                                                                          | unknown (verify)                                                                                      |

FL's API has no ParamID, so mk3d can't translate IDs itself. Instead every mapping is checked
against FL's parameter names (PARAM_NAMES) before it is used:

- **Coverage**: every assigned `id` must be below FL's `paramCount` and have a non-empty FL name.
- **Agreement**: a slot agrees when a word of its NICA `name` or section (3+ letters, case-folded)
  is a prefix of a word in FL's name for that index (`Reso` ~ `VCF1: Resonance`). Log the share.
- Use the NKS pages when coverage is 100 % and agreement passes a threshold to tune live (start at
  50 %); otherwise fall back to `FlParamPages` and log why. Matches found by name (step 3) need
  the threshold too; ID matches could be trusted on coverage alone if the live check shows VST2
  and VST3 indexes line up.

## How Maschine draws NKS pages

From `Maschine 3.app/Contents/Resources/Scripts/` (plain Lua): `Shared/Components/ParameterHandler.lua`,
`Shared/Helpers/ScreenHelper.lua`, `Shared/Pages/ControlPageStudio.lua`, `PageMaschine.lua`,
`Maschine/MaschineMK3/Pages/ControlPageMK3.lua`.

- 8 parameters per page (`MAX_NUMBER_OF_PARAMS_PER_PAGE = 8`), one per knob. Each has a section
  label row above the name/value row. Names are drawn upper-case.
- A section label is drawn only on the slot where the section name changes; the slots after it get
  no text, and the label widget stretches over them (`setWidgetSpan`). Spans are computed for slots
  1–4 and 5–8 separately, so a section never crosses from the left screen to the right one, and a
  section that continues from knob 4 to knob 5 has no label on the right screen.
- The section for a parameter is its own, or the nearest one to its left (`getPreviousSectionName`;
  used for touch read-outs and speech).
- The slot-8 label shows the page number `x/y` instead of a section when there is more than one
  page and slot 8 has no section of its own, and for about 20 controller ticks after the page
  changes. An empty page shows `NO PARAMETERS`.
- Page ◀ / ▶ (the two arrow buttons beside the screens) step pages without wrapping
  (`onLeftRightButton`, `ParameterCache.advanceFocusPage`). Display buttons 5/6 (`<<`, `>>`) step
  plugin slots, not pages; 1–3 pick Master/Group/Sound.
- Unassigned plugin slots exist (`TAG_PLUGIN` parameters with `isAssigned() == false`) and are drawn
  empty.
- Pages and their parameters come from native code (`NI.DATA.ParameterCache`). How Maschine fills
  pages for a plugin without NKS (and when it re-reads NICA after a preset load) is in that native
  code, not in the Lua, and was not traced: the binary is 305 MB and our fallback doesn't depend on
  it. NI's manual describes automatic assignment in the plugin's parameter order with manual
  re-assignment (Learn); our `FlParamPages` does the same.

### Translated to mk3d's two-screen layout rule

| NKS / Maschine                                                      | mk3d Plugin mode                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Page = 8 slots                                                      | Same. Slots 1–4 → knobs 1–4 on the left screen, slots 5–8 → knobs 5–8 on the right screen                     |
| No page names                                                       | Tab name = the first section on the page (any slot), else `Page n`. Repeated names get ` 2`, ` 3`             |
| Section label where it starts, spanning the following knobs         | Same, in a section row above the knob labels, spanning columns **on the same screen only**                    |
| Section continuing from knob 4 to knob 5 shows nothing on the right | Repeat the section label at column 5 (dimmed or marked as continued), so the right screen is readable alone   |
| Knob name = NICA `name`                                             | Same; FL's full parameter name on touch                                                                       |
| Value text                                                          | FL's value text (`PLUGIN_PARAMS`); NKS has none                                                               |
| Unassigned slot                                                     | Empty column, knob does nothing                                                                               |
| Page ◀ ▶ steps pages                                                | Arrow left/right step pages; display buttons pick pages (Plugin mode's existing tab bank)                     |
| Logo, color                                                         | `MST_logo.png` in the left screen's header area; `NKS2_Control_Color` (else `VB_bgcolor`) as the accent color |

## Proposed `src/nks/`

```
src/nks/
  riff.ts        readChunks(buf): Map<id, Buffer>; skips PCHK without copying
  nksFile.ts     parseNksFile(buf) → { info: NisiInfo, pages: NksPage[], plid: Plid } | error
  discover.ts    product content folders: /Library/Preferences/com.native-instruments.*.plist
                 (ContentDir, via `plutil -convert json -o -`), Service Center XML,
                 ~/Documents/Native Instruments/User Content; NI Resources .meta files
  flPluginDb.ts  parse FL's *.nfo files → name → [{format, magic?, vst3Uid?, compat[], vendor}]
  index.ts       build/load the index; default mapping per product; lookup(name, nfo) → NksProduct
  cache.ts       ~/Library/Caches/mk3d/nks-index.json (versioned)
  nksPages.ts    NksPageSource implements PageSource (falls back to FlParamPages)
```

Types (sketch):

```ts
type Plid = { vst2?: number; vst3?: string /* 32 hex */; name?: string; vendor?: string };
interface NksSlot {
  id?: number;
  name: string;
  section?: string;
}
type NksPage = readonly NksSlot[]; // always 8
interface NksProduct {
  vendor: string;
  name: string; // NISI vendor + bankchain[0]
  plids: Plid[];
  defaultMapping: NksPage[]; // most common complete NICA
  mappingsByPreset?: Map<string, number>; // preset name → index into a deduped mapping table, only when they differ
  logo?: string;
  color?: string; // MST_logo.png path, "#EB4747"
}
```

Index at startup:

1. Discover content folders and resource `.meta` files; list `.nksf`/`.nksfx` with size and
   mtime.
2. If the cache's file list (path, size, mtime) and format version match, load it. Otherwise
   parse in the background (async reads, a few hundred files per tick) so the daemon starts at
   once; Plugin mode uses `FlParamPages` until the index is ready. Python reads all 1356 Diva
   files in 0.6 s, so a full rebuild of ~5500 files should take a few seconds.
3. Group presets by `PLID`; dedupe pages so per-preset mappings stay small; pick the default
   mapping; attach logo and color by (vendor, product).
4. Read FL's `.nfo` files fresh at startup (cheap); re-read when a name isn't found.

`NksPageSource.pages(fl)`: look up `fl.plugin.name`, check the mapping against `fl.paramNames`
(coverage + agreement), convert each NKS page to a `PluginPage`, else return
`FlParamPages.pages(fl)`. Cache the decision per (channel, plugin name, paramCount) and log it once.

`PluginPage` needs two optional fields beyond `name`/`params`/`prefix`:

```ts
/** Knob label per slot (NKS name); undefined = FL's name. */
labels?: readonly (string | undefined)[];
/** Section that starts at each slot; undefined = continues the one to its left. */
sections?: readonly (string | undefined)[];
```

and the source should expose the header art, e.g. `header?(fl): { logo?: string; color?: string }`.
`msgpack`: add `@msgpack/msgpack` (already named in PLAN.md) or a 60-line decoder; only maps,
arrays, strings, ints, bools and nil occur.

Not in scope (as in PLAN.md): loading NKS presets; FL's API can't set a plugin's state.

## Verified on hardware (2026-10-18)

mk3d's `src/nks/` (built from this design) on FL Studio 2026 with Diva: `NKS: Diva → u-he Diva
via vst2, 10 pages (coverage 100 %, agreement 87 %)`. The user checked on the MK3 that pages,
section labels and knob labels match Diva's GUI and that knobs move the matching Diva knobs
(the Filter page's Cutoff turns `VCF1: Frequency`, index 148). So NICA ID = FL parameter index
holds for Diva (question 2; FL matched it through the VST2 ID, the loaded format was not logged).
While FL's names are still arriving the check briefly reports low coverage and falls back, then
switches to NKS a few hundred ms later. Still open: 1, 3–9 below.

## Open questions to verify live

1. `plugins.getPluginName` for Diva loaded as VST2, VST3, AU and CLAP: is it `"Diva"` every time,
   and does a renamed channel change it?
2. Diva **VST2** in FL: do `getParamName` indexes match NICA IDs? Expected: 148 Cutoff, 149
   Resonance (filter), 33–36 amp envelope ADSR, 57 LFO1 waveform, 1/2 effect 1/2 on. Does
   `setParamValue(148)` move the cutoff knob in Diva's GUI?
3. The same for Diva **VST3**, **AU** and **CLAP** (Diva's VST3 claims VST2 compatibility, so the
   indexes may match; AU/CLAP unknown).
4. A VST3-`PLID` plugin, e.g. **Ozone 12 Equalizer**: is FL index 16–23 "Gain Band 1–8"? (NICA
   IDs are VST3 ParamIDs.)
5. Can the FL script read the **current preset name** of a VST (`plugins.getName` with
   `midi.FPN_Preset`, or the program name)? If it can, use the preset's own `NICA` (matters for
   u-he); if not, the default mapping.
6. `paramCount` and the names past the plugin's own parameters for VST3/AU/CLAP (FL reports 4240
   for VST2). Do extra FL parameters (MIDI CC) ever get names that could collide with NICA IDs?
7. Does FL 2026 use the same plugin database folder (`~/Documents/Image-Line/FL Studio/Presets/
Plugin database`) as earlier versions?
8. Agreement threshold: what share do Diva, Ozone and a Plogue/Arturia plugin actually score?
9. Is `MST_logo.png` (240×196, white on transparent) readable in the header at MK3 scale, or is
   `VB_logo.png` (227×47) a better fit?

## Reproducing

The dump and survey scripts used here (Python, read-only, no dependencies) are in the side-session
notes folder of the session that asked for this research, as `nksdump.py`. Point them at copies of
NI files, never write next to them.
