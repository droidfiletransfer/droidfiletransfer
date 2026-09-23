// Copyright (C) 2026 Aron Sommer. See LICENSE file for full license details.

// MTP (Media Transfer Protocol) over WebUSB.
//
// Wire format is PTP/PIMA-15740: every transaction is a 12-byte container
// header followed by an optional payload. Everything here was checked against
// Android's own responder. Comments cite these sources by tag:
//
//   [mtp.h]        https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/mtp/mtp.h
//   [MtpServer]    https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/mtp/MtpServer.cpp
//   [MtpFfs]       https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/mtp/MtpFfsHandle.cpp
//   [MtpString]    https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/mtp/MtpStringBuffer.cpp
//   [MtpUtils]     https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/mtp/MtpUtils.cpp
//   [Datasets]     https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/mtp/MtpDeviceInfo.cpp
//                  (also MtpStorageInfo.cpp and MtpObjectInfo.cpp in the same directory)
//   [Descriptors]  https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/mtp/MtpDescriptors.cpp
//   [f_mtp]        https://android.googlesource.com/kernel/msm/+/refs/heads/android-msm-wahoo-4.4-pie/drivers/usb/gadget/function/f_mtp.c
//   [MtpDatabase]  https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/media/java/android/mtp/MtpDatabase.java
//   [PropGroup]    https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/media/java/android/mtp/MtpPropertyGroup.java
//   [JNI]          https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/media/jni/android_mtp_MtpDatabase.cpp
//   [WebUSB]       https://usb.spec.whatwg.org/
//   [Blink]        https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webusb/usb_device.cc
//
// "Observed" marks behaviour seen while testing with real phones, not read
// from a source.

// Operation codes [mtp.h MTP_OPERATION_*].
export const OP = {
  GetDeviceInfo: 0x1001,
  OpenSession: 0x1002,
  CloseSession: 0x1003,
  GetStorageIDs: 0x1004,
  GetStorageInfo: 0x1005,
  GetObjectHandles: 0x1007,
  GetObjectInfo: 0x1008,
  GetObject: 0x1009,
  DeleteObject: 0x100b,
  SendObjectInfo: 0x100c,
  SendObject: 0x100d,
  GetObjectPropValue: 0x9803,
  SetObjectPropValue: 0x9804,
  GetObjectPropList: 0x9805,
};

// Container types [mtp.h MTP_CONTAINER_TYPE_*].
const TYPE = { COMMAND: 1, DATA: 2, RESPONSE: 3, EVENT: 4 };

const RESP_OK = 0x2001;

// Response codes worth naming [mtp.h MTP_RESPONSE_*]; anything else is
// reported as raw hex.
const RESP_NAMES = {
  0x2002: "General error",
  0x2003: "Session not open",
  0x2005: "Operation not supported",
  0x2006: "Parameter not supported",
  0x2007: "Incomplete transfer",
  0x2008: "Invalid storage ID",
  0x2009: "Invalid object handle",
  0x200a: "Device property not supported",
  0x200c: "Storage full",
  0x200d: "Object write-protected",
  0x200e: "Store read-only",
  0x200f: "Access denied",
  0x2012: "Partial deletion",
  0x2013: "Store not available",
  0x2015: "No valid object info",
  0x2019: "Device busy",
  0x201a: "Invalid parent object",
  0x201d: "Invalid parameter",
  0x201e: "Session already open",
  0x201f: "Transaction cancelled",
  0xa808: "Specification by depth unsupported",
  0xa809: "Object too large",
  0xa80a: "Object property not supported",
};

// Object format codes [mtp.h MTP_FORMAT_*]. Only the folder marker changes
// behaviour here.
const FMT_ASSOCIATION = 0x3001;
const FMT_UNDEFINED = 0x3000;

// Object property codes [mtp.h MTP_PROPERTY_*].
const PROP = {
  ObjectFormat: 0xdc02,
  ObjectSize: 0xdc04,
  FileName: 0xdc07,
  DateModified: 0xdc09,
  ParentObject: 0xdc0b,
};

// Parent handle that means "the root of the storage" in requests
// [MtpServer doGetObjectHandles].
export const ROOT_PARENT = 0xffffffff;

