// Writing meshes out as binary glTF (`.glb`), the format a browser can load
// without a converter in front of it.
//
// Geometry only: materials and their textures are published beside the file, so
// a viewer can show the shape immediately and pull the textures in afterwards,
// and so a texture the client shares between pieces is fetched once. Each render
// set becomes its own mesh under a node named after it, which is what lets a
// viewer hide or recolour one part of a piece.
import { BufferBuilder, container, floats, type Accessor } from "./glb.js";
import { compose, decompose, invert, type Placement } from "./placement.js";

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
  /**
   * The bone above it, where this one has to hang off another.
   *
   * **Almost none of them do, and that is deliberate.** A flat skeleton of world
   * placements is what a viewer that turns one wheel wants: it writes the bone's
   * matrix and the skin cancels the rest against the bind pose. Parenting them
   * all would break that, because the bone's world would stop being the matrix
   * the viewer wrote.
   *
   * A chain appears only where an animation needs one. The client keyframes a
   * node's transform in its parent's space, so a gun chamber swinging open has
   * to carry the plunger inside it, and a chamber whose parent was folded away
   * carries nothing. Only the nodes on such a chain are parented; everything
   * else stays exactly as flat as it was.
   */
  parent?: string;
};

/** One node's curve, already in the piece's published space. */
export type GltfChannel = {
  /** The node it drives, by the name the mesh gives it. */
  node: string;
  path: "translation" | "rotation" | "scale";
  /** Sample times in seconds, ascending. */
  times: number[];
  /** Three floats per sample, or four for a rotation quaternion. */
  values: number[];
};

export type GltfAnimation = { name: string; channels: GltfChannel[] };

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
  /**
   * How many of them the skin binds, where the list runs on past its joints.
   *
   * The bones come first, in the order the vertices index them, and anything
   * after is an ancestor carried along so an animation has a chain to move.
   * Absent when there is no such tail, which is every piece with no mechanism.
   */
  jointCount?: number;
  /** Four bone indices per vertex, into `skeleton`. */
  joints?: number[];
  /** Four weights per vertex, matching `joints`. */
  weights?: number[];
};

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
export function writeGlb(meshes: GltfMesh[], clips: GltfAnimation[] = []): Buffer {
  const buffer = new BufferBuilder();
  const accessors: Accessor[] = [];
  const gltfMeshes: unknown[] = [];
  const nodes: Record<string, unknown>[] = [];
  const skins: unknown[] = [];
  // Which node indices carry each name, so a channel can find what it drives.
  // A list rather than one index: a piece drawn as several render sets emits
  // its shared bones once per set, and an animation has to move all of them.
  const named = new Map<string, number[]>();
  const animated = new Set(clips.flatMap((c) => c.channels.map((ch) => ch.node)));

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
      const at = new Map(mesh.skeleton.map((bone, i) => [bone.name, first + i]));
      for (const bone of mesh.skeleton) {
        const index = nodes.length;
        // A parented bone's own matrix is what is left of its placement once
        // its parent's is taken off, so the two together still put it exactly
        // where the flat placement did.
        const above = bone.parent === undefined ? undefined : mesh.skeleton.find((b) => b.name === bone.parent);
        const local: Placement = above
          ? compose(invert({ basis: above.basis, offset: above.offset }), { basis: bone.basis, offset: bone.offset })
          : { basis: bone.basis, offset: bone.offset };
        // glTF forbids a matrix on a node an animation drives, so anything the
        // clips touch is written as the three parts instead.
        const placed = animated.has(bone.name)
          ? (() => {
              const trs = decompose(local);
              return { translation: trs.translation, rotation: trs.rotation, scale: trs.scale };
            })()
          : { matrix: matrixOf({ name: bone.name, basis: local.basis, offset: local.offset }) };
        nodes.push({ name: bone.name, ...placed });
        named.set(bone.name, [...(named.get(bone.name) ?? []), index]);
      }
      // Wired in a second pass: the ancestors an animation needs are appended
      // after the joints, so a joint's parent is usually a node that does not
      // exist yet while the first pass is running.
      mesh.skeleton.forEach((bone, i) => {
        const parent = bone.parent === undefined ? undefined : at.get(bone.parent);
        if (parent === undefined) return;
        const holder = nodes[parent];
        holder.children = [...((holder.children as number[]) ?? []), first + i];
      });

      const joints = mesh.skeleton.slice(0, mesh.jointCount ?? mesh.skeleton.length);
      const bind = Buffer.concat(joints.map((bone) => floats(inverseMatrixOf(bone))));
      const inverseBindMatrices = accessors.push({
        bufferView: buffer.add(bind),
        componentType: ComponentType.Float,
        count: joints.length,
        type: "MAT4",
      }) - 1;

      const jointData = Buffer.alloc(mesh.joints.length * 2);
      for (let i = 0; i < mesh.joints.length; i++) {
        jointData.writeUInt16LE(Math.min(mesh.joints[i], (mesh.jointCount ?? mesh.skeleton.length) - 1), i * 2);
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

      // Only the leading entries are joints: anything after them is an
      // ancestor added to carry an animation, which the skin never binds.
      skins.push({
        joints: mesh.skeleton.slice(0, mesh.jointCount ?? mesh.skeleton.length).map((_, i) => first + i),
        inverseBindMatrices,
      });
      skin = skins.length - 1;
    }

    gltfMeshes.push({ name: mesh.name, primitives });
    nodes.push({ name: mesh.name, mesh: gltfMeshes.length - 1, ...(skin === undefined ? {} : { skin }) });
  }

  const animations = clips.map((clip) => {
    const samplers: unknown[] = [];
    const channels: unknown[] = [];
    for (const channel of clip.channels) {
      const targets = named.get(channel.node);
      if (!targets || channel.times.length === 0) continue;
      const stride = channel.path === "rotation" ? 4 : 3;
      if (channel.values.length !== channel.times.length * stride) continue;
      const input = accessors.push({
        bufferView: buffer.add(floats(channel.times)),
        componentType: ComponentType.Float,
        count: channel.times.length,
        type: "SCALAR",
        // Required on an animation's input, and what a player reads the clip's
        // length off.
        min: [channel.times[0]],
        max: [channel.times[channel.times.length - 1]],
      }) - 1;
      const output = accessors.push({
        bufferView: buffer.add(floats(channel.values)),
        componentType: ComponentType.Float,
        count: channel.times.length,
        type: stride === 4 ? "VEC4" : "VEC3",
      }) - 1;
      const sampler = samplers.push({ input, output, interpolation: "LINEAR" }) - 1;
      for (const node of targets) channels.push({ sampler, target: { node, path: channel.path } });
    }
    return { name: clip.name, samplers, channels };
  }).filter((clip) => (clip.channels as unknown[]).length > 0);

  // A node another one carries is not a root, or a viewer would draw it twice
  // and place the second copy as though it hung off nothing.
  const carried = new Set(nodes.flatMap((n) => (n.children as number[]) ?? []));
  const bin = buffer.build();
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0", generator: "wot.build" },
      scene: 0,
      scenes: [{ nodes: nodes.map((_, i) => i).filter((i) => !carried.has(i)) }],
      nodes,
      ...(skins.length > 0 ? { skins } : {}),
      ...(animations.length > 0 ? { animations } : {}),
      meshes: gltfMeshes,
      accessors,
      bufferViews: buffer.views,
      buffers: [{ byteLength: bin.length }],
    }),
    "utf8",
  );
  return container(json, bin);
}
