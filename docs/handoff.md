# Handoff for the next session

Read CLAUDE.md, then PLAN.md (the master plan with checkpoint results), then this.

## Where we are (2026-11-05)

- Every page in [mapping.md](mapping.md) is built except SAMPLING, EVENTS and MACRO. The README's "Status"
  section says what has been confirmed on the MK3 and what hasn't.
- Bugs found on the hardware are in [bugs.md](bugs.md). The latest project review, with what it fixed, what is
  left and the questions for the owner, is [review-2026-11-05.md](review-2026-11-05.md).
- The Windows port has begun and waits for FL Studio and loopMIDI on the PC ([windows.md](windows.md)).
- Protocol v2 between mk3d and the FL script: [sysex.md](sysex.md), with shared byte vectors in
  `test/fixtures/sysex-vectors.json` (TS and Python both test against them).
- Pads use the MK3's own hit events ([protocol.md](protocol.md), found with REA in NI's agent).

## How to run things

- Daemon: `npm run mk3d` (`--log-pads`, `--log-buttons`, `--png <dir>`). The owner runs it in a terminal of their
  own, so don't start a second copy. A change to the TypeScript needs a restart of mk3d.
- FL Studio **2026** (2025 is installed too, but isn't set up). After a change to the FL script, the owner reloads
  it in FL: View → Script output → tab MK3 Bridge → Reload script. mk3d's log then shows `FL script unloaded` and
  `FL Studio connected`.
- Checks: `npm run check`.

## Working style that has worked

- When asking the owner to press something, name the **hardware** label (e.g. the "PLUG-IN" button top left), not
  on-screen tab names: they mixed them up once.
- Small commits; tick PLAN.md's checklists and record each hardware result there, or in [bugs.md](bugs.md).
- Nothing new may be sent to the MK3 (only LED reports 0x80/0x81, the display and the approved backlight report)
  without the owner's approval. NI's pad sensitivity report is documented but not sent.

## Unverified FL behaviour to watch

Listed at the top of `fl-script/MK3Bridge/device_MK3Bridge.py` (some of that header has been confirmed since, see
PLAN.md), in [sysex.md](sysex.md) under "To confirm in FL" and in the README's "Built, not yet confirmed on the
hardware".