// Turn on from the console with: localStorage.mtpDebug = "1"  (then reload)
const DEBUG = (() => {
  try {
    return localStorage.getItem("mtpDebug") === "1";
  } catch {
    return false;
  }
})();

const OP_NAMES = Object.fromEntries(Object.entries(OP).map(([name, code]) => [code, name]));

class MtpError extends Error {
  constructor(code, op) {
    super(RESP_NAMES[code] || `MTP response 0x${code.toString(16)}`);
    this.code = code;
    this.op = op;
    // Named rather than hex so a console log is readable on its own.
    this.operation = OP_NAMES[op];
  }
}

/* ------------------------------------------------------------------ */
/* little-endian readers/writers over the payload buffers             */
/* ------------------------------------------------------------------ */

class Reader {
  constructor(bytes) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.o = 0;
  }
  u8() {
    return this.dv.getUint8(this.o++);
  }
  u16() {
    const v = this.dv.getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  u32() {
    const v = this.dv.getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  u64() {
    const v = this.dv.getBigUint64(this.o, true);
    this.o += 8;
    return Number(v);
  }
  i8() {
    return this.dv.getInt8(this.o++);
  }
  i16() {
    const v = this.dv.getInt16(this.o, true);
    this.o += 2;
    return v;
  }
  i32() {
    const v = this.dv.getInt32(this.o, true);
    this.o += 4;
    return v;
  }
  i64() {
    const v = this.dv.getBigInt64(this.o, true);
    this.o += 8;
    return Number(v);
  }
  skip(n) {
    this.o += n;
  }

  // MTP string: u8 count of UTF-16 code units including the trailing NUL,
  // then UTF-16LE; a count of 0 is the empty string [MtpString readFromPacket].
  str() {
    const n = this.u8();
    if (n === 0) return "";
    let s = "";
    for (let i = 0; i < n - 1; i++) s += String.fromCharCode(this.u16());
    this.u16(); // trailing NUL
    return s;
  }

  // u32 count followed by that many fixed-width elements.
  array(readOne) {
    const n = this.u32();
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = readOne();
    return out;
  }
}

class Writer {
  constructor() {
    this.parts = [];
    this.len = 0;
  }
  _push(bytes) {
    this.parts.push(bytes);
    this.len += bytes.length;
  }
  u8(v) {
    this._push(new Uint8Array([v & 0xff]));
  }
  u16(v) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this._push(b);
  }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this._push(b);
  }
  u64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    this._push(b);
  }
  // Same layout as Reader.str() [MtpString writeToPacket]. The count is one
  // byte, so a name of 255 or more UTF-16 code units cannot be sent.
  str(s) {
    if (!s) {
      this.u8(0);
      return;
    }
    if (s.length > 254) throw new Error("Name too long for MTP (255 characters or more)");
    this.u8(s.length + 1);
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    this.u16(0);
  }
  bytes() {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

// Value of a GetObjectPropList element, tagged with its datatype
// [mtp.h MTP_TYPE_*; JNI getObjectPropertyList writes them].
function readTypedValue(r, type) {
  switch (type) {
    case 0x0001:
      return r.i8();
    case 0x0002:
      return r.u8();
    case 0x0003:
      return r.i16();
    case 0x0004:
      return r.u16();
    case 0x0005:
      return r.i32();
    case 0x0006:
      return r.u32();
    case 0x0007:
      return r.i64();
    case 0x0008:
      return r.u64();
    case 0x000a:
      r.skip(16);
      return 0; // UINT128, Android's persistent UID [PropGroup]
    case 0xffff:
      return r.str();
    default:
      throw new Error(`Unhandled MTP datatype 0x${type.toString(16)}`);
  }
}

// Android writes timestamps as "YYYYMMDDThhmmss" in local time and reads a
// trailing Z as UTC, but never writes one [MtpUtils formatDateTime,
// parseDateTime], so this parser ignores anything after the seconds.
function parseMtpDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(s || "");
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +sec);
}

/* ------------------------------------------------------------------ */
/* device                                                              */
/* ------------------------------------------------------------------ */

