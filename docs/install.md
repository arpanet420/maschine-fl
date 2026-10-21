# Installing mk3d

mk3d is installed with **Homebrew**, the usual way to install command-line tools on a Mac, or from a
git clone. Both give you one command, `mk3d`, that does the rest.

## With Homebrew

```bash
brew tap arpanet420/maschine-fl https://github.com/arpanet420/maschine-fl
brew install --HEAD maschine-fl      # no release is tagged yet, so --HEAD
mk3d setup --service
```

`mk3d setup --service` checks Node, links the FL Studio script into
`~/Documents/Image-Line/FL Studio/Settings/Hardware/`, and installs a per-user LaunchAgent so mk3d
starts at login and restarts if it dies. Then do FL's MIDI settings (below).

The repository is currently private, so `brew tap` needs a GitHub login that can read it
(`gh auth login`, or a credential helper for git).

**UNVERIFIED:** the formula (`Formula/maschine-fl.rb`) has only been syntax-checked with `ruby -c`;
Homebrew was not available when it was written.

## From a git clone

```bash
git clone https://github.com/arpanet420/maschine-fl.git
cd maschine-fl
npm install
./bin/mk3d setup --service
```

`setup` runs `npm install && npm run build` itself if `dist/` is missing. Use `./bin/mk3d` from the
clone, or put it on your PATH (`ln -s "$PWD/bin/mk3d" /usr/local/bin/mk3d`).

## First run: FL Studio

Options > **MIDI Settings**. mk3d must be running for the ports to be listed (`mk3d status`).

1. **Input**: select **MK3 Bridge**, tick **Enable**, set **Controller type** to **MK3 Bridge**, and
   give it a **Port** number, e.g. 10.
2. **Output**: select **MK3 Bridge FB** and set the **same** Port number.
3. Leave **Maschine MK3** disabled in both lists.

`mk3d doctor` checks everything it can see from outside FL.

## Commands

| Command                                      | What                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `mk3d setup [--service]`                     | Link the FL script; with `--service` also install the LaunchAgent       |
| `mk3d run`                                   | Run the daemon in the foreground (Ctrl-C stops it)                      |
| `mk3d start` / `stop` / `restart` / `status` | Control the LaunchAgent (`stop --restore-ni` also restarts NI's agents) |
| `mk3d logs [--no-follow]`                    | `~/Library/Logs/mk3d.log`                                               |
| `mk3d doctor`                                | One line per check; exit status 1 if one failed, each with its fix      |
| `mk3d uninstall [--restore-ni]`              | Remove the LaunchAgent and the FL script link                           |

The LaunchAgent is `~/Library/LaunchAgents/io.github.arpanet420.mk3d.plist` (`mk3d service print`
shows it). When started by launchd, mk3d first tries `scripts/ni-agents.sh stop` so NI's hardware
agents don't hold the MK3, and trims its log to the last 1000 lines when it passes 5 MB.

## Upgrading

- Homebrew: `brew upgrade --fetch-HEAD maschine-fl` (HEAD installs need `--fetch-HEAD`), then
  `mk3d setup` (the FL link and the LaunchAgent use Homebrew's stable `opt` path, so this is only
  needed if `mk3d doctor` complains) and `mk3d restart`.
- Clone: `git pull && npm install && npm run build && ./bin/mk3d setup`, then `mk3d restart`.

## Uninstalling

```bash
mk3d uninstall --restore-ni
brew uninstall maschine-fl      # or delete the clone
```

This leaves `~/Library/Application Support/mk3d` (your settings and pins) and the log. It never
touches NI's files or FL Studio's own files.

## Requirements and native modules

Node 22 or newer (`engines` in package.json). The code uses nothing newer than Node 22's standard
library and ES2023; the owner develops with Node 24. The four native dependencies ship prebuilt
macOS binaries, so no Xcode command line tools are needed to install:

| Package           | Prebuilt macOS binary                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `usb`             | `@node-usb/usb-darwin-arm64` and `-darwin-x64` (optional dependencies, npm picks the right one) |
| `node-hid`        | `prebuilds/HID-darwin-arm64` and `HID-darwin-x64` inside the package                            |
| `@julusian/midi`  | `prebuilds/midi-darwin-arm64` and `midi-darwin-x64` inside the package                          |
| `@napi-rs/canvas` | `@napi-rs/canvas-darwin-arm64` and `-darwin-x64` (optional dependencies)                        |

Checked on Apple Silicon: `npm ci --omit=dev` after the build leaves a tree where all four load.
The Intel binaries were not run.

## Troubleshooting

- **The MK3 is busy / mk3d prints "Waiting for the MK3"**: NI's hardware agents or NI software hold
  the device. `scripts/ni-agents.sh stop` (quit Maschine and Controller Editor first), or let the
  service do it: `mk3d start`. `mk3d doctor` shows whether the agents are running.
- **FL doesn't list MK3 Bridge**: mk3d is not running. `mk3d status`, `mk3d logs`.
- **Works with `mk3d run` in Terminal but not as a service**: macOS may ask for permission the first
  time a launchd-started `node` opens the MK3. If the log shows it cannot open the device, add `node`
  (the path in `mk3d doctor`) under System Settings > Privacy & Security > Input Monitoring.
  UNVERIFIED: not tried with the real service.
- **Node not found by launchd**: `mk3d service install` writes the directory of the `node` found at
  that time into the agent's PATH. After switching Node versions or managers, run
  `mk3d service install` again.

## Why not a .pkg or an .app?

An installer package or app bundle that other people can open without a Gatekeeper warning must be
signed with an Apple **Developer ID** (paid Apple developer account) and **notarised** by Apple. An
unsigned one is blocked by default on other people's Macs. Homebrew builds from source on the user's
machine, so it needs neither.
