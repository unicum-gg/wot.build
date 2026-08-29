// Writing meshes out as binary glTF (`.glb`), the format a browser can load
// without a converter in front of it.
//
// Geometry only: materials and their textures are published beside the file, so
// a viewer can show the shape immediately and pull the textures in afterwards,
// and so a texture the client shares between pieces is fetched once. Each render
// set becomes its own mesh under a node named after it, which is what lets a
// viewer hide or recolour one part of a piece.
const MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const VERSION = 2;

const enum ComponentType {
  UnsignedShort = 5123,
  UnsignedInt = 5125,
  Float = 5126,
}

const enum Target {
  ArrayBuffer = 34962,
  ElementArrayBuffer = 34963,
}

/** A bone the mesh is skinned to, placed in the piece's own space. */
export type GltfBone = {
  name: string;
  /** Three-by-three basis as row vectors, then a translation. */
  basis: number[];
  offset: number[];
};

export type GltfMesh = {
  name: string;
  positions: number[];
  normals: number[];
  uvs: number[];
  /** Flat `x, y, z, w` tangents, `w` carrying handedness. Optional. */
  tangents?: number[];
  /** Flat `u, v` pairs for the second set, when the client ships one. */
  uv2?: number[];
  indices: number[];
  /**
   * Slices of `indices` drawn with their own material, as the client declares
   * them. A mesh with several is emitted as several glTF primitives sharing one
   * set of vertices, which is what lets each keep its own material.
   */
  groups: { start: number; count: number; material: number }[];
  /**
   * The skeleton, when the client skins this set.
   *
   * Vertices are written in their rest pose, so a viewer that ignores the skin
   * still draws the piece correctly. `joints` and `weights` are carried anyway
   * so one that does not ignore it can turn a road wheel.
   */
  skeleton?: GltfBone[];
  /** Four bone indices per vertex, into `skeleton`. */
  joints?: number[];
  /** Four weights per vertex, matching `joints`. */
  weights?: number[];
};

type Accessor = {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
};

function pad(length: number): number {
  return (4 - (length % 4)) % 4;
}

class BufferBuilder {
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

function floats(values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) out.writeFloatLE(values[i], i * 4);
  return out;
}

/**
 * A bone's placement as the sixteen floats glTF wants, column-major.
 *
 * The client writes its basis as row vectors, which is exactly the order a
 * column-major matrix reads them back in, so the rows go straight across.
 */
function matrixOf(bone: GltfBone): number[] {
  const m = new Array(16).fill(0);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) m[c * 4 + r] = bone.basis[c * 3 + r];
  }
  for (let r = 0; r < 3; r++) m[12 + r] = bone.offset[r];
  m[15] = 1;
  return m;
}

/** The inverse of a bone's placement, which is what binds a skin to a rest pose. */
function inverseMatrixOf(bone: GltfBone): number[] {
  const b = bone.basis;
  // A basis of unit axes inverts by transposing, and the offset comes back
  // through that same transpose.
  const inverse = [b[0], b[3], b[6], b[1], b[4], b[7], b[2], b[5], b[8]];
  const t = bone.offset;
  const offset = [0, 1, 2].map((r) => -(t[0] * inverse[r] + t[1] * inverse[3 + r] + t[2] * inverse[6 + r]));
  return matrixOf({ name: bone.name, basis: inverse, offset });
}