// requestDevice filters. Android's userspace MTP responder uses Still Image,
// class 6 subclass 1 protocol 1, for both MTP and PTP mode [Descriptors]; the
// older kernel driver used vendor-specific 0xff/0xff/0 for MTP [f_mtp]. Neither
// class is on WebUSB's protected list [WebUSB "Protected interface classes"].
// Observed: on macOS, ptpcamerad can hold a class 6 interface while Preview,
// Photos or Image Capture is open.
export const USB_FILTERS = [
  { classCode: 0xff, subclassCode: 0xff, protocolCode: 0 },
  { classCode: 0x06 },
];

// The bulk pair of an MTP interface, or null: the classes are the two in
// USB_FILTERS, and MTP needs a bulk endpoint in each direction.
function mtpEndpoints(alt) {
  const vendorMtp = alt.interfaceClass === 0xff && alt.interfaceSubclass === 0xff;
  if (!vendorMtp && alt.interfaceClass !== 0x06) return null;
  const epIn = alt.endpoints.find((e) => e.direction === "in" && e.type === "bulk");
  const epOut = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
  return epIn && epOut ? { epIn, epOut } : null;
}

// The configuration open() works in: the one the device is already in, or
// configuration 1, which open() selects when it is in none.
const usedConfig = (device) =>
  device.configuration ?? device.configurations.find((c) => c.configurationValue === 1);

// Descriptors are readable without opening the device, so the app can skip a
// device it was granted but cannot use -- a hub, a network adapter -- instead
// of opening it and failing. requestDevice() filters the chooser itself, but
// getDevices() and the connect event report every granted device. Only the
// used configuration counts: observed on a USB Ethernet adapter, an unused
// configuration held a vendor-specific bulk interface that looks exactly like
// the old MTP one.
export const offersMtp = (device) =>
  !!usedConfig(device)?.interfaces.some((i) => i.alternates.some((alt) => mtpEndpoints(alt)));

export class Mtp {
  constructor(device) {
    this.dev = device;
    this.txn = 0;
    this.session = 0;
    this.ops = new Set(); // opcodes the device said it supports
    this.tail = Promise.resolve(); // end of the transaction queue, see _serial()
    this.iface = null;
    this.epIn = 0;
    this.epOut = 0;
    this.pktIn = 512;
    this.pktOut = 512;
    this.lock = new AbortController(); // aborted to release the tab lock, see open()
  }

  supports(op) {
    return this.ops.has(op);
  }

  /* ---- connection ---- */

  async open() {
    await retryWhileBusy(async () => {
      if (!this.dev.opened) await this.dev.open();
      if (this.dev.configuration === null) await this.dev.selectConfiguration(1);
    });

    // Only a device picked in the chooser reaches this: the automatic paths
    // skip what offersMtp() rejects. The chooser lists whatever matches
    // USB_FILTERS, hubs and network adapters included, so name the device --
    // phone advice alone reads as nonsense for a LAN adapter.
    const found = this._findInterface();
    if (!found)
      throw new Error(
        `${this.dev.productName || "That device"} offers no file transfer. Pick your phone in ` +
          "the list instead, and if it is not there, unlock it and choose File transfer in its " +
          "USB notification.",
      );
    this.iface = found.iface;

    // Each tab holds a Web Lock per phone while it has the phone claimed, so a
    // failed claim can tell when another tab or window of this page holds it.
    const name = `phone ${this.dev.serialNumber}`;
    try {
      await retryWhileBusy(() => this.dev.claimInterface(this.iface.interfaceNumber));
    } catch (e) {
      const { held } = await navigator.locks.query();
      if (held.some((l) => l.name === name))
        throw new Error(
          "The phone is already connected in another tab or window. Close it, then click Choose phone.",
        );
      throw e;
    }
    const { signal } = this.lock;
    navigator.locks
      .request(name, { signal }, () => new Promise((r) => signal.addEventListener("abort", r)))
      .catch(() => {});
    if (found.alt.alternateSetting !== 0) {
      await this.dev.selectAlternateInterface(
        this.iface.interfaceNumber,
        found.alt.alternateSetting,
      );
    }

    this.epIn = found.epIn.endpointNumber;
    this.epOut = found.epOut.endpointNumber;
    this.pktIn = found.epIn.packetSize || 512;
    this.pktOut = found.epOut.packetSize || 512;

    // No class-level control requests here. Android treats Cancel (0x64) and
    // Device Reset (0x66) alike, as a cancel [MtpFfs handleControlRequest].
    // Observed: afterwards the phone reported no storage and answered nothing
    // until the cable was replugged. A stale response from a previous page is
    // skipped by _recvFor() instead.

    // A stale session survives a page reload, so tolerate "already open"
    // [MtpServer doOpenSession].
    try {
      await retryWhileBusy(() => this.command(OP.OpenSession, [1]));
    } catch (e) {
      if (e.code !== 0x201e) throw e;
    }
    this.session = 1;

    const info = await this.getDeviceInfo();
    this.ops = new Set(info.operations);
    return info;
  }

