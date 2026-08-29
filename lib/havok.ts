// Reader for Havok's binary tag files (`TAG0`), the format the client stores
// vehicle collision in since it moved its physics onto Havok.
//
// A tag file carries its own type system: the `TYPE` section declares every
// struct laid out in `DATA`, so nothing can be read at a fixed offset. Reading
// is therefore two passes, the type table first, then a reflective walk that
// materialises objects from their declared members. `INDX` lists the items, and
// a pointer inside `DATA` is an index into that list rather than an offset.
//
// The integers in the type tables are variable width: the leading bits of the
// first byte give the width, and the widest form throws the first byte away and
// takes a plain big-endian u32.
export enum TagSubType {
  Void = 0x0,
  Bool = 0x2,
  String = 0x3,
  Int = 0x4,
  Float = 0x5,
  Pointer = 0x6,
  Class = 0x7,
  Array = 0x8,
  Tuple = 0x28,
  /** A four-byte handle standing in for a string, which the client uses in place
   * of the plain `String` sub-type for its own named objects. */
  StringHandle = 0x83,
  TypeMask = 0xff,
  IsSigned = 0x200,
  Int8 = 0x2000,
  Int16 = 0x4000,
  Int32 = 0x8000,
  Int64 = 0x10000,
}

export enum TagFlag {
  SubType = 0x1,
  Pointer = 0x2,
  Version = 0x4,
  ByteSize = 0x8,
  AbstractValue = 0x10,
  Members = 0x20,
  Interfaces = 0x40,
  Unknown = 0x80,
}

export type TagMember = { name: string; flags: number; byteOffset: number; type: TagType | null };

export type TagType = {
  name: string;
  templates: { name: string; value: number | TagType | null }[];
  parent: TagType | null;
  flags: number;
  subTypeFlags: number;
  pointer: TagType | null;
  version: number;
  byteSize: number;
  alignment: number;
  members: TagMember[];
};

export type TagValue = number | bigint | boolean | string | null | TagValue[] | { [key: string]: TagValue };

type TagItem = { type: TagType | null; offset: number; count: number; isPtr: boolean; value: TagValue[] | null };

type Section = { name: string; start: number; end: number };

function subSections(buf: Buffer, start: number, end: number): Section[] {
  const out: Section[] = [];
  let p = start;
  while (p + 8 <= end) {
    const size = buf.readUInt32BE(p) & 0x3fffffff;
    if (size < 8) break;
    out.push({ name: buf.toString("latin1", p + 4, p + 8), start: p + 8, end: p + size });
    p += size;
  }
  return out;
}

function section(sections: Section[], name: string): Section {
  const found = sections.find((s) => s.name === name);
  if (!found) throw new Error(`havok: missing ${name} section`);
  return found;
}

/** Split a `\0`-delimited string table, dropping the empty tail. */
function stringTable(buf: Buffer, s: Section): string[] {
  const out = buf.toString("latin1", s.start, s.end).split("\0");
  if (out.at(-1) === "") out.pop();
  return out;
}

/** The base type a value is actually laid out as, walking past sub-typed aliases. */
function superType(type: TagType): TagType {
  let t = type;
  while (!(t.flags & TagFlag.SubType) && t.parent) t = t.parent;
  return t;
}

function allMembers(type: TagType): TagMember[] {
  return type.parent ? [...allMembers(type.parent), ...type.members] : type.members;
}

export class TagFile {
  private readonly buf: Buffer;
  private dataOffset = 0;
  private types: (TagType | null)[] = [];
  private items: TagItem[] = [];

  constructor(buf: Buffer) {
    this.buf = buf;
    const root = subSections(buf, 0, buf.length).find((s) => s.name === "TAG0");
    if (!root) throw new Error("havok: not a TAG0 file");
    const top = subSections(buf, root.start, root.end);

    const sdkv = section(top, "SDKV");
    this.sdkVersion = buf.toString("latin1", sdkv.start, sdkv.end);
    this.dataOffset = section(top, "DATA").start;

    const type = section(top, "TYPE");
    const index = section(top, "INDX");
    this.readTypes(subSections(buf, type.start, type.end));
    this.readItems(subSections(buf, index.start, index.end));
  }

  readonly sdkVersion: string;

  private cursor = 0;

  private packed(): number {
    const b0 = this.buf[this.cursor];
    if ((b0 & 0x80) === 0) {
      this.cursor += 1;
      return b0;
    }
    const kind = b0 >> 3;
    if (kind >= 0x10 && kind <= 0x17) {
      const v = ((b0 << 8) | this.buf[this.cursor + 1]) & 0x3fff;
      this.cursor += 2;
      return v;
    }
    if (kind >= 0x18 && kind <= 0x1b) {
      const v = ((b0 << 16) | this.buf.readUInt16BE(this.cursor + 1)) & 0x1fffff;
      this.cursor += 3;
      return v;
    }
    if (kind === 0x1c) {
      const v = ((b0 << 24) | (this.buf[this.cursor + 1] << 16) | this.buf.readUInt16BE(this.cursor + 2)) & 0x7ffffff;
      this.cursor += 4;
      return v;
    }
    if (kind === 0x1d) {
      const v = this.buf.readUInt32BE(this.cursor + 1);
      this.cursor += 5;
      return v;
    }
    throw new Error(`havok: unsupported packed integer 0x${b0.toString(16)}`);
  }

