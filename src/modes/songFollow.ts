// SCENE's FOLLOW: the MK3 shows only the channels of the song that is playing. A live set made with Skarv has a
// playlist marker per song and a channel rack filter group per song, named alike (marker "swesyntmaster", group
// "2 swesyntmaster"). FL's scripting API can neither read the groups nor switch FL's filter, so mk3d reads the
// groups from the project file FL saved (fl/projectFile.ts) and, whenever the song position is in another
// marker's section, sends the FL script that group's channels (SET_CHANNEL_VIEW): every page then counts
// channels in that list, and FL's channel rack outlines them. A marker without a group of its name, or no
// project file, shows every channel. FOLLOW is off by default; SCENE's display 4 turns it on and it is saved.
//
// It runs whatever page is up (main.ts hands it every FL change), and it needs FL's channel rack filter on "All"
// (the script turns the view off otherwise and PROJECT says so).
import type { FlState, FlSection } from "../fl/flState.js";
import { channelsOfGroup, groupOfMarker } from "../fl/flpGroups.js";
import {
  findProjectFile,
  projectNameFromTitle,
  savedMarkerName,
  savedSince,
  type FoundProject,
} from "../fl/projectFile.js";
import type { FlCommand } from "../fl/sysex.js";
import { currentMarker, markerName } from "./markerPage.js";

export interface SongFollowOptions {
  fl: FlState;
  send: (command: FlCommand) => void;
  log?: (line: string) => void;
  /** Something SCENE shows changed. */
  changed?: () => void;
  /** Finds the project file (tests pass their own). */
  find?: (title: string, markers: readonly string[]) => Promise<FoundProject | undefined>;
  /** Has the file been saved since it was read? */
  saved?: (found: FoundProject) => Promise<boolean>;
}

/** What SCENE shows about FOLLOW. */
export interface FollowStatus {
  /** The group whose channels are shown; undefined: every channel. */
  group?: string;
  /** Why the view is off or can't be worked out. */
  problem?: string;
}

export class SongFollow {
  private on = false;
  private found: FoundProject | undefined;
  /** What the project file was looked for with: FL's title, load count and marker names. */
  private lookedFor: string | undefined;
  private looking = false;
  /** The channels the script was last sent, as text; undefined: none sent since the script (re)started. */
  private sent: string | undefined;
  private marker = -2;
  private load = -1;
  private status: FollowStatus = {};
  private readonly find: NonNullable<SongFollowOptions["find"]>;
  private readonly saved: NonNullable<SongFollowOptions["saved"]>;

  constructor(private readonly options: SongFollowOptions) {
    this.find = options.find ?? ((title, markers) => findProjectFile(title, markers));
    this.saved = options.saved ?? savedSince;
  }

  get enabled(): boolean {
    return this.on;
  }

  get current(): Readonly<FollowStatus> {
    return this.status;
  }

  /** The file the groups come from, for the log and tests. */
  get file(): string | undefined {
    return this.found?.path;
  }

  setEnabled(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.marker = -2;
    this.lookUp();
    this.update();
  }

  onFlChange(section: FlSection): void {
    const { fl } = this.options;
    if (section === "connection") {
      this.sent = undefined; // a new script, or none: it has no view
      this.marker = -2;
      if (fl.connected) this.update();
      return;
    }
    if (section === "project") {
      if (fl.project.load !== this.load) {
        // FL loaded a project (maybe the same one again): the script took the view away, and the file may differ.
        this.load = fl.project.load;
        this.sent = undefined;
        this.found = undefined;
        this.lookedFor = undefined;
        this.marker = -2;
      }
      this.lookUp();
      this.update();
      return;
    }
    if (section === "markers") {
      this.lookUp();
      this.update();
      return;
    }
    if (section === "songPos") this.update();
  }

  private markerNames(): string[] {
    const { fl } = this.options;
    return Array.from({ length: fl.markerTotal }, (_, i) => fl.markers.get(i)?.name ?? "");
  }

  /** Find and read the project file again when FL's title, load or markers say it is another one. */
  private lookUp(): void {
    const { fl } = this.options;
    if (!this.on || !fl.connected || this.looking || !fl.project.title) return;
    if (fl.markers.size < fl.markerTotal) return; // the marker list is still arriving
    const markers = this.markerNames();
    // Without markers only a title with the project's name can find the file (FL 2026's has none): wait for them.
    if (markers.length === 0 && !projectNameFromTitle(fl.project.title)) return;
    const key = JSON.stringify([fl.project.title, fl.project.load, markers]);
    if (key === this.lookedFor) return;
    this.lookedFor = key;
    this.looking = true;
    void this.find(fl.project.title, markers)
      .then((found) => {
        this.found = found;
        this.log(
          found
            ? `FOLLOW: channel groups from ${found.path} (${found.project.groups.length} groups, ${found.project.channelGroups.length} channels)`
            : `FOLLOW: no project file found for FL's title "${fl.project.title}"`,
        );
      })
      .catch((error: unknown) => {
        this.found = undefined;
        this.log(`FOLLOW: reading the project file failed: ${String(error)}`);
      })
      .finally(() => {
        this.looking = false;
        this.lookUp(); // FL may have said more meanwhile
        this.update();
      });
  }

  /** Has FL saved the project since it was read? Then read it again (the groups may have changed). */
  private recheck(): void {
    const found = this.found;
    if (!found || this.looking) return;
    void this.saved(found).then((saved) => {
      if (!saved || this.found !== found || this.looking) return;
      this.lookedFor = undefined;
      this.found = undefined;
      this.lookUp();
    });
  }

  private update(): void {
    const { fl } = this.options;
    if (!fl.connected) return;
    const marker = this.on ? currentMarker(fl) : -1;
    // The song went on to another marker (not FOLLOW coming on, or FL saying its state again).
    const markerMoved = this.marker !== -2 && marker !== this.marker;
    this.marker = marker;
    let channels: number[] = [];
    let status: FollowStatus = {};
    if (this.on) {
      const found = this.found;
      if (!found) status = { problem: this.looking ? "Reading the project…" : "No project file" };
      else if (marker >= 0) {
        const name = savedMarkerName(markerName(fl, marker), found.project.markers);
        const group = groupOfMarker(found.project, name);
        if (group >= 0) {
          channels = channelsOfGroup(found.project, group);
          status = { group: found.project.groups[group] };
        }
      }
      if (fl.project.filtered) status = { ...status, problem: "FL's channel filter isn't \"All\"" };
      if (markerMoved) this.recheck();
    }
    if (status.group !== this.status.group || status.problem !== this.status.problem) {
      this.status = status;
      this.options.changed?.();
    }
    const key = channels.join(",");
    if (key === this.sent) return;
    if (this.sent === undefined && key === "") {
      this.sent = key; // the script starts without a view
      return;
    }
    this.sent = key;
    this.options.send({ type: "setChannelView", channels });
    this.log(
      channels.length > 0
        ? `FOLLOW: ${markerName(fl, marker)} → group "${status.group ?? ""}", ${channels.length} channels`
        : "FOLLOW: every channel",
    );
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}
