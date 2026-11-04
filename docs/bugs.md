# Bugs found on the hardware

Numbered, so they can be referred to. `open`, `fixed (software)` = changed and tested without the MK3,
`verified` = confirmed on the MK3. Add new ones at the end.

| #   | Found      | What                                                                                | Cause                                                                   | Status            |
| --- | ---------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------- |
| 1   | 2026-11-04 | NOTE REPEAT 1/8 always starts on the off-beat; 1/16 starts at once                  | Probably SONG_POS a sixteenth off (the guessed step base); now one tick count from FL | verified (owner, `[repeat]` log: slots on 0.5 beats) |
| 2   | 2026-11-04 | NOTE REPEAT did not feel straight at 1/8                                            | Timing followed each late SONG_POS; now a running estimate              | verified (owner, log: 231–240 ms at 127 BPM, 236 ms is exact) |
| 3   | 2026-11-04 | A render error could take the daemon down                                           | No guard around a page's render; now `FaultReporter`                    | fixed (software)  |
| 4   | 2026-11-04 | The MK3 froze for about two minutes the first time PLUG-IN opened                   | `FlPluginDb` read FL's 1241 `.nfo` files synchronously on the main thread, from `read()` on files in `~/Documents` (iCloud, 474 other files there are `dataless`); now read in the background | fixed (software)  |
| 5   | 2026-11-04 | NAVIGATE: a window behind another took about three presses to come up               | FL raises a window only when it opens it (the F-keys close one that is behind, `ui.setFocused` doesn't raise it); now closed and reopened in one press | verified (owner, 2026-11-04) |
