// Reader for BigWorld `.visual_processed`, the file that says how a piece is
// put together: which geometry blocks to draw, what to shade them with, and
// where its attachment points sit.
//
// Three things are read out of it. The node tree carries the `HP_*` hardpoints,
// which is how a vehicle assembles without consulting its scripts at all: a hull
// declares `HP_turretJoint`, a turret declares `HP_gunJoint`. The render sets
// name the geometry blocks in the companion `.primitives_processed` and pair
// them with materials. The materials carry the client's PBR texture set, whose
// property names map onto glTF's own (`diffuseMap` is base colour, `normalMap`
// is the normal, `metallicGlossMap` the metal-roughness pair).
//
// Geometry arrives already posed in the vehicle's own space, including the
// skinned chassis, so nothing has to be transformed to draw a vehicle at rest.
import { decodePacked, type PackedNode } from "./packed.js";

export type VisualNode = {
  name: string;
  /** Twelve floats: a three-by-three basis followed by a translation. */
  transform: number[];
  children: VisualNode[];
};

export type VisualMaterial = {
  name: string;
  shader: string;
  /** Shader property name to the client-relative path of its `.dds`. */
  textures: Record<string, string>;
  /**
   * Every other shader parameter, by property name.
   *
   * These are not decoration: `alphaTestEnable` is what cuts the gaps out of a
   * track, and `doubleSided` is what keeps its far side from vanishing. Drawing
   * a track without them turns it into a solid ribbon.
   */
  values: Record<string, boolean | number | number[]>;
};

export type VisualRenderSet = {
  /**
   * The bones this set is skinned to, in the order its vertices index them.
   *
   * A skinned piece stores its vertices in bone space, and the client's bones
   * carry a flip of the Z axis, so a chassis or a gun drawn without resolving
   * them comes out back to front.
   */
  bones: string[];
  /** Name of the vertex block in the `.primitives_processed`. */
  vertices: string;
  /** Name of the index block in the `.primitives_processed`. */
  indices: string;
  /**
   * Name of the extra vertex stream, when the set carries one. It holds either
   * a second set of texture coordinates (`.uv2`) or vertex colours (`colour`),
   * which is only distinguishable from the name.
   */
  stream: string;
  materials: VisualMaterial[];
};

export type Visual = {
  root: VisualNode | null;
  renderSets: VisualRenderSet[];
  boundingBox: { min: number[]; max: number[] } | null;
};

function child(node: PackedNode, name: string): PackedNode | undefined {
  return node.children.find((c) => c.name === name);
}

function children(node: PackedNode, name: string): PackedNode[] {
  return node.children.filter((c) => c.name === name);
}

function text(node: PackedNode | undefined): string {
  return typeof node?.value === "string" ? node.value : "";
}

function numbers(node: PackedNode | undefined): number[] {
  if (Array.isArray(node?.value)) return node.value;
  if (typeof node?.value === "number") return [node.value];
  if (typeof node?.value === "string") {
    return node.value.trim().split(/\s+/).map(Number).filter((n) => !Number.isNaN(n));
  }
  return [];
}

function readNode(node: PackedNode): VisualNode {
  return {
    name: text(child(node, "identifier")),
    transform: numbers(child(node, "transform")),
    children: children(node, "node").map(readNode),
  };
}

/** A property's value, whatever the client typed it as. */
function propertyValue(node: PackedNode): boolean | number | number[] | null {
  switch (node.name) {
    case "Bool":
      return node.value === true || node.value === "true";
    case "Float":
    case "Int":
      return Number(node.value);
    case "Vector4":
      return numbers(node);
    default:
      return null;
  }
}

