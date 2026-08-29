// Reader for BigWorld `.primitives_processed`, the client's visual geometry.
//
// The file is a bag of named blocks with an index at the tail: a `<set>.vertices`
// and a `<set>.indices` per render set, plus optional extra streams. The names
// are what tie a block to the render set that the companion `.visual_processed`
// declares.
//
// Vertices are interleaved and their layout is named rather than described, so
// the format string is the schema: `xyznuvtb` is position, normal, UV, tangent
// and binormal, and the `iiiww` in the skinned variants adds bone indices and
// weights. Normals are packed into a single word, in one of two ways depending
// on whether the format is a `set3/` one.
const INDEX_HEADER = 72;
const VERTEX_HEADER = 136;
const FORMAT_LENGTH = 64;
const GROUP_SIZE = 16;

export type Block = { name: string; offset: number; length: number };

export type VertexData = {
  /** Flat `x, y, z` triples, in the client's own Y-up space. */
  positions: number[];
  /** Flat unit-length `x, y, z` triples. */
  normals: number[];
  /** Flat `u, v` pairs, in the client's own convention, which glTF shares. */
  uvs: number[];
  /**
   * Flat `x, y, z, w` quadruples, `w` carrying the handedness glTF expects.
   * Empty when the layout ships no tangents.
   */
  tangents: number[];
  /**
   * For a skinned layout, four bone indices per vertex into the render set's
   * bone list, with `weights` alongside. Empty when the layout has no bones.
   */
  bones: number[];
  /** Flat quadruples of bone weights, summing to one. */
  weights: number[];
};

/** One drawable slice of a render set, matching a material by position. */
export type PrimitiveGroup = { startIndex: number; triangles: number; startVertex: number; vertices: number };

export type IndexData = { indices: number[]; groups: PrimitiveGroup[] };

/**
 * Every block in the file, in layout order.
 *
 * The tail index is a list of `[u32 length][20 bytes reserved][u32 nameLength]
 * [name]` records, each padded to four bytes, and the blocks themselves follow
 * the four-byte magic in that same order.
 */
export function blocks(buf: Buffer): Map<string, Block> {
  const indexLength = buf.readUInt32LE(buf.length - 4);
  const start = buf.length - 4 - indexLength;
  const out = new Map<string, Block>();
  let cursor = start;
  let offset = 4;
  while (cursor + 24 <= start + indexLength) {
    const length = buf.readUInt32LE(cursor);
    const nameLength = buf.readUInt32LE(cursor + 20);
    if (nameLength === 0 || nameLength > 256) break;
    const name = buf.toString("latin1", cursor + 24, cursor + 24 + nameLength);
    out.set(name, { name, offset, length });
    offset += (length + 3) & ~3;
    cursor = (cursor + 24 + nameLength + 3) & ~3;
  }
  return out;
}

function formatString(buf: Buffer, at: number): string {
  const raw = buf.toString("latin1", at, at + FORMAT_LENGTH);
  const end = raw.indexOf("\0");
  return end === -1 ? raw : raw.slice(0, end);
}

/**
 * Unit normal from its packed word.
 *
 * The `set3/` formats store three bytes, each inverted and carrying its sign in
 * the top bit. Everything older splits the word 11/11/10 and stores two's
 * complement in each field.
 */
function unpackNormal(packed: number, modern: boolean): [number, number, number] {
  if (modern) {
    const axis = (shift: number): number => {
      const v = ((packed >>> shift) & 0xff) ^ 0xff;
      return v > 0x7f ? -(v & 0x7f) / 0x7f : (v ^ 0x7f) / 0x7f;
    };
    return [axis(0), axis(8), axis(16)];
  }
  const wide = (v: number): number => (v > 0x3ff ? -(((v & 0x3ff) ^ 0x3ff) + 1) / 0x3ff : v / 0x3ff);
  const narrow = (v: number): number => (v > 0x1ff ? -(((v & 0x1ff) ^ 0x1ff) + 1) / 0x1ff : v / 0x1ff);
  return [wide(packed & 0x7ff), wide((packed >>> 11) & 0x7ff), narrow((packed >>> 22) & 0x3ff)];
}

