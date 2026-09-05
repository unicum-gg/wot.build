// The `.glb` container: two chunks, a header, and the alignment between them.
//
// Kept apart from the document that goes inside it. One is a binary layout with
// a magic number and four-byte padding, the other is what a vehicle's geometry
// means, and neither has anything to say about the other.
const MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const VERSION = 2;

export type Accessor = {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
};

export function pad(length: number): number {
  return (4 - (length % 4)) % 4;
}

export class BufferBuilder {
  private readonly chunks: Buffer[] = [];
  private length = 0;
  readonly views: { buffer: number; byteOffset: number; byteLength: number; target?: number }[] = [];

  add(data: Buffer, target?: number): number {
    const padding = pad(this.length);
    if (padding > 0) {
      this.chunks.push(Buffer.alloc(padding));
      this.length += padding;
    }
    this.views.push({ buffer: 0, byteOffset: this.length, byteLength: data.length, target });
    this.chunks.push(data);
    this.length += data.length;
    return this.views.length - 1;
  }

  build(): Buffer {
    return Buffer.concat([...this.chunks, Buffer.alloc(pad(this.length))]);
  }
}

export function floats(values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) out.writeFloatLE(values[i], i * 4);
  return out;
}

/** Wrap the document and its buffer as the two chunks of a `.glb`. */
export function container(json: Buffer, bin: Buffer): Buffer {
  const jsonPadded = Buffer.concat([json, Buffer.alloc(pad(json.length), 0x20)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(VERSION, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + bin.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonHeader.writeUInt32LE(JSON_CHUNK, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(BIN_CHUNK, 4);

  return Buffer.concat([header, jsonHeader, jsonPadded, binHeader, bin]);
}