function readMaterial(node: PackedNode): VisualMaterial {
  const textures: Record<string, string> = {};
  const values: Record<string, boolean | number | number[]> = {};
  for (const property of children(node, "property")) {
    // A property names itself in its own text, and some of the client's files
    // leave the rest of the line in there: a style's material reads
    // `"g_maskBias\n                        >"`. Read the identifier and drop
    // whatever follows, or the lookups by name all miss and the material
    // silently loses its mask bias and its detail weights.
    const raw = typeof property.value === "string" ? property.value : "";
    const name = raw.trim().split(/\s/)[0] ?? "";
    const carried = property.children[0];
    if (!name || !carried) continue;
    if (carried.name === "Texture") {
      textures[name] = text(carried);
      continue;
    }
    const value = propertyValue(carried);
    if (value !== null) values[name] = value;
  }
  return { name: text(child(node, "identifier")), shader: text(child(node, "fx")), textures, values };
}

function readRenderSet(node: PackedNode): VisualRenderSet | null {
  const geometry = child(node, "geometry");
  if (!geometry) return null;
  return {
    bones: children(node, "node").map((c) => text(c)),
    vertices: text(child(geometry, "vertices")),
    indices: text(child(geometry, "primitive")),
    stream: text(child(geometry, "stream")),
    materials: children(geometry, "primitiveGroup")
      .map((group) => child(group, "material"))
      .filter((m): m is PackedNode => m !== undefined)
      .map(readMaterial),
  };
}

export function readVisual(buf: Buffer): Visual {
  const root = decodePacked(buf);
  const box = child(root, "boundingBox");
  return {
    root: child(root, "node") ? readNode(child(root, "node")!) : null,
    renderSets: children(root, "renderSet")
      .map(readRenderSet)
      .filter((s): s is VisualRenderSet => s !== null),
    boundingBox: box ? { min: numbers(child(box, "min")), max: numbers(child(box, "max")) } : null,
  };
}

/** A node's placement: a three-by-three basis followed by a translation. */
export type Placement = { basis: number[]; offset: number[] };

const IDENTITY: Placement = { basis: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] };

/** Apply a placement to a point. The client stores its basis as row vectors. */
export function place(p: Placement, x: number, y: number, z: number): [number, number, number] {
  const b = p.basis;
  return [
    x * b[0] + y * b[3] + z * b[6] + p.offset[0],
    x * b[1] + y * b[4] + z * b[7] + p.offset[1],
    x * b[2] + y * b[5] + z * b[8] + p.offset[2],
  ];
}

/** `child` expressed in the space `parent` lives in. */
function compose(parent: Placement, child: Placement): Placement {
  const basis: number[] = [];
  for (let row = 0; row < 3; row++) {
    const v = place({ basis: parent.basis, offset: [0, 0, 0] }, child.basis[row * 3], child.basis[row * 3 + 1], child.basis[row * 3 + 2]);
    basis.push(...v);
  }
  return { basis, offset: place(parent, child.offset[0], child.offset[1], child.offset[2]) };
}

function toPlacement(node: VisualNode): Placement {
  const t = node.transform;
  return t.length >= 12 ? { basis: t.slice(0, 9), offset: t.slice(9, 12) } : IDENTITY;
}

/**
 * Every node's placement in the piece's own space, by name.
 *
 * A node's transform is relative to its parent, so a hardpoint nested under a
 * grouping node means nothing until the chain above it is folded in.
 */
export function placements(root: VisualNode | null): Map<string, Placement> {
  const out = new Map<string, Placement>();
  const walk = (node: VisualNode, parent: Placement): void => {
    const here = compose(parent, toPlacement(node));
    out.set(node.name, here);
    for (const c of node.children) walk(c, here);
  };
  if (root) walk(root, IDENTITY);
  return out;
}

/**
 * Every attachment point in the tree, by name, with its translation.
 *
 * Hardpoints are what a viewer hangs the next piece off, and they are nested
 * under whatever grouping node the artist used, so the tree is flattened.
 */
export function hardpoints(node: VisualNode | null): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [name, placement] of placements(node)) {
    if (name.startsWith("HP_")) out[name] = placement.offset;
  }
  return out;
}
