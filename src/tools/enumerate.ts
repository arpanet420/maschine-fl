// Lists every Native Instruments USB device, as seen by hidapi (node-hid) and the `usb` package.
// Read-only: no interface is claimed and nothing is written to the device.
import HID from "node-hid";
import { usb } from "usb";
import { NI_VENDOR_ID, MK3_PRODUCT_ID, hex2, hex4 } from "../hw/usbIds.js";

const CLASS_NAMES: Record<number, string> = {
  0x01: "audio",
  0x03: "HID",
  0xfe: "application-specific",
  0xff: "vendor-specific",
};

function listHid() {
  const devices = HID.devices().filter((d) => d.vendorId === NI_VENDOR_ID);
  console.log(`\n== hidapi (node-hid): ${devices.length} NI HID interface(s)`);
  for (const d of devices) {
    const mk3 = d.productId === MK3_PRODUCT_ID ? "  <-- Maschine MK3" : "";
    console.log(`- ${d.product ?? "?"} ${hex4(d.vendorId)}:${hex4(d.productId)}${mk3}`);
    console.log(
      `    interface=${d.interface} usagePage=${hex4(d.usagePage ?? 0)} usage=${hex4(d.usage ?? 0)}`,
    );
    console.log(
      `    serial=${d.serialNumber ?? "?"} release=${d.release !== undefined ? hex4(d.release) : "?"}`,
    );
    console.log(`    path=${d.path}`);
  }
  return devices;
}

function describeConfiguration(config: USBConfiguration) {
  console.log(
    `    configuration ${config.configurationValue}, ${config.interfaces.length} interface(s):`,
  );
  for (const iface of config.interfaces) {
    for (const alt of iface.alternates) {
      const cls = CLASS_NAMES[alt.interfaceClass] ?? hex2(alt.interfaceClass);
      console.log(
        `    - interface ${iface.interfaceNumber} alt ${alt.alternateSetting}: class ${cls}` +
          ` subclass ${hex2(alt.interfaceSubclass)} protocol ${hex2(alt.interfaceProtocol)}` +
          (alt.interfaceName ? ` "${alt.interfaceName}"` : ""),
      );
      for (const ep of alt.endpoints) {
        const address = ep.endpointNumber | (ep.direction === "in" ? 0x80 : 0);
        console.log(
          `        endpoint ${hex2(address)} ${ep.direction.toUpperCase().padEnd(3)} ${ep.type}` +
            ` packetSize=${ep.packetSize}`,
        );
      }
    }
  }
}

async function listUsb() {
  const devices = (await usb.getDevices()).filter((d) => d.vendorId === NI_VENDOR_ID);
  console.log(`\n== usb: ${devices.length} NI USB device(s)`);
  for (const d of devices) {
    const mk3 = d.productId === MK3_PRODUCT_ID ? "  <-- Maschine MK3" : "";
    const firmware = `${d.deviceVersionMajor}.${d.deviceVersionMinor}.${d.deviceVersionSubminor}`;
    console.log(
      `- ${d.productName ?? "?"} ${hex4(d.vendorId)}:${hex4(d.productId)} bus ${d.bus} address ${d.address}` +
        ` speed=${d.speed ?? "?"} firmware=${firmware}${mk3}`,
    );
    try {
      for (const config of d.configurations) describeConfiguration(config);
    } catch (err) {
      console.log(`    could not read configuration descriptors: ${String(err)}`);
    }
  }
  return devices;
}

// Opens the MK3 HID interface (read-only) and counts incoming reports per report ID.
// This is what triggers macOS's Input Monitoring prompt, if one is needed.
async function probeHidInput(path: string, seconds: number) {
  console.log(`\n== Reading HID input for ${seconds} s. Press some pads and buttons…`);
  let device: HID.HIDAsync;
  try {
    device = await HID.HIDAsync.open(path, { nonExclusive: true });
  } catch (err) {
    console.log(`Could not open the HID interface: ${String(err)}`);
    console.log("If macOS showed an Input Monitoring prompt, allow your terminal app and retry.");
    process.exitCode = 2;
    return;
  }
  const counts = new Map<number, number>();
  device.on("data", (data: Buffer) => {
    const id = data[0] ?? -1;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  });
  device.on("error", (err: unknown) => console.log(`HID error: ${String(err)}`));
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  await device.close();
  if (counts.size === 0) {
    console.log("No reports received. Another process (NI's agent) may own the device.");
    return;
  }
  for (const [id, n] of [...counts].sort((a, b) => a[0] - b[0])) {
    console.log(`  report ${hex2(id)}: ${n}`);
  }
}

const hid = listHid();
const usbDevices = await listUsb();
const mk3Hid = hid.find((d) => d.productId === MK3_PRODUCT_ID);
const mk3Found = mk3Hid !== undefined || usbDevices.some((d) => d.productId === MK3_PRODUCT_ID);
console.log(
  mk3Found ? "\nMaschine MK3 found." : "\nNo Maschine MK3 found. Is it plugged in and powered?",
);
process.exitCode = mk3Found ? 0 : 1;

if (process.argv.includes("--open") && mk3Hid?.path) {
  await probeHidInput(mk3Hid.path, 5);
}
