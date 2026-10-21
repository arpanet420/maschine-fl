// bin/mk3d: the install and service command. Runs against a temp MK3D_HOME with launchctl and the NI
// agent script replaced by printouts; it never touches the real launchd, FL Studio or the MK3.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "..");
const MK3D = join(REPO, "bin", "mk3d");
const LABEL = "io.github.arpanet420.mk3d";

let home: string;
let hardware: string;
let link: string;

function run(args: string[], bin = MK3D) {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    env: { ...process.env, MK3D_HOME: home, MK3D_NO_LAUNCHCTL: "1" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

beforeAll(() => {
  if (!existsSync(join(REPO, "dist", "main.js"))) {
    const r = spawnSync("npm", ["run", "build"], { cwd: REPO, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`npm run build failed: ${r.stdout}${r.stderr}`);
  }
}, 120_000);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mk3d-cli-"));
  hardware = join(home, "Documents", "Image-Line", "FL Studio", "Settings", "Hardware");
  mkdirSync(hardware, { recursive: true });
  link = join(hardware, "MK3Bridge");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("setup", () => {
  it("links the FL script and is idempotent", () => {
    const first = run(["setup"]);
    expect(first.code).toBe(0);
    expect(readlinkSync(link)).toBe(join(REPO, "fl-script", "MK3Bridge"));
    expect(first.out).toContain("MK3 Bridge FB");
    const second = run(["setup"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("already linked");
    expect(readlinkSync(link)).toBe(join(REPO, "fl-script", "MK3Bridge"));
  });

  it("says to start FL Studio once when its folder is missing", () => {
    rmSync(join(home, "Documents"), { recursive: true });
    const r = run(["setup"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Start FL Studio once");
  });

  it("refuses to replace a real directory", () => {
    mkdirSync(link);
    const r = run(["setup"]);
    expect(r.code).toBe(1);
    expect(lstatSync(link).isDirectory()).toBe(true);
  });

  it("refuses to replace a foreign link", () => {
    const foreign = join(home, "elsewhere", "Other");
    mkdirSync(foreign, { recursive: true });
    symlinkSync(foreign, link);
    const r = run(["setup"]);
    expect(r.code).toBe(1);
    expect(readlinkSync(link)).toBe(foreign);
  });

  it("updates a link to an older install of ours", () => {
    const old = join(home, "old-clone");
    mkdirSync(join(old, "fl-script", "MK3Bridge"), { recursive: true });
    writeFileSync(join(old, "package.json"), '{ "name": "maschine-fl" }\n');
    symlinkSync(join(old, "fl-script", "MK3Bridge"), link);
    const r = run(["setup"]);
    expect(r.code).toBe(0);
    expect(readlinkSync(link)).toBe(join(REPO, "fl-script", "MK3Bridge"));
  });

  it("setup --service also installs the LaunchAgent", () => {
    const r = run(["setup", "--service"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(home, "Library", "LaunchAgents", `${LABEL}.plist`))).toBe(true);
    expect(r.out).toContain("launchctl bootstrap");
  });
});

describe("service", () => {
  it("print has the label, keep-alive, log paths and the program", () => {
    const r = run(["service", "print"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`<string>${LABEL}</string>`);
    expect(r.out).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(r.out).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(r.out).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    expect(r.out).toContain("<string>Interactive</string>");
    const log = join(home, "Library", "Logs", "mk3d.log");
    expect(r.out).toMatch(new RegExp(`<key>StandardOutPath</key>\\s*<string>${log}</string>`));
    expect(r.out).toMatch(new RegExp(`<key>StandardErrorPath</key>\\s*<string>${log}</string>`));
    expect(r.out).toContain(`<string>${join(REPO, "bin", "mk3d")}</string>`);
    expect(r.out).toContain("<string>--service</string>");
    expect(r.out).toContain("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  });

  it("install writes the plist and prints the launchctl calls", () => {
    const r = run(["service", "install"]);
    expect(r.code).toBe(0);
    const plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    expect(readFileSync(plist, "utf8")).toContain(LABEL);
    expect(r.out).toContain(`launchctl bootstrap gui/${process.getuid?.()} ${plist}`);
  });

  it("uses the stable opt path for a Homebrew (Cellar) install", () => {
    const prefix = join(realpathSync(home), "prefix");
    const libexec = join(prefix, "Cellar", "maschine-fl", "1.2.3", "libexec");
    mkdirSync(join(libexec, "bin"), { recursive: true });
    copyFileSync(MK3D, join(libexec, "bin", "mk3d"));
    spawnSync("chmod", ["+x", join(libexec, "bin", "mk3d")]);
    writeFileSync(join(libexec, "package.json"), '{ "name": "maschine-fl", "version": "1.2.3" }\n');
    mkdirSync(join(prefix, "bin"), { recursive: true });
    symlinkSync(join(libexec, "bin", "mk3d"), join(prefix, "bin", "mk3d"));
    const viaLink = join(prefix, "bin", "mk3d");
    expect(run(["version"], viaLink).out).toContain("1.2.3");
    const r = run(["service", "print"], viaLink);
    expect(r.out).toContain(
      `<string>${join(prefix, "opt", "maschine-fl", "libexec", "bin", "mk3d")}</string>`,
    );
    expect(r.out).not.toContain("Cellar");
  });
});

describe("uninstall", () => {
  it("removes the plist and our link", () => {
    run(["setup", "--service"]);
    const r = run(["uninstall"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(home, "Library", "LaunchAgents", `${LABEL}.plist`))).toBe(false);
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
    expect(r.out).toContain("Application Support/mk3d");
  });

  it("leaves a foreign link alone", () => {
    const foreign = join(home, "elsewhere", "Other");
    mkdirSync(foreign, { recursive: true });
    symlinkSync(foreign, link);
    const r = run(["uninstall"]);
    expect(r.code).toBe(0);
    expect(readlinkSync(link)).toBe(foreign);
    expect(r.out).toContain("not ours");
  });
});

describe("misc", () => {
  it("help exits 0, unknown commands exit 2 with the usage", () => {
    expect(run(["help"]).code).toBe(0);
    const bad = run(["frobnicate"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("Usage: mk3d");
  });

  it("version prints the package version", () => {
    expect(run(["version"]).out).toMatch(/^mk3d \d+\.\d+\.\d+/);
  });

  it("doctor prints a line per check and a fix for each failure", () => {
    rmSync(join(home, "Documents"), { recursive: true });
    const r = run(["doctor"]);
    expect([0, 1]).toContain(r.code);
    expect(r.out).toContain("Node");
    expect(r.out).toContain("✗ FL Studio hardware folder not found");
    expect(r.out).toContain("mk3d setup");
    expect(r.code).toBe(1);
  });
});
