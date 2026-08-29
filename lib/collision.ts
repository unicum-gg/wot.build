// Turning a vehicle's Havok collision file into plain triangle meshes.
//
// One file holds every collidable piece of a hull, turret, gun or chassis as a
// named shape: `s_armor_3` is the plate the vehicle's armor table calls
// `armor_3`, and the rest are the parts the game treats specially (tracks, gun,
// optics). Names are what ties the geometry to a thickness, so they are carried
// through untouched.
//
// The mesh itself is quantised. Vertices come in two flavours: per-section
// `packed` ones, 11/11/10 bits scaled into that section's own box, and file-wide
// `shared` ones, 21/21/22 bits spread across the whole model's box. Faces are
// quads indexing into whichever pool the index falls in, so they are rebased
// into a single vertex list and fanned into triangles.
import { mirrorPositions, reverseWinding } from "./handedness.js";
import { TagFile, type TagValue } from "./havok.js";

/** One vehicle piece: every shape it is made of, merged into one mesh. */
export type CollisionPart = {
  /** Flat `x, y, z` triples. */
  positions: number[];
  /** Flat triangle indices into `positions`. */
  indices: number[];
  /** Which slice of `indices` belongs to which named shape, in draw order. */
  groups: { name: string; start: number; count: number }[];
};

export type CollisionShape = {
  name: string;
  /** Flat `x, y, z` triples. */
  positions: number[];
  /** Flat triangle indices into `positions`. */
  triangles: number[];
};

const COLLISION_VARIANT = "Collision Physics Data";

function field(value: TagValue, name: string): TagValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value[name] ?? null) : null;
}

function list(value: TagValue): TagValue[] {
  return Array.isArray(value) ? value : [];
}

function num(value: TagValue): number {
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
}

function vector3(value: TagValue): [number, number, number] {
  const v = list(value);
  return [num(v[0]), num(v[1]), num(v[2])];
}