/**
 * Scale a normal back to unit length.
 *
 * Both packings quantise to a handful of bits per axis, so a decoded normal is
 * a couple of percent short and shading comes out slightly flat.
 */
function normalize([x, y, z]: [number, number, number]): [number, number, number] {
  const length = Math.hypot(x, y, z);
  return length > 0 ? [x / length, y / length, z / length] : [0, 1, 0];
}

// Where the skinning block sits in a vertex: after position, normal and UV. The
// `set3` layouts pad it out to a whole word.
const SKIN_OFFSET = 24;
const SKIN_SIZE = 5;
const SKIN_SIZE_MODERN = 8;

/**
 * A vertex's three bones and their weights.
 *
 * Indices are stored as bytes holding three times the index, two weights sit
 * beside them and the third is whatever is left. Each index goes with the
 * weight in the same position, so the last index is the one carrying the
 * implied weight. Returned padded to four, which is the width glTF fixes for
 * a skin.
 *
 * Reversing the indices without reversing the weights was giving the implied
 * weight to the wrong bone, which put most of a chassis on whichever bone
 * happened to be written first: 60% of the bones the client declares were
 * never reached, and every road wheel was welded to a neighbour. Nothing
 * looked wrong at rest, because the bones of one piece share a basis and sit
 * at the origin, so the pose bakes the same either way. It only showed the
 * moment a viewer tried to turn a wheel.
 *
 * Every skinned vertex in the client is bound to exactly one bone: across the
 * whole catalogue the two stored weights are zero without exception, so the
 * implied one is always 1. A tank has nothing to deform.
 */
function readSkin(buf: Buffer, at: number): { bones: number[]; weights: number[] } {
  const bones = [buf[at] / 3, buf[at + 1] / 3, buf[at + 2] / 3];
  const first = buf[at + 3] / 255;
  const second = buf[at + 4] / 255;
  return { bones: [...bones, 0], weights: [first, second, Math.max(0, 1 - first - second), 0] };
}

/**
 * Where a vertex keeps its tangent frame, or null when the layout has none.
 *
 * The frame follows the skinning block when there is one, which is why the
 * offset cannot be a constant.
 */
