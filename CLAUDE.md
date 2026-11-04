# maschine-fl

mk3d: a macOS background daemon (Node + TypeScript) that takes exclusive USB control of a
Maschine MK3 and turns it into an FL Studio controller over virtual CoreMIDI ports and SysEx.

`PLAN.md` is the master plan: phases, hardware checkpoints and working rules. Read it first,
work one phase at a time, stop at each 🔌 checkpoint, and tick its checklists as items land.
USB facts go in `docs/protocol.md`, with a status for each.

## Commands

```bash
npm install
npm run mk3d                  # the daemon (see docs/setup.md for FL Studio)
npm run build                 # compile to dist/ (tsconfig.build.json)
bin/mk3d setup [--service]    # link the FL script, optional LaunchAgent; also: run start stop restart status logs doctor uninstall (docs/install.md)
scripts/install-fl-script.sh  # symlink the FL script into FL's Hardware folder
npm run typecheck             # tsc, no output
npm run lint                  # eslint
npm test                      # vitest, no hardware
npm run check                 # prettier, typecheck, lint, vitest, FL script tests (also CI)
npm run enumerate             # list NI USB/HID devices (read-only)
npm run enumerate -- --open   # also read HID input for 5 s
npm run inputlog              # live input events (--raw, --moves, --record <file>, --reset)
npm run ledtest -- <mode>     # LEDs: walk | levels | ladder | rainbow | palette | run | off
npm run displaytest -- <mode> # screens: bars | grid | text | partial | anim | widgets (--png: write out/*.png)
npm run pagepng               # quick edit, NAVIGATE, GRID, NOTE REPEAT and ARP, BROWSER, FILE, SETTINGS, ARRANGER (pattern overview), SCENE, PATTERN (length and color on one page, double), touch strip read-outs, LOOP, LIVE, KEYBOARD scales, CHORDS, SHIFT-pad LEDs and read-outs as out/ui-*.png (demo project)
scripts/ni-agents.sh status   # NI agents: status | stop | start
```

Tools run straight from TypeScript with `tsx`; the installed daemon (`bin/mk3d`, Homebrew formula in `Formula/`) runs the compiled `dist/main.js` with plain `node`.

## Hard rules (from PLAN.md §6)

- Tests never touch hardware. `hw/` is tested with recorded fixtures in `test/fixtures/`.
- Don't guess the protocol: write a diagnostic tool, run it, document the result.
- Never delete or edit NI files. Never send firmware commands, never touch interface 6 (DFU),
  never send HID feature reports or output reports other than `0x80`/`0x81`. The one approved
  exception (owner, 2026-11-04): the screen backlight, feature reports `0xF8`/`0xF9`, read-modify-write
  of byte 8 only (`docs/protocol.md`).
- The FL script must catch every exception and never send large SysEx bursts in one call.

## Layout rule

On the MK3, display buttons 1–4 sit above the left screen and 5–8 above the right one; knobs 1–4
sit below the left screen and 5–8 below the right one. What a control does is drawn on the screen
it belongs to, in the column right above or below it (4 columns of 120 px per 480 px screen):
button labels as tabs along the top edge, knob labels and values along the bottom. Never draw a
control's label or value on the other screen.

## Notes

- `usb` is v3 (WebUSB-style API): `import { usb } from "usb"`, then `await usb.getDevices()`.
  Types come from `@types/w3c-web-usb`.
- macOS ships bash 3.2; keep shell scripts compatible with it.
- `reference/` holds cloned reference repos (gitignored, read-only).
- `reference/Deckard` is GPL-2.0 and this repo has no licence: ideas and hardware facts only, never
  code or data tables; credit used facts in `THIRD_PARTY_NOTICES.md`. Its `docs/controller-*.md` are a
  good description of how Maschine's pages behave.
- Bugs found on the hardware go in `docs/bugs.md`, numbered, with their status.