function bounds(positions: number[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

/**
 * Pack meshes into one `.glb`.
 *
 * The client's space is already Y-up, so positions go in untouched and a viewer
 * needs no correction beyond pointing its camera.
 */
export function writeGlb(meshes: GltfMesh[]): Buffer {
  const buffer = new BufferBuilder();
  const accessors: Accessor[] = [];
  const gltfMeshes: unknown[] = [];
  const nodes: unknown[] = [];
  const skins: unknown[] = [];

  for (const mesh of meshes) {
    const wide = mesh.positions.length / 3 > 0xffff;
    const indexData = Buffer.alloc(mesh.indices.length * (wide ? 4 : 2));
    for (let i = 0; i < mesh.indices.length; i++) {
      if (wide) indexData.writeUInt32LE(mesh.indices[i], i * 4);
      else indexData.writeUInt16LE(mesh.indices[i], i * 2);
    }

    const box = bounds(mesh.positions);
    const position = accessors.push({
      bufferView: buffer.add(floats(mesh.positions), Target.ArrayBuffer),
      componentType: ComponentType.Float,
      count: mesh.positions.length / 3,
      type: "VEC3",
      min: box.min,
      max: box.max,
    }) - 1;
    const normal = accessors.push({
      bufferView: buffer.add(floats(mesh.normals), Target.ArrayBuffer),
      componentType: ComponentType.Float,
      count: mesh.normals.length / 3,
      type: "VEC3",
    }) - 1;
    const uv = accessors.push({
      bufferView: buffer.add(floats(mesh.uvs), Target.ArrayBuffer),
      componentType: ComponentType.Float,
      count: mesh.uvs.length / 2,
      type: "VEC2",
    }) - 1;
    const index = accessors.push({
      bufferView: buffer.add(indexData, Target.ElementArrayBuffer),
      componentType: wide ? ComponentType.UnsignedInt : ComponentType.UnsignedShort,
      count: mesh.indices.length,
      type: "SCALAR",
    }) - 1;

    const attributes: Record<string, number> = { POSITION: position, NORMAL: normal, TEXCOORD_0: uv };
    // The client ships a tangent frame per vertex. Passing it through means a
    // normal map lights the way the game lights it, rather than the way a
    // generated frame guesses.
    if (mesh.tangents && mesh.tangents.length === (mesh.positions.length / 3) * 4) {
      attributes.TANGENT = accessors.push({
        bufferView: buffer.add(floats(mesh.tangents), Target.ArrayBuffer),
        componentType: ComponentType.Float,
        count: mesh.tangents.length / 4,
        type: "VEC4",
      }) - 1;
    }
    if (mesh.uv2 && mesh.uv2.length === mesh.uvs.length) {
      attributes.TEXCOORD_1 = accessors.push({
        bufferView: buffer.add(floats(mesh.uv2), Target.ArrayBuffer),
        componentType: ComponentType.Float,
        count: mesh.uv2.length / 2,
        type: "VEC2",
      }) - 1;
    }
    const stride = wide ? 4 : 2;
    const primitives = mesh.groups.map((group) => {
      if (group.start === 0 && group.count === mesh.indices.length) {
        return { attributes, indices: index, extras: { material: group.material } };
      }
      const sliced = accessors.push({
        bufferView: accessors[index].bufferView,
        byteOffset: group.start * stride,
        componentType: accessors[index].componentType,
        count: group.count,
        type: "SCALAR",
      }) - 1;
      return { attributes, indices: sliced, extras: { material: group.material } };
    });

    // The skeleton rides along so a viewer can turn a road wheel. Vertices are
    // already in their rest pose, so binding each bone by the inverse of its own
    // placement leaves the piece exactly where it is until something moves.
    let skin: number | undefined;
    if (mesh.skeleton && mesh.joints && mesh.weights) {
      const first = nodes.length;
      for (const bone of mesh.skeleton) nodes.push({ name: bone.name, matrix: matrixOf(bone) });

      const bind = Buffer.concat(mesh.skeleton.map((bone) => floats(inverseMatrixOf(bone))));
      const inverseBindMatrices = accessors.push({
        bufferView: buffer.add(bind),
        componentType: ComponentType.Float,
        count: mesh.skeleton.length,
        type: "MAT4",
      }) - 1;

      const jointData = Buffer.alloc(mesh.joints.length * 2);
      for (let i = 0; i < mesh.joints.length; i++) {
        jointData.writeUInt16LE(Math.min(mesh.joints[i], mesh.skeleton.length - 1), i * 2);
      }
      attributes.JOINTS_0 = accessors.push({
        bufferView: buffer.add(jointData, Target.ArrayBuffer),
        componentType: ComponentType.UnsignedShort,
        count: mesh.joints.length / 4,
        type: "VEC4",
      }) - 1;
      attributes.WEIGHTS_0 = accessors.push({
        bufferView: buffer.add(floats(mesh.weights), Target.ArrayBuffer),
        componentType: ComponentType.Float,
        count: mesh.weights.length / 4,
        type: "VEC4",
      }) - 1;

      skins.push({
        joints: mesh.skeleton.map((_, i) => first + i),
        inverseBindMatrices,
      });
      skin = skins.length - 1;
    }

    gltfMeshes.push({ name: mesh.name, primitives });
    nodes.push({ name: mesh.name, mesh: gltfMeshes.length - 1, ...(skin === undefined ? {} : { skin }) });
  }

  const bin = buffer.build();
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0", generator: "wot.build" },
      scene: 0,
      scenes: [{ nodes: nodes.map((_, i) => i) }],
      nodes,
      ...(skins.length > 0 ? { skins } : {}),
      meshes: gltfMeshes,
      accessors,
      bufferViews: buffer.views,
      buffers: [{ byteLength: bin.length }],
    }),
    "utf8",
  );
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
