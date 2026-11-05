# Setting up FL Studio for mk3d

Tested with FL Studio 2026 (26.1.5) on macOS.

## 1. Run `mk3d setup`

```bash
mk3d setup --service      # from a clone: ./bin/mk3d setup --service
```

This does the two steps below for you (see [install.md](install.md) for installing mk3d itself).
`mk3d doctor` checks the result. What it does, if you want to do it by hand:

### Install the script

```bash
scripts/install-fl-script.sh
```

This symlinks `fl-script/MK3Bridge` into
`~/Documents/Image-Line/FL Studio/Settings/Hardware/`. Edits to the script then only need a
reload in FL: **View → Script output → Reload script** (or restart FL). MIDI Settings → Update
MIDI scripts does not reload a script that is already running. mk3d's log shows `FL script
unloaded` and then `FL Studio connected` when the reload worked.

### Start mk3d first

```bash
scripts/ni-agents.sh stop
npm run mk3d
```

`--service` makes launchd do this at every login (`mk3d start`, `mk3d stop`, `mk3d logs`).

## 2. mk3d's ports

mk3d creates two virtual MIDI ports. FL only lists them while mk3d is running:

| Port              | Direction | Carries                                                            |
| ----------------- | --------- | ------------------------------------------------------------------ |
| **MK3 Bridge**    | mk3d → FL | Pad notes (channels 1 and 2), transport commands (CC 102–108, channel 16), SysEx |
| **MK3 Bridge FB** | FL → mk3d | FL's state as SysEx                                                |

## 3. FL Studio MIDI Settings

Options → **MIDI Settings**:

1. **Input** list: select **MK3 Bridge**, tick **Enable**, set **Controller type** to
   **MK3 Bridge**, and give it a **Port** number, e.g. **10**.
2. **Output** list: select **MK3 Bridge FB** and set the **same Port** number (10). FL sends the
   script's SysEx out of the output that shares the input's port number.
3. Leave **Maschine MK3** (the MK3's own class-compliant MIDI port) **disabled** in both lists.
   mk3d drives the device directly; that port would double the input.

The script's header asks FL to link it to a device called `MK3 Bridge` by itself (`# supportedDevices`), so on a new
machine the Controller type may already be set. That hasn't been seen yet, and the output's Port number still is yours
to set.

FL's Script output window (View → Script output) should show `MK3 Bridge: ready, port 10`, and
mk3d's log should show `FL Studio connected` and which FL it found (`FL 26.1.5, scripting API 44`). If the Script output
also says `no output port`, step 2 is missing.

## 4. Recording into the piano roll

Pads play the selected channel. To record:

1. Make sure FL's recording filter includes notes (the Rec button's right-click menu →
   **Notes**).
2. Press **Rec** on the MK3 (it lights), then **Play**. Optionally **Shift + Rec** for count-in.
3. Play the pads; the notes land in the selected pattern's piano roll.

## Basic controls

Every other control is in [mapping.md](mapping.md).

| MK3         | FL                                                                                |
| ----------- | --------------------------------------------------------------------------------- |
| Pads 1–16   | Notes 36–51 (FL calls 36 "C3"), velocity from the hit, poly aftertouch while held |
| Play        | Play / pause                                                                      |
| Stop        | Stop                                                                              |
| Restart     | Stop, then play from the start                                                    |
| Rec         | Arm/disarm recording                                                              |
| Shift + Rec | Count-in on/off                                                                   |
| Tap         | Tap tempo                                                                         |
| Shift + Tap | Metronome on/off                                                                  |
