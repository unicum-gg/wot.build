// Decoder for BigWorld "packed sections", the binary form the client ships its
// XML in. Layout: a magic, a version byte, a NUL-terminated key dictionary, then
// a tree of sections. Each section is `uint16 nChildren`, a `uint32` descriptor
// for its own value, then one `uint16 keyIndex` + `uint32` descriptor per child.
// A descriptor packs the type in its top 4 bits and a **cumulative end offset**
// in the low 28, so a child's length is its end minus the previous one's.
import fs from "node:fs";

export const PACKED_MAGIC = 0x62a14e45;

export enum PackedType {
  Element = 0,
  String = 1,
  Int = 2,
  Float = 3,
  Bool = 4,
  Blob = 5,
}

export type PackedValue = string | number | number[] | boolean;

export type PackedNode = {
  name: string;
  type: PackedType;
  value: PackedValue;
  children: PackedNode[];
};

const LENGTH_MASK = 0x0fffffff;

export function isPacked(buf: Buffer): boolean {
  return buf.length >= 5 && buf.readUInt32LE(0) === PACKED_MAGIC;
}

/** Cheap magic check that reads four bytes instead of the whole file. */
export function isPackedFile(file: string): boolean {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(4);
    const read = fs.readSync(fd, head, 0, 4, 0);
    return read === 4 && head.readUInt32LE(0) === PACKED_MAGIC;
  } finally {
    fs.closeSync(fd);
  }
}

function readDictionary(buf: Buffer, offset: number): { keys: string[]; offset: number } {
  const keys: string[] = [];
  let o = offset;
  for (;;) {
    const end = buf.indexOf(0, o);
    if (end === -1) throw new Error("unterminated key dictionary");
    if (end === o) return { keys, offset: o + 1 }; // empty string closes it
    keys.push(buf.toString("utf8", o, end));
    o = end + 1;
  }
}

function readValue(buf: Buffer, type: PackedType, slice: Buffer): PackedValue {
  switch (type) {
    case PackedType.String:
      return slice.toString("utf8");
    case PackedType.Int:
      if (slice.length === 0) return 0;
      if (slice.length === 1) return slice.readInt8(0);
      if (slice.length === 2) return slice.readInt16LE(0);
      if (slice.length === 4) return slice.readInt32LE(0);
      if (slice.length === 8) return Number(slice.readBigInt64LE(0));
      return slice.readIntLE(0, slice.length);
    case PackedType.Float: {
      const count = Math.floor(slice.length / 4);
      const values: number[] = [];
      for (let i = 0; i < count; i++) values.push(slice.readFloatLE(i * 4));
      return count === 1 ? values[0] : values;
    }
    case PackedType.Bool:
      return slice.length > 0;
    default:
      return slice.toString("base64");
  }
}

function readSection(buf: Buffer, offset: number, keys: string[], name: string): PackedNode {
  let o = offset;
  const childCount = buf.readUInt16LE(o);
  o += 2;
  const self = buf.readUInt32LE(o);
  o += 4;

  const descriptors: { keyIndex: number; descriptor: number }[] = [];
  for (let i = 0; i < childCount; i++) {
    const keyIndex = buf.readUInt16LE(o);
    o += 2;
    const descriptor = buf.readUInt32LE(o);
    o += 4;
    descriptors.push({ keyIndex, descriptor });
  }

  const dataStart = o;
  const selfEnd = self & LENGTH_MASK;
  const node: PackedNode = {
    name,
    type: (self >>> 28) as PackedType,
    value: readValue(buf, (self >>> 28) as PackedType, buf.subarray(dataStart, dataStart + selfEnd)),
    children: [],
  };

  let previousEnd = selfEnd;
  for (const { keyIndex, descriptor } of descriptors) {
    const end = descriptor & LENGTH_MASK;
    const type = (descriptor >>> 28) as PackedType;
    const childName = keys[keyIndex] ?? `unknown${keyIndex}`;
    if (type === PackedType.Element) {
      node.children.push(readSection(buf, dataStart + previousEnd, keys, childName));
    } else {
      const slice = buf.subarray(dataStart + previousEnd, dataStart + end);
      node.children.push({ name: childName, type, value: readValue(buf, type, slice), children: [] });
    }
    previousEnd = end;
  }
  return node;
}

export function decodePacked(buf: Buffer): PackedNode {
  if (!isPacked(buf)) throw new Error("not a packed section");
  const { keys, offset } = readDictionary(buf, 5); // 4 magic + 1 version
  return readSection(buf, offset, keys, "root");
}