function tangentOffset(format: string): number | null {
  const layout = format.replace(/^set\d+\//, "").replace(/pc$/, "");
  if (!layout.endsWith("tb")) return null;
  if (!layout.includes("iii")) return SKIN_OFFSET;
  return SKIN_OFFSET + (format.startsWith("set") ? SKIN_SIZE_MODERN : SKIN_SIZE);
}

/**
 * Which way the bitangent points, as glTF's fourth tangent component.
 *
 * glTF rebuilds the bitangent as `cross(normal, tangent) * w` rather than
 * storing it, so the sign is all that survives of the client's own binormal.
 */
function handedness(n: number[], t: number[], b: number[]): number {
  const cross = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
  return cross[0] * b[0] + cross[1] * b[1] + cross[2] * b[2] < 0 ? -1 : 1;
}

/** Byte size of one vertex in `format`, or null when the layout is unknown. */
export function vertexStride(format: string): number | null {
  const layout = format.replace(/^set\d+\//, "").replace(/pc$/, "");
  const sizes: Record<string, number> = {
    xyznuv: 24,
    xyznuvtb: 32,
    xyznuviiiww: 29,
    xyznuviiiwwtb: 37,
  };
  const size = sizes[layout];
  if (size === undefined) return null;
  // The packed `set3/` layouts round the skinned variants up to a whole word.
  return format.startsWith("set") && layout.includes("iii") ? size + 3 : size;
}

/** Read one `<set>.vertices` block. */
export function readVertices(buf: Buffer, block: Block): VertexData {
  const declared = formatString(buf, block.offset + 4);
  const actual = formatString(buf, block.offset + 4 + FORMAT_LENGTH) || declared;
  const count = buf.readUInt32LE(block.offset + VERTEX_HEADER - 4);
  const payload = block.length - VERTEX_HEADER;

  // An unrecognised layout is worth saying out loud. Dividing the block by the
  // vertex count would give a stride that fits and a mesh that is quietly wrong,
  // because the fields inside the vertex would still be read at the offsets of
  // whatever layout we assumed.
  const stride = vertexStride(actual);
  if (stride === null) throw new Error(`primitives: ${block.name} uses an unknown vertex layout ${actual}`);
  if (count === 0 || count * stride > payload) {
    throw new Error(`primitives: ${block.name} declares ${count} vertices of ${actual} in ${payload} bytes`);
  }
  // The block is padded to a word, so a few bytes over is expected and a whole
  // vertex over means the stride is wrong for this layout.
  if (payload - count * stride >= stride) {
    throw new Error(`primitives: ${block.name} has ${payload - count * stride} bytes left over, ${actual} stride ${stride} is wrong`);
  }

  const modern = actual.startsWith("set");
  const skinned = actual.includes("iii");
  const frameAt = tangentOffset(actual);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const tangents: number[] = [];
  const bones: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = block.offset + VERTEX_HEADER + i * stride;
    positions.push(buf.readFloatLE(at), buf.readFloatLE(at + 4), buf.readFloatLE(at + 8));
    const normal = normalize(unpackNormal(buf.readUInt32LE(at + 12), modern));
    normals.push(...normal);
    // The client stores V from the top down, which is what glTF expects, so it
    // goes in untouched. Flipping it here is what an exporter targeting OBJ
    // does, and it lands every texture upside down in a browser.
    uvs.push(buf.readFloatLE(at + 16), buf.readFloatLE(at + 20));
    if (frameAt !== null) {
      const tangent = normalize(unpackNormal(buf.readUInt32LE(at + frameAt), modern));
      const binormal = normalize(unpackNormal(buf.readUInt32LE(at + frameAt + 4), modern));
      tangents.push(...tangent, handedness(normal, tangent, binormal));
    }
    if (skinned) {
      const skin = readSkin(buf, at + SKIN_OFFSET);
      bones.push(...skin.bones);
      weights.push(...skin.weights);
    }
  }
  return { positions, normals, uvs, tangents, bones, weights };
}

/**
 * Read a `<set>.uv2` block: a second set of texture coordinates the client
 * carries alongside the vertices, laid out like a vertex block but holding one
 * pair per vertex. Shaders whose name ends in `_ao` sample their occlusion with
 * it rather than with the first set, which on a track is tiled many times over.
 */
export function readUvStream(buf: Buffer, block: Block): number[] {
  const count = buf.readUInt32LE(block.offset + VERTEX_HEADER - 4);
  const payload = block.length - VERTEX_HEADER;
  const stride = count > 0 ? Math.floor(payload / count) : 0;
  if (count === 0 || stride < 8) throw new Error(`primitives: ${block.name} is not a UV stream`);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = block.offset + VERTEX_HEADER + i * stride;
    out.push(buf.readFloatLE(at), buf.readFloatLE(at + 4));
  }
  return out;
}

/** Read one `<set>.indices` block. */
export function readIndices(buf: Buffer, block: Block): IndexData {
  const format = formatString(buf, block.offset);
  const wide = format === "list32";
  const count = buf.readUInt32LE(block.offset + FORMAT_LENGTH);
  const groupCount = buf.readUInt32LE(block.offset + FORMAT_LENGTH + 4);

  const indices: number[] = [];
  const at = block.offset + INDEX_HEADER;
  for (let i = 0; i < count; i++) {
    indices.push(wide ? buf.readUInt32LE(at + i * 4) : buf.readUInt16LE(at + i * 2));
  }

  const groups: PrimitiveGroup[] = [];
  const groupsAt = at + count * (wide ? 4 : 2);
  for (let g = 0; g < groupCount; g++) {
    const base = groupsAt + g * GROUP_SIZE;
    groups.push({
      startIndex: buf.readInt32LE(base),
      triangles: buf.readInt32LE(base + 4),
      startVertex: buf.readInt32LE(base + 8),
      vertices: buf.readInt32LE(base + 12),
    });
  }
  return { indices, groups };
}

/** The render sets a file holds, named by the prefix its blocks share. */
export function renderSets(index: Map<string, Block>): string[] {
  const out: string[] = [];
  for (const name of index.keys()) {
    if (!name.endsWith("vertices")) continue;
    const set = name === "vertices" ? "" : name.slice(0, -".vertices".length);
    if (index.has(set === "" ? "indices" : `${set}.indices`)) out.push(set);
  }
  return out;
}
