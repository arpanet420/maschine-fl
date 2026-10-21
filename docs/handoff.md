# Handoff for the next session

Read CLAUDE.md, then PLAN.md (the master plan with checkpoint results), then this.

## Where we are (2026-10-18)

- Phases 0–5 done and checkpoint-verified on hardware. Phase 6: the mode framework,
  **Channel mode** and **Plugin mode v1** (FL's parameter list in pages of 8, `PageSource` in
  `src/modes/pluginPages.ts`) are built and tried on hardware: Plugin mode moves the plugin's
  own GUI knobs. Next: **NKS pages for Plugin mode**, designed in `docs/nks.md` (generic for
  any NKS plugin; Diva is only the test plugin, never special-case it), then Mixer → Step →
  Pattern.
- When asking the user to press something, name the **hardware** label (e.g. the "PLUG-IN"
  button top left), not on-screen tab names: the user mixed them up once.
- Protocol v2 between mk3d and the FL script: `docs/sysex.md`, shared byte vectors in
  `test/fixtures/sysex-vectors.json` (TS and Python both test against them).
- Pads use the MK3's own hit events (`docs/protocol.md`, found with REA in NI's agent).

## Update 2026-10-19

- NKS pages are done and checked on the MK3 with Diva (PLAN.md, docs/nks.md).
- Editor follows selection (FL script): while the selected channel's editor is focused,
  selecting another channel from the MK3 opens and focuses that one. Not yet tried in live FL.
- Screens use FL's colors and Barlow font (`src/render/fonts.ts`, docs/design.md). Not yet
  judged by the owner on the hardware (watch RGB565 banding of the dark greys).
- `docs/workflow.md`: how Maschine's buttons map to FL, with a build order. Its **(decided)**
  items were chosen while the owner was away; confirm them before building step 1 (page model).
- Research notes (Maschine Lua tables, FL theme extraction) are in the side-session notes folder
  of the session that wrote them: `maschine-workflow.md`, `fl-design.md`.

## How to run things

- Daemon: `npm run mk3d` (`--log-pads`, `--png <dir>`). The user runs FL Studio **2026**
  (also has 2025 installed, which is not set up). After changing the FL script, the user reloads
  it in FL: View → Script output → MK3 Bridge → Reload script.
- Checks: `npm run typecheck && npm run lint && npm test && npm run test:fl`.
- Start mk3d for the user in a new Terminal tab (the user prefers that to copying commands).

## Working style that has worked

- Opus designs and reviews; Sonnet agents implement against a written spec. Give each agent
  its own files, and a contract (spec + vectors) when two agents share an interface.
- Small commits; tick PLAN.md checklists and record each checkpoint result there.
- Nothing new may be sent to the MK3 (only LED reports 0x80/0x81 and the display) without the
  user's approval. NI's pad sensitivity report is documented but not sent.

## Unverified FL behaviour to watch at checkpoints

Listed at the top of `fl-script/MK3Bridge/device_MK3Bridge.py`: channel filter cutoff/resonance
via REC events (scale), pitch range, solo semantics, restart (CC 108), show editor toggle, the
pattern commands (clone, new, clear steps) and the STEP page's play position (16 steps per bar).
PAD MODE notes were verified in FL 2026 on 2026-10-19.
FL does not report channel solo yet (Channel mode remembers its own solos).
