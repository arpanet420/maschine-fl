# Windows

The port is under way. Everything is driven from the Mac over SSH; nothing here has run with an MK3
or with FL Studio on Windows yet. Status of each part:

| Part                                 | Status                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------- |
| Native modules load (Node 24, x64)   | verified: `usb`, `node-hid`, `@julusian/midi`, `@napi-rs/canvas`       |
| Tests                                | verified, without the macOS-only ones (`bin/mk3d`, NI plists, HFS paths) |
| File locations and FL's fonts        | written and tested without hardware (`src/platform.ts`)                |
| MIDI ports by name (loopMIDI)        | written, not run: needs loopMIDI                                       |
| FL script link                       | written, not run: `scripts/install-fl-script.ps1`                      |
| MK3 pads, buttons, LEDs over HID     | not tried: needs the MK3 on the PC                                     |
| MK3 screens                          | not built, see below                                                   |
| Timing (NOTE REPEAT)                 | timers measured, see below; NOTE REPEAT itself not tried               |
| Installer and autostart              | not built: `bin/mk3d` is bash with launchd                             |
| NKS pages                            | macOS only: they read NI's plist files                                 |

## Working from the Mac

```bash
scripts/winsync.sh 'npm ci'
scripts/winsync.sh 'npm test'
scripts/winsync.sh 'py -I -m unittest discover -s fl-script/tests'
```

`scripts/winsync.sh` copies the working tree, uncommitted changes too, to `C:\dev\maschine-fl` on
`ssh winbox` and runs the command there in PowerShell. Node is the official zip, unpacked in
`C:\dev\tools\node-v24.11.1-win-x64`, not on the PC's PATH. Everything in `C:\dev\maschine-fl` but
`node_modules` is replaced on each copy.

## Setting up FL Studio

1. Start FL Studio once, so it creates `Documents\Image-Line\FL Studio\Settings\Hardware`.
2. Install [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html) and make two ports,
   named exactly **MK3 Bridge** and **MK3 Bridge FB**. Windows has no virtual ports that mk3d could
   create itself, so loopMIDI has to run first, and they are listed in FL all the time.
3. In PowerShell, from `C:\dev\maschine-fl`: `powershell -ExecutionPolicy Bypass -File scripts\install-fl-script.ps1`.
4. FL's MIDI Settings as in [setup.md](setup.md), section 3.

## Timers

Node's `setTimeout` is much coarser on Windows. Lateness in ms, measured with the same Node version on
an idle machine, median and maximum over 200 runs:

| Asked for | macOS       | Windows      |
| --------- | ----------- | ------------ |
| 1 ms      | 0.16 / 0.29 | 14.71 / 15.36 |
| 5 ms      | 0.76 / 1.08 | 10.73 / 22.37 |
| 10 ms     | 1.14 / 1.54 | 5.75 / 6.14  |

So a timer fires on a tick of about 15.6 ms. That matters to NOTE REPEAT (`src/modes/repeatScheduler.ts`),
which schedules with `setTimeout`. How much it matters has not been tried.

## The screens

NI's driver (`nimc3usb.inf`) binds interfaces 0, 5 and 6 of the MK3. Interface 5 carries the screens,
so `src/hw/display.ts` can't claim it on Windows; mk3d logs that once and goes on without screens.
Interface 4, the HID one, isn't bound by that driver.

Two ways, neither tried here yet:

- **NI's hardware service** (first choice): [Encdr](https://github.com/RufusIbiza/Encdr) sends the
  same screen bytes through its named pipes, and reports that working on an MK3 with Maschine still
  usable, the INSTANCE button handing the hardware back and forth. It needs NI's software installed,
  and the protocol is NI's private one.
- **WinUSB on interface 5** (fallback): needs no code, but the driver swap takes the screens from
  NI's software until it is undone.