/** A `domain` member: the axis-aligned box a set of quantised vertices lives in. */
function domain(value: TagValue): { min: [number, number, number]; max: [number, number, number] } {
  return { min: vector3(field(value, "min")), max: vector3(field(value, "max")) };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

type Section = {
  min: [number, number, number];
  max: [number, number, number];
  codecMin: [number, number, number];
  codecScale: [number, number, number];
  firstPackedVertex: number;
  firstSharedVertex: number;
  firstPrimitive: number;
  packedVertices: number;
  primitives: number;
};

function readSection(value: TagValue): Section {
  const box = domain(field(value, "domain"));
  const codec = list(field(value, "codecParms")).map(num);
  return {
    min: box.min,
    max: box.max,
    codecMin: [codec[0] ?? 0, codec[1] ?? 0, codec[2] ?? 0],
    codecScale: [codec[3] ?? 0, codec[4] ?? 0, codec[5] ?? 0],
    firstPackedVertex: num(field(value, "firstPackedVertexIndex")),
    firstSharedVertex: num(field(value, "firstSharedVertexIndex")),
    firstPrimitive: num(field(value, "firstPrimitiveIndex")),
    packedVertices: num(field(value, "numPackedVertices")),
    primitives: num(field(value, "numPrimitives")),
  };
}

const SHARED_XY = 0x1fffff;
const SHARED_Z = 0x3fffff;

function meshToShape(name: string, meshTree: TagValue): CollisionShape {
  const box = domain(field(meshTree, "domain"));
  const packed = list(field(meshTree, "packedVertices")).map(num);
  const shared = list(field(meshTree, "sharedVertices"));
  const sharedIndex = list(field(meshTree, "sharedVerticesIndex")).map(num);
  const sections = list(field(meshTree, "sections")).map(readSection);
  const quads = list(field(meshTree, "primitives")).map((p) => list(field(p, "indices")).map(num));

  const positions = new Array<number>((packed.length + shared.length) * 3).fill(0);

  const span: [number, number, number] = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  for (let i = 0; i < shared.length; i++) {
    const bits = typeof shared[i] === "bigint" ? (shared[i] as bigint) : BigInt(num(shared[i]));
    const x = Number(bits & BigInt(SHARED_XY)) / SHARED_XY;
    const y = Number((bits >> 21n) & BigInt(SHARED_XY)) / SHARED_XY;
    const z = Number((bits >> 42n) & BigInt(SHARED_Z)) / SHARED_Z;
    const at = (packed.length + i) * 3;
    positions[at] = x * span[0] + box.min[0];
    positions[at + 1] = y * span[1] + box.min[1];
    positions[at + 2] = z * span[2] + box.min[2];
  }

  const triangles: number[] = [];
  for (const section of sections) {
    for (let i = 0; i < section.packedVertices; i++) {
      const bits = packed[section.firstPackedVertex + i] ?? 0;
      const raw = [bits & 0x7ff, (bits >>> 11) & 0x7ff, (bits >>> 22) & 0x3ff];
      const at = (section.firstPackedVertex + i) * 3;
      for (let axis = 0; axis < 3; axis++) {
        const value = raw[axis] * section.codecScale[axis] + section.codecMin[axis];
        positions[at + axis] = clamp(value, section.min[axis], section.max[axis]);
      }
    }

    for (let p = 0; p < section.primitives; p++) {
      const quad = quads[section.firstPrimitive + p];
      if (!quad) continue;
      const corners = quad.map((index) =>
        index >= section.packedVertices
          ? packed.length + (sharedIndex[section.firstSharedVertex + index - section.packedVertices] ?? 0)
          : index + section.firstPackedVertex,
      );
      for (const [a, b, c] of [
        [corners[0], corners[1], corners[2]],
        [corners[0], corners[2], corners[3]],
      ]) {
        if (a === b || b === c || a === c) continue;
        triangles.push(a, b, c);
      }
    }
  }

  return { name, positions, triangles };
}

/** Every named collision shape in one `.havok` file, in file order. */
export function readCollision(buf: Buffer): CollisionShape[] {
  const root = new TagFile(buf).root();
  const handles = list(field(field(list(field(root, "namedVariants"))[0], "variant"), "resourceHandles"));

  const out: CollisionShape[] = [];
  for (const handle of handles) {
    if (field(handle, "name") !== COLLISION_VARIANT) continue;
    for (const body of list(field(field(handle, "variant"), "bodyCinfos"))) {
      const meshTree = field(field(field(body, "shape"), "data"), "meshTree");
      if (!meshTree) continue;
      const name = field(body, "name");
      out.push(meshToShape(typeof name === "string" ? name : "", meshTree));
    }
  }
  return out;
}

/** How many decimals a position keeps: a tenth of a millimetre, which is finer
 * than the quantisation the shapes arrive in. */
const PRECISION = 4;

/**
 * Merge a piece's shapes into a single mesh with one group per shape.
 *
 * A viewer draws a piece as one buffer and colours each group from the armor
 * table, so the shapes are concatenated rather than kept apart. The `s_` prefix
 * the physics engine uses is dropped, leaving the name the vehicle's armor
 * table already uses (`armor_3`, `leftTrack`, `gun`).
 */
export function mergeShapes(shapes: CollisionShape[]): CollisionPart {
  const part: CollisionPart = { positions: [], indices: [], groups: [] };
  const round = (v: number) => Number(v.toFixed(PRECISION));
  for (const shape of shapes) {
    if (shape.triangles.length === 0) continue;
    const base = part.positions.length / 3;
    const start = part.indices.length;
    for (const value of shape.positions) part.positions.push(round(value));
    for (const index of shape.triangles) part.indices.push(base + index);
    part.groups.push({
      name: shape.name.replace(/^s_/, ""),
      start,
      count: part.indices.length - start,
    });
  }
  // The client's space is left-handed and glTF's is not, so the whole shell is
  // flipped across its centreline and its triangles rewound to match.
  mirrorPositions(part.positions);
  reverseWinding(part.indices);
  return part;
}
