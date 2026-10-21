// Owns the MK3's HID interface: opens it, reconnects after unplugging, delivers raw reports.
import { EventEmitter } from "node:events";
import HID from "node-hid";
import { usb } from "usb";
import { MK3_PRODUCT_ID, NI_VENDOR_ID } from "./usbIds.js";

// The only output reports mk3d may send (LEDs). Everything else is off limits (docs/protocol.md).
const WRITABLE_REPORTS = new Set([0x80, 0x81]);

export interface Mk3DeviceOptions {
  /** How often to look for the device while it is not connected. */
  pollMs?: number;
  /** Seize the device so no other process gets its input. Falls back to shared if refused. */
  exclusive?: boolean;
}

export interface Mk3DeviceEvents {
  connected: [info: { serial: string | undefined; exclusive: boolean }];
  disconnected: [reason: string];
  /** Emitted once per distinct reason while the device can't be opened. */
  unavailable: [reason: string];
  report: [report: Uint8Array];
}

const EXCLUSIVE_ACCESS = /0xE00002C5/i;

export class Mk3Device extends EventEmitter<Mk3DeviceEvents> {
  private hid: HID.HIDAsync | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private running = false;
  private lastUnavailable: string | undefined;
  private readonly pollMs: number;
  private readonly exclusive: boolean;

  constructor(options: Mk3DeviceOptions = {}) {
    super();
    this.pollMs = options.pollMs ?? 1000;
    this.exclusive = options.exclusive ?? true;
  }

  get connected(): boolean {
    return this.hid !== undefined;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.retryTimer);
    const hid = this.hid;
    this.hid = undefined;
    await hid?.close();
  }

  async write(report: Uint8Array): Promise<void> {
    const id = report[0];
    if (id === undefined || !WRITABLE_REPORTS.has(id)) {
      throw new Error(`Refusing to send HID report ${id}: only 0x80 and 0x81 are allowed`);
    }
    if (!this.hid) throw new Error("Maschine MK3 is not connected");
    await this.hid.write(Array.from(report));
  }

  private async connect(): Promise<void> {
    if (!this.running || this.hid) return;
    const info = HID.devices(NI_VENDOR_ID, MK3_PRODUCT_ID)[0];
    if (!info?.path) {
      this.unavailable("Maschine MK3 not found. Is it plugged in and powered?");
      return;
    }

    let hid: HID.HIDAsync;
    let exclusive = this.exclusive;
    try {
      hid = await HID.HIDAsync.open(info.path, { nonExclusive: !exclusive });
    } catch (err) {
      // A non-exclusive handle may still work if another process only shares the device.
      exclusive = false;
      try {
        hid = await HID.HIDAsync.open(info.path, { nonExclusive: true });
      } catch {
        this.unavailable(
          EXCLUSIVE_ACCESS.test(String(err))
            ? "Another program has the MK3 open exclusively (a running inputlog/ledtest, or NI's agent)."
            : `Could not open the MK3: ${String(err)}`,
        );
        return;
      }
    }

    if (!this.running) {
      await hid.close();
      return;
    }
    this.hid = hid;
    this.lastUnavailable = undefined;
    hid.on("data", (data: Buffer) => this.emit("report", new Uint8Array(data)));
    hid.on("error", (err: unknown) => void this.lost(String(err)));
    this.emit("connected", { serial: info.serialNumber, exclusive });
  }

  private async lost(reason: string): Promise<void> {
    const hid = this.hid;
    if (!hid) return;
    this.hid = undefined;
    hid.removeAllListeners();
    await hid.close().catch(() => undefined);
    this.emit("disconnected", reason);
    this.scheduleRetry();
  }

  private unavailable(reason: string): void {
    if (reason !== this.lastUnavailable) {
      this.lastUnavailable = reason;
      this.emit("unavailable", reason);
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (!this.running) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), this.pollMs);
  }
}

/**
 * Standard USB port reset: the MK3 re-enumerates as if replugged. Used to wake it after NI's
 * agent has left it silent. Not a firmware command.
 */
export async function resetMk3Usb(): Promise<void> {
  const device = (await usb.getDevices()).find(
    (d) => d.vendorId === NI_VENDOR_ID && d.productId === MK3_PRODUCT_ID,
  );
  if (!device) throw new Error("Maschine MK3 not found");
  await device.open();
  try {
    await device.reset();
  } finally {
    await device.close().catch(() => undefined);
  }
}