  // Teardown for page unload. An MTP round-trip cannot finish while the page
  // is being destroyed, and a half-sent one strands a response in the pipe --
  // so just drop the USB handle; the next open() tolerates the stale session.
  release() {
    this.session = 0;
    this.lock.abort();
    return this.dev.close().catch(() => {});
  }

  async close() {
    try {
      if (this.session) await this.command(OP.CloseSession);
    } catch {}
    try {
      if (this.iface) await this.dev.releaseInterface(this.iface.interfaceNumber);
    } catch {}
    try {
      await this.dev.close();
    } catch {}
    this.session = 0;
    this.lock.abort();
  }

  // An MTP interface is two bulk endpoints plus one interrupt endpoint
  // [Descriptors].
  _findInterface() {
    for (const iface of this.dev.configuration.interfaces) {
      for (const alt of iface.alternates) {
        const eps = mtpEndpoints(alt);
        if (eps) return { iface, alt, ...eps };
      }
    }
    return null;
  }

  /* ---- container plumbing ---- */

  // Container header: u32 total length, u16 type, u16 code, u32 transaction
  // ID [mtp.h MTP_CONTAINER_*_OFFSET].
  _header(type, code, txn, payloadLen) {
    const b = new Uint8Array(12);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 12 + payloadLen, true);
    dv.setUint16(4, type, true);
    dv.setUint16(6, code, true);
    dv.setUint32(8, txn, true);
    return b;
  }

  _log(...args) {
    if (DEBUG) console.log("[mtp]", ...args);
  }

  async _sendCommand(op, params, txn) {
    this._log(`-> ${OP_NAMES[op] || "0x" + op.toString(16)} txn=${txn}`, params);
    const w = new Writer();
    for (const p of params) w.u32(p);
    const body = w.bytes();
    const out = new Uint8Array(12 + body.length);
    out.set(this._header(TYPE.COMMAND, op, txn, body.length), 0);
    out.set(body, 12);
    await this._out(out);
  }

  async _out(data) {
    this._log(`   out ${data.length} bytes`);
    const r = await withTimeout(this.dev.transferOut(this.epOut, data), IO_TIMEOUT, STALLED);
    if (r.status !== "ok") throw new Error(`USB write failed: ${r.status}`);
    return r;
  }

  async _in(len) {
    const r = await withTimeout(this.dev.transferIn(this.epIn, len), IO_TIMEOUT, STALLED);
    if (r.status === "stall") {
      await this.dev.clearHalt("in", this.epIn);
      throw new Error("USB endpoint stalled");
    }
    if (r.status !== "ok") throw new Error(`USB read failed: ${r.status}`);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  // Android ends a data phase whose length is a multiple of the packet size
  // with a zero-length packet [MtpFfs sendFile, write]. When the last read
  // asked for exactly the remaining bytes, that packet is still in the pipe
  // and arrives as an empty read before the next container: skip it.
  async _inContainer(len) {
    const first = await this._in(len);
    return first.byteLength ? first : await this._in(len);
  }

  // Read one whole container into memory. Used for everything except bulk
  // file reads, which stream instead.
  async _recv() {
    const first = await this._inContainer(this.pktIn * 64);
    if (first.byteLength < 12) throw new Error("Short MTP container");

    const dv = new DataView(first.buffer, first.byteOffset, first.byteLength);
    const total = dv.getUint32(0, true);
    const head = {
      type: dv.getUint16(4, true),
      code: dv.getUint16(6, true),
      txn: dv.getUint32(8, true),
    };

    let body = first.subarray(12);
    // 0xffffffff: the length does not fit in 32 bits [MtpFfs sendFile]; only
    // _readBody() handles that.
    if (total !== 0xffffffff && total > first.byteLength) {
      const chunks = [body];
      let have = body.length;
      const want = total - 12;
      while (have < want) {
        const c = await this._in(Math.min(this.pktIn * 512, roundUp(want - have, this.pktIn)));
        chunks.push(c);
        have += c.length;
      }
      body = concat(chunks, have);
    }
    head.data = body;
    return head;
  }

  // A transaction that failed part-way leaves its response unread. Skip any
  // container that belongs to an earlier transaction rather than mistaking it
  // for this one's -- that is how a failed write used to break every
  // operation after it.
  async _recvFor(txn) {
    for (let i = 0; i < 8; i++) {
      const c = await this._recv();
      this._log(
        `<- type=${c.type} code=0x${c.code.toString(16)} txn=${c.txn} bytes=${c.data.length}`,
      );
      if (c.txn === txn || c.txn === 0) return c;
      console.warn(`MTP: discarded stale container (txn ${c.txn}, want ${txn})`);
    }
    throw new Error("MTP stream out of sync");
  }

  // WebUSB lets calls overlap, but the responder handles one transaction at a
  // time [MtpServer run]: two interleaved ones read each other's containers.
  // Every public transaction runs through this queue. Nothing inside `fn` may
  // call another queued method, or it waits on itself forever.
  _serial(fn) {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => {});
    return run;
  }

  // Command with no data phase, or with a response-only result.
  command(op, params = []) {
    return this._serial(async () => {
      const txn = ++this.txn;
      await this._sendCommand(op, params, txn);
      const res = await this._recvFor(txn);
      if (res.type !== TYPE.RESPONSE) throw new Error("Expected MTP response");
      if (res.code !== RESP_OK) throw new MtpError(res.code, op);
      return new Reader(res.data);
    });
  }

  // Command whose device->host data phase fits comfortably in memory.
  query(op, params = []) {
    return this._serial(async () => {
      const txn = ++this.txn;
      await this._sendCommand(op, params, txn);

      const data = await this._recvFor(txn);
      if (data.type === TYPE.RESPONSE) throw new MtpError(data.code, op);
      if (data.type !== TYPE.DATA) throw new Error("Expected MTP data phase");

      const res = await this._recvFor(txn);
      if (res.code !== RESP_OK) throw new MtpError(res.code, op);
      return new Reader(data.data);
    });
  }

  /* ---- device / storage info ---- */

  // Field order [Datasets MtpDeviceInfo::read].
  async getDeviceInfo() {
    const r = await this.query(OP.GetDeviceInfo);
    r.u16(); // standard version
    r.u32(); // vendor extension ID
    r.u16(); // vendor extension version
    r.str(); // vendor extension description
    r.u16(); // functional mode
    const operations = r.array(() => r.u16());
    r.array(() => r.u16()); // events
    r.array(() => r.u16()); // device properties
    r.array(() => r.u16()); // capture formats
    r.array(() => r.u16()); // playback formats
    const manufacturer = r.str();
    const model = r.str();
    const version = r.str();
    const serial = r.str();
    return { operations, manufacturer, model, version, serial };
  }

  async getStorageIDs() {
    const r = await this.query(OP.GetStorageIDs);
    return r.array(() => r.u32());
  }

  // Field order [Datasets MtpStorageInfo::read].
  async getStorageInfo(id) {
    const r = await this.query(OP.GetStorageInfo, [id]);
    r.u16(); // storage type
    r.u16(); // filesystem type
    r.u16(); // access capability
    const capacity = r.u64();
    const free = r.u64();
    r.u32(); // free objects
    const description = r.str();
    return { id, capacity, free, description };
  }

  /* ---- listing ---- */

  // One GetObjectPropList round-trip returns every property of every child.
  // The fallback costs one GetObjectInfo round-trip per child.
  async list(storageId, parent = ROOT_PARENT) {
    if (this.supports(OP.GetObjectPropList)) {
      try {
        return await this._listFast(parent);
      } catch (e) {
        // The phone answered with an error code: fall through to the slow path.
        if (!(e instanceof MtpError)) throw e;
      }
    }
    return await this._listSlow(storageId, parent);
  }

  async _listFast(parent) {
    // Parameters: handle, format (0 = all), property (0xffffffff = all),
    // group (0), depth (1 = immediate children) [MtpDatabase
    // getObjectPropertyList]. Each element is u32 handle, u16 property, u16
    // datatype, value [JNI getObjectPropertyList].
    const r = await this.query(OP.GetObjectPropList, [parent, 0, 0xffffffff, 0, 1]);
    const count = r.u32();
    const byHandle = new Map();

    for (let i = 0; i < count; i++) {
      const handle = r.u32();
      const prop = r.u16();
      const type = r.u16();
      const value = readTypedValue(r, type);

      let o = byHandle.get(handle);
      if (!o) {
        o = { handle };
        byHandle.set(handle, o);
      }

      switch (prop) {
        case PROP.FileName:
          o.name = value;
          break;
        case PROP.ObjectSize:
          o.size = value;
          break;
        case PROP.ObjectFormat:
          o.format = value;
          break;
        case PROP.DateModified:
          o.modified = parseMtpDate(value);
          break;
        case PROP.ParentObject:
          o.parent = value;
          break;
      }
    }

    const named = [...byHandle.values()].filter((o) => o.name);
    if (!named.length && count > 0) throw new MtpError(0xa80a, OP.GetObjectPropList);

    // Android returns the folder itself along with its children at depth 1
    // [MtpDatabase getObjectPropertyList adds thisObj], which would make DCIM
    // appear inside DCIM forever. Trust the parent each object reports.
    return named
      .filter((o) => o.parent === undefined || sameParent(o.parent, parent))
      .map(finishEntry);
  }

  async _listSlow(storageId, parent) {
    const r = await this.query(OP.GetObjectHandles, [storageId, 0, parent]);
    const handles = r.array(() => r.u32());
    const out = [];
    for (const h of handles) {
      try {
        out.push(await this.getObjectInfo(h));
      } catch {
        /* object vanished mid-listing; skip it */
      }
    }
    return out;
  }

  // Field order [Datasets MtpObjectInfo::read].
  async getObjectInfo(handle) {
    const r = await this.query(OP.GetObjectInfo, [handle]);
    const o = { handle };
    r.u32(); // storage ID
    o.format = r.u16();
    r.u16(); // protection status
    o.size = r.u32(); // 32-bit; refined below for large files
    r.u16(); // thumb format
    r.u32();
    r.u32();
    r.u32(); // thumb size, width, height
    r.u32();
    r.u32();
    r.u32(); // image width, height, bit depth
    o.parent = r.u32();
    r.u16(); // association type
    r.u32(); // association description
    r.u32(); // sequence number
    o.name = r.str();
    r.str(); // capture date
    o.modified = parseMtpDate(r.str());

    // ObjectInfo carries a 32-bit size; Android reports 0xffffffff for
    // anything larger [JNI getObjectInfo]. Ask for the 64-bit property instead.
    if (o.size === 0xffffffff && this.supports(OP.GetObjectPropValue)) {
      try {
        const p = await this.query(OP.GetObjectPropValue, [handle, PROP.ObjectSize]);
        o.size = p.u64();
      } catch {
        /* leave the truncated value */
      }
    }
    return finishEntry(o);
  }

  /* ---- reading ---- */

  // Streams one object to `onChunk` without ever holding the whole file.
  // Returns bytes written. Not abortable: a data phase left unfinished
  // leaves the phone unreadable until replugged.
  readObject(handle, size, onChunk, onProgress) {
    return this._serial(async () => {
      const txn = ++this.txn;
      await this._sendCommand(OP.GetObject, [handle], txn);
      return await this._readBody(txn, size, onChunk, onProgress);
    });
  }

  async _readBody(txn, size, onChunk, onProgress) {
    // First packet carries the data-phase header.
    const first = await this._inContainer(this.pktIn * 256);
    if (first.byteLength < 12) throw new Error("Short MTP data header");
    const dv = new DataView(first.buffer, first.byteOffset, first.byteLength);
    const declared = dv.getUint32(0, true);
    const type = dv.getUint16(4, true);
    if (type === TYPE.RESPONSE) throw new MtpError(dv.getUint16(6, true), OP.GetObject);

    // 0xffffffff: the length does not fit in 32 bits [MtpFfs sendFile]. Read
    // until a short packet.
    const total = declared === 0xffffffff ? (size ?? Infinity) : declared - 12;

    let done = 0;
    const head = first.subarray(12);
    if (head.length) {
      await onChunk(head);
      done += head.length;
      onProgress?.(done, total);
    }

    while (done < total) {
      const want = Math.min(CHUNK, roundUp(total - done, this.pktIn));
      const c = await this._in(want);
      if (!c.length) break; // short/zero packet ends the phase
      await onChunk(c);
      done += c.length;
      onProgress?.(done, total);
      if (c.length < want && declared === 0xffffffff) break;
    }

    const res = await this._recvFor(txn);
    if (res.code !== RESP_OK) throw new MtpError(res.code, OP.GetObject);
    return done;
  }

  /* ---- writing ---- */

  async createFolder(storageId, parent, name) {
    const info = buildObjectInfo({
      storageId,
      parent,
      name,
      size: 0,
      format: FMT_ASSOCIATION,
    });
    const r = await this._serial(() =>
      this._sendWithData(OP.SendObjectInfo, [storageId, parent], info),
    );
    r.u32();
    r.u32();
    return r.u32(); // new object handle
  }

  // `pump(write)` must call `write(Uint8Array)` until `size` bytes are sent.
  // One queue slot for both transactions: SendObject must directly follow its
  // SendObjectInfo. Not abortable, for the same reason as readObject().
  writeObject(storageId, parent, name, size, modified, pump, onProgress) {
    return this._serial(async () => {
      const info = buildObjectInfo({
        storageId,
        parent,
        name,
        size,
        modified,
        format: guessFormat(name),
      });
      // Response parameters: storage, parent, new handle [MtpServer doSendObjectInfo].
      const r = await this._sendWithData(OP.SendObjectInfo, [storageId, parent], info);
      r.u32();
      const actualParent = r.u32();
      const handle = r.u32();

      const txn = ++this.txn;
      await this._sendCommand(OP.SendObject, [], txn);

      // Data phase: one header, then the payload streamed straight through.
      // Android takes the size from ObjectInfo, and a size of 0xffffffff
      // there means "read until a short packet" [MtpServer doSendObject].
      const header = this._header(
        TYPE.DATA,
        OP.SendObject,
        txn,
        size > 0xfffffff0 ? 0xffffffff - 12 : size,
      );
      await this._out(header);

      // Every USB write but the last must be a multiple of the packet size: a
      // short packet before the end is an error for Android [MtpFfs
      // receiveFile]. The stream hands over pieces of any size, so the odd
      // tail of each piece is carried into the next write.
      let sent = 0;
      let carry = new Uint8Array(0);
      const send = async (bytes) => {
        await this._out(bytes);
        sent += bytes.length;
        onProgress?.(sent, size);
      };
      await pump(async (bytes) => {
        const buf = carry.length ? concat([carry, bytes], carry.length + bytes.length) : bytes;
        const whole = buf.length - (buf.length % this.pktOut);
        for (let o = 0; o < whole; o += CHUNK)
          await send(buf.subarray(o, Math.min(o + CHUNK, whole)));
        carry = buf.slice(whole); // a copy: the stream may reuse its buffer
      });
      if (carry.length) await send(carry);

      // The header went out as its own short transfer, so the payload is a
      // transfer of its own. Android expects a zero-length packet after a
      // payload that is a multiple of the packet size [MtpFfs receiveFile].
      if (sent > 0 && sent % this.pktOut === 0) await this._out(new Uint8Array(0));

      const res = await this._recvFor(txn);
      if (res.code !== RESP_OK) throw new MtpError(res.code, OP.SendObject);
      return { handle, parent: actualParent };
    });
  }

  async deleteObject(handle) {
    await this.command(OP.DeleteObject, [handle, 0]);
  }

  async renameObject(handle, name) {
    const w = new Writer();
    w.str(name);
    await this._serial(() =>
      this._sendWithData(OP.SetObjectPropValue, [handle, PROP.FileName], w.bytes()),
    );
  }

  // Command with a host->device data phase. Android reads the whole container
  // in one go and needs a zero-length packet after a packet-size multiple
  // [MtpServer run, MtpFfs read].
  async _sendWithData(op, params, payload) {
    const txn = ++this.txn;
    await this._sendCommand(op, params, txn);

    const out = new Uint8Array(12 + payload.length);
    out.set(this._header(TYPE.DATA, op, txn, payload.length), 0);
    out.set(payload, 12);
    await this._out(out);
    if (out.length % this.pktOut === 0) await this._out(new Uint8Array(0));

    const res = await this._recvFor(txn);
    if (res.code !== RESP_OK) throw new MtpError(res.code, op);
    return new Reader(res.data);
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const CHUNK = 512 * 1024; // bulk transfer size, a multiple of the 512 and 1024 byte packet sizes

// WebUSB transfers never resolve on their own if the device stops answering,
// so every read and write is raced against this. Generous enough for a slow
// responder mid-file, short enough that a stall surfaces as an error.
const IO_TIMEOUT = 20000;
export const STALLED =
  "The phone stopped responding. Unplug and replug the cable, choose File transfer in its " +
  "USB notification, then click Choose phone.";

// A reload can start claiming before the previous page's close() has
// finished, and Chrome rejects overlapping device-state changes with "An
// operation that changes the device state is in progress." or "... interface
// state ..." [Blink]. Waiting a moment and trying again is the whole fix.
async function retryWhileBusy(fn, tries = 6, delay = 300) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const busy = /state is in progress/i.test(e?.message || "");
      if (!busy || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

// Objects in the root report parent 0 [PropGroup PROPERTY_PARENT_OBJECT], while
// requests use ROOT_PARENT; both mean "in the root of the storage".
function sameParent(reported, requested) {
  const isRoot = (v) => v === 0 || v === ROOT_PARENT;
  return isRoot(requested) ? isRoot(reported) : reported === requested;
}

function roundUp(n, m) {
  return Math.ceil(n / m) * m;
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// The entry shape app.js works with.
function finishEntry(o) {
  const isDir = o.format === FMT_ASSOCIATION;
  return {
    handle: o.handle,
    name: o.name,
    isDir,
    size: isDir ? null : (o.size ?? 0),
    modified: o.modified || null,
  };
}

// ObjectInfo dataset, in the order Android reads it [MtpServer doSendObjectInfo].
function buildObjectInfo({ storageId, parent, name, size, modified, format }) {
  const w = new Writer();
  w.u32(storageId);
  w.u16(format);
  w.u16(0); // protection status
  w.u32(size > 0xfffffffe ? 0xffffffff : size);
  w.u16(0); // thumb format
  w.u32(0);
  w.u32(0);
  w.u32(0); // thumb size, width, height
  w.u32(0);
  w.u32(0);
  w.u32(0); // image width, height, bit depth
  w.u32(parent);
  w.u16(format === FMT_ASSOCIATION ? 1 : 0); // association type: 1 = generic folder [mtp.h]
  w.u32(0); // association description
  w.u32(0); // sequence number
  w.str(name);
  w.str(""); // capture date
  w.str(modified ? mtpDate(modified) : "");
  w.str(""); // keywords
  return w.bytes();
}

function mtpDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Object format codes by extension [mtp.h MTP_FORMAT_*]; anything else is sent
// as Undefined.
const FORMATS = {
  jpg: 0x3801,
  jpeg: 0x3801,
  gif: 0x3807,
  png: 0x380b,
  bmp: 0x3804,
  tif: 0x380d,
  tiff: 0x380d,
  heic: 0x3812,
  webp: 0x3800, // unknown image
  dng: 0x3811,
  mp3: 0x3009,
  wav: 0x3008,
  m4a: 0xb903,
  flac: 0xb906,
  ogg: 0xb902,
  mp4: 0xb982,
  mov: 0xb980, // unknown video
  avi: 0x300a,
  "3gp": 0xb984,
  txt: 0x3004,
  htm: 0x3005,
  html: 0x3005,
};

function guessFormat(name) {
  const ext = name.split(".").pop().toLowerCase();
  return FORMATS[ext] ?? FMT_UNDEFINED;
}