  private readTypes(type: Section[]): void {
    const typeStrings = stringTable(this.buf, section(type, "TST1"));
    const fieldStrings = stringTable(this.buf, section(type, "FST1"));

    const tna = section(type, "TNA1");
    this.cursor = tna.start;
    const count = this.packed();
    this.types = [null];
    for (let i = 1; i < count; i++) {
      this.types.push({
        name: "",
        templates: [],
        parent: null,
        flags: TagFlag.SubType,
        subTypeFlags: TagSubType.Void,
        pointer: null,
        version: 0,
        byteSize: 0,
        alignment: 0,
        members: [],
      });
    }
    for (let i = 1; i < count; i++) {
      const t = this.types[i]!;
      t.name = typeStrings[this.packed()];
      const templates = this.packed();
      for (let j = 0; j < templates; j++) {
        const name = typeStrings[this.packed()];
        const value = this.packed();
        t.templates.push({ name, value: name.startsWith("t") ? this.types[value] : value });
      }
    }

    const tbdy = section(type, "TBDY");
    this.cursor = tbdy.start;
    while (this.cursor < tbdy.end) {
      const index = this.packed();
      if (index === 0) continue;
      const t = this.types[index]!;
      t.parent = this.types[this.packed()];
      t.flags = this.packed();
      if (t.flags & TagFlag.SubType) t.subTypeFlags = this.packed();
      if (t.flags & TagFlag.Pointer) t.pointer = this.types[this.packed()];
      if (t.flags & TagFlag.Version) t.version = this.packed();
      if (t.flags & TagFlag.ByteSize) {
        t.byteSize = this.packed();
        t.alignment = this.packed();
      }
      if (t.flags & TagFlag.AbstractValue) this.packed();
      if (t.flags & TagFlag.Members) {
        const members = this.packed() & 0x3f;
        for (let m = 0; m < members; m++) {
          const name = fieldStrings[this.packed()];
          const flags = this.packed();
          const byteOffset = this.packed();
          t.members.push({ name, flags, byteOffset, type: this.types[this.packed()] });
        }
      }
      if (t.flags & TagFlag.Interfaces) {
        const interfaces = this.packed();
        for (let k = 0; k < interfaces; k++) {
          this.packed();
          this.packed();
        }
      }
      if (t.flags & TagFlag.Unknown) throw new Error("havok: unhandled type flag 0x80");
    }
  }

  private readItems(indx: Section[]): void {
    const item = section(indx, "ITEM");
    for (let p = item.start; p + 12 <= item.end; p += 12) {
      const flag = this.buf.readUInt32LE(p);
      this.items.push({
        type: this.types[flag & 0xffffff] ?? null,
        isPtr: (flag & 0x10000000) !== 0,
        offset: this.dataOffset + this.buf.readUInt32LE(p + 4),
        count: this.buf.readUInt32LE(p + 8),
        value: null,
      });
    }
  }

  /** The file's root object, the `hkRootLevelContainer`. */
  root(): TagValue {
    return this.item(1)?.[0] ?? null;
  }

  private item(index: number): TagValue[] | null {
    const item = this.items[index];
    if (!item || !item.type) return null;
    if (item.value === null) {
      const size = superType(item.type).byteSize;
      const values: TagValue[] = [];
      for (let i = 0; i < item.count; i++) values.push(this.readValue(item.type, item.offset + i * size));
      item.value = values;
    }
    return item.value;
  }

  private pointer(offset: number): TagValue[] {
    const index = this.buf.readUInt32LE(offset);
    return index === 0 ? [] : (this.item(index) ?? []);
  }

  private readValue(declared: TagType, offset: number): TagValue {
    const type = superType(declared);
    switch (type.subTypeFlags & TagSubType.TypeMask) {
      case TagSubType.Bool:
        return this.readInt(type, offset) !== 0;
      case TagSubType.String:
        return this.readString(offset);
      case TagSubType.StringHandle:
        return type.byteSize === 4 ? this.readString(offset) : null;
      case TagSubType.Int:
        return this.readInt(type, offset);
      case TagSubType.Float:
        return this.buf.readFloatLE(offset);
      case TagSubType.Pointer: {
        const target = this.pointer(offset);
        return target.length === 1 ? target[0] : null;
      }
      case TagSubType.Class: {
        const out: { [key: string]: TagValue } = {};
        for (const m of allMembers(type)) {
          if (m.type) out[m.name] = this.readValue(m.type, offset + m.byteOffset);
        }
        return out;
      }
      case TagSubType.Array:
        return this.pointer(offset);
      case TagSubType.Tuple: {
        if (!type.pointer) return [];
        const size = superType(type.pointer).byteSize;
        const out: TagValue[] = [];
        for (let i = 0; i < type.subTypeFlags >> 8; i++) out.push(this.readValue(type.pointer, offset + i * size));
        return out;
      }
      default:
        return null;
    }
  }

  /** A string is stored out of line as a null-terminated array of characters. */
  private readString(offset: number): string {
    const chars = this.pointer(offset);
    return chars
      .slice(0, -1)
      .map((c) => String.fromCharCode(Number(c)))
      .join("");
  }

  private readInt(type: TagType, offset: number): number | bigint {
    const signed = (type.subTypeFlags & TagSubType.IsSigned) !== 0;
    if (type.subTypeFlags & TagSubType.Int8) return signed ? this.buf.readInt8(offset) : this.buf.readUInt8(offset);
    if (type.subTypeFlags & TagSubType.Int16) return signed ? this.buf.readInt16LE(offset) : this.buf.readUInt16LE(offset);
    if (type.subTypeFlags & TagSubType.Int32) return signed ? this.buf.readInt32LE(offset) : this.buf.readUInt32LE(offset);
    if (type.subTypeFlags & TagSubType.Int64) return signed ? this.buf.readBigInt64LE(offset) : this.buf.readBigUInt64LE(offset);
    return 0;
  }
}
