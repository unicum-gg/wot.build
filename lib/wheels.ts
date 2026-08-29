// The wheels a chassis turns, and the bones a piece is skinned to.
//
// A wheel is a bone the client spins, named for the side it is on and the order
// it sits in. What the mesh carries is the bone; what makes it turn at the right
// rate is its radius, which only the chassis script knows.
import type { GltfBone } from "./gltf.js";
import { mirrorPoint } from "./handedness.js";
import type { VertexData } from "./primitives.js";
import type { Placement, VisualRenderSet } from "./visual.js";

/**
 * A wheel's bones, as the client names them: `W_L0_BlendBone`,
 * `WD_R1_BlendBone`, and on a wheeled vehicle `WD_L0_SCR_BlendBone`.
 *
 * **The `_SCR_` one is not optional.** Where a vehicle steers, the wheel's disc
 * is bound to it and the plain bone beside it carries only the suspension arm.
 * Leaving it out of the pattern threw the disc's vertices away, so the arm alone
 * was measured: the Panhard EBR came out with a radius of 0.29 against a real
 * 0.59 and an axle off the wheel's centre, and its steered wheels swung instead
 * of turning.
 */
export type Wheel = {
  /** The bone to turn, as the skin names it. */
  bone: string;
  /** Where its axle sits, so the turn happens about the right point. */
  axle: number[];
  /**
   * How far the rim stands from that axle, so a turn can match a distance.
   *
   * The chassis script's own figure where it gives one. Measuring the mesh
   * instead comes out 5% short on every wheel of the IS-7, which is a belt and
   * a set of wheels running at different speeds.
   */
  radius: number;
  /**
   * The circle the belt runs on around it, which is not the rim.
   *
   * A drive sprocket carries its track in the tooth roots, 51 mm inside the
   * tips on the IS-7, and an idler stands it off instead. Only the road wheels
   * have the two the same. Equal to the radius for a vehicle whose script the
   * client has dropped, which is the best that can be said without one.
   */
  wrap: number;
};

/** The plain bone a steering bone sits beside, which holds the arm and not the disc. */
const steeringSibling = (name: string) => name.replace("_SCR_", "_");

const WHEEL_BONE = /^WD?_[LR]\d+(_SCR)?_BlendBone$/;

/**
 * Where each of a piece's wheels turns, read from the wheel itself.
 *
 * The node tree does carry a placement beside each wheel bone, but in the
 * bone's own space rather than the mesh's, so using it puts every axle on the
 * wrong side of the tank. The geometry has no such ambiguity: every vertex is
 * bound rigidly to one bone, so a wheel is exactly the cloud of vertices
 * naming it, its axle is that cloud's centre and its radius half the height it
 * spans. Called once the rest pose is baked and the piece mirrored, so what
 * comes out is already in the space the `.glb` positions live in.
 */
export function wheelsOf(set: VisualRenderSet, vertices: VertexData): Wheel[] {
  const clouds = new Map<number, { min: number[]; max: number[] }>();
  for (let i = 0; i * 4 < vertices.bones.length; i++) {
    let bone = -1;
    let best = 0;
    for (let k = 0; k < 4; k++) {
      const weight = vertices.weights[i * 4 + k];
      if (weight > best) {
        best = weight;
        bone = vertices.bones[i * 4 + k];
      }
    }
    if (bone < 0 || !WHEEL_BONE.test(set.bones[bone] ?? "")) continue;
    let cloud = clouds.get(bone);
    if (!cloud) clouds.set(bone, (cloud = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    for (let axis = 0; axis < 3; axis++) {
      const value = vertices.positions[i * 3 + axis];
      if (value < cloud.min[axis]) cloud.min[axis] = value;
      if (value > cloud.max[axis]) cloud.max[axis] = value;
    }
  }
  const out: Wheel[] = [];
  for (const [bone, cloud] of clouds) {
    // A wheel is a disc standing on edge, so the height it spans is its
    // diameter. Width would be the hub, which says nothing about the turn.
    const radius = (cloud.max[1] - cloud.min[1]) / 2;
    out.push({
      bone: set.bones[bone],
      axle: cloud.min.map((low, axis) => (low + cloud.max[axis]) / 2),
      // Both stand in until the script is read, which is where the real figures
      // are. Measuring a rim comes out about 5% under what the game turns it at.
      radius,
      wrap: radius,
    });
  }
  // Where a wheel steers, two bones answer to it and only one carries the disc.
  // The arm is not a wheel and measuring it says nothing about the turn.
  const steered = new Set(out.filter((w) => w.bone.includes("_SCR_")).map((w) => steeringSibling(w.bone)));
  return out.filter((w) => !steered.has(w.bone));
}

/** The render set's bones, placed in the piece's space, or undefined when it has none. */
export function skeletonOf(set: VisualRenderSet, nodes: Map<string, Placement>): GltfBone[] | undefined {
  if (set.bones.length === 0) return undefined;
  const placed = set.bones.map((name) => {
    const at = nodes.get(name) ?? { basis: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] };
    // The skeleton rides in the mirrored space with the vertices it drives.
    return { name, basis: at.basis, offset: mirrorPoint(at.offset) };
  });
  return placed.length > 0 ? placed : undefined;
}

/** Scale a vector back to unit length, leaving a zero vector alone. */
export function unit(v: number[]): number[] {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : v;
}

/** Whether a basis mirrors rather than rotates, which reverses triangle winding. */
export function determinant(b: number[]): number {
  return (
    b[0] * (b[4] * b[8] - b[5] * b[7]) -
    b[1] * (b[3] * b[8] - b[5] * b[6]) +
    b[2] * (b[3] * b[7] - b[4] * b[6])
  );
}
