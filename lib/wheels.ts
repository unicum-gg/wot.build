// The wheels a chassis turns, and the bones a piece is skinned to.
//
// A wheel is a bone the client spins, named for the side it is on and the order
// it sits in. What the mesh carries is the bone; what makes it turn at the right
// rate is its radius, which only the chassis script knows.
import type { GltfBone } from "./gltf.js";
import { mirrorPoint } from "./handedness.js";
import type { VertexData } from "./primitives.js";
import type { Placement, VisualPlace, VisualRenderSet } from "./visual.js";

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

/** The arms a levered suspension hangs its wheels from. */
// **Either end of the arm names it.** The chassis declares a `startNode` and a
// `jointNode` per lever, and the skin usually binds the arm to the start. The
// Windhund binds it to the joint instead and ships no start bone at all, which
// left it the one kneeling vehicle in the catalogue with no arms to swing. The
// hinge is recovered from the bone's own span either way, so which of the two
// names it happens to carry decides nothing.
const LEVER_BONE = /^Lever_(?:Start|Joint)_(.+?)(?:_BlendBone)?$/;

/** The arm a wheel rides on, for a vehicle that aims by kneeling. */
export type Lever = {
  /** The bone the arm's own geometry is bound to. */
  bone: string;
  /** Where it hinges on the hull, in the piece's space. */
  pivot: number[];
  /** The wheel it carries, by bone. */
  wheel: string;
  /** The length of belt that wheel stands on, by bone, where the piece has one. */
  track: string | null;
};

/**
 * Where each arm hinges, measured rather than declared.
 *
 * The client names the hinge as a node, and a node's transform is exactly what
 * a flattened skeleton no longer has: the rest pose is baked into the vertices,
 * so what is left of an arm is the span it occupies. **The hinge is the end of
 * that span furthest from the wheel it carries**, which is the one thing about
 * an arm that does not move when the arm does.
 *
 * Paired by name, `Lever_Start_L0` to `W_L0`, because the client pairs them by
 * name too and an arm whose wheel is missing has nothing to swing.
 */
/**
 * The span of every arm bone in one piece, to be matched to wheels later.
 *
 * **Read apart from the wheels because they are not always in the same place.**
 * A chassis is drawn as several render sets, and the SU-122V and the Latt
 * Stridsfordon 120 put their arms in one and the wheels they carry in another:
 * matched within a set they find nothing, and the vehicle comes out with a
 * suspension that cannot move.
 */
export function leverSpansOf(
  set: VisualRenderSet,
  vertices: VertexData,
): Map<string, { min: number[]; max: number[] }> {
  return boneSpans(set, vertices, (name) => LEVER_BONE.test(name));
}

/** Match arm spans to the wheels they carry, once every piece has been read. */
export function leversFrom(
  spans: Map<string, { min: number[]; max: number[] }>,
  wheels: Wheel[],
): Lever[] {
  const out: Lever[] = [];
  for (const [bone, span] of spans) {
    const suffix = LEVER_BONE.exec(bone)?.[1];
    const wheel = wheels.find((w) => w.bone.replace(/_BlendBone$/, "") === `W_${suffix}`);
    if (!wheel) continue;
    // One arm per wheel. A chassis that binds geometry to both ends of the arm
    // would otherwise get two, and the pair would swing the same wheel twice.
    if (bone.startsWith("Lever_Joint_") && spans.has(bone.replace("Lever_Joint_", "Lever_Start_"))) {
      continue;
    }
    // The far end along the vehicle, and the middle of the arm across and up:
    // a hinge is a line, and only where it sits fore and aft decides the swing.
    const far = Math.abs(span.min[2] - wheel.axle[2]) > Math.abs(span.max[2] - wheel.axle[2]) ? span.min[2] : span.max[2];
    out.push({
      bone,
      pivot: [(span.min[0] + span.max[0]) / 2, (span.min[1] + span.max[1]) / 2, far],
      wheel: wheel.bone,
      // The belt under that wheel, named the way the client names it: a lever's
      // `trackNode` is `Track_L0` where its `startNode` is `Lever_Start_L0`.
      //
      // Named rather than checked, because the arms and the belt are skinned as
      // separate sets and neither lists the other's bones. Whoever draws it
      // looks the name up across the whole piece and passes over what is not
      // there, which is the only place the question can be answered.
      track: `Track_${suffix}_BlendBone`,
    });
  }
  return out;
}

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
/**
 * The bones whose geometry rides clear of the road wheels.
 *
 * **A kneeling tank splits its chassis in two**, and this is the upper half:
 * the return rollers and the length of belt they carry, which are bolted to the
 * body and tip with it, against the wheels and the belt on the ground, which do
 * not. Only a vehicle that aims by kneeling has any use for the split.
 *
 * Measured by height rather than by name. Naming what stays and moving the rest
 * tears the bottom run: the belt between two lever stations is bound to
 * whatever the modeller had to hand, so some of what lies on the ground is
 * named by no lever and would be dragged up with the body, folding the track
 * into a crease. Anything wholly above the wheels' own tops is clear of the
 * ground by construction.
 */
export function floorsOf(set: VisualRenderSet, vertices: VertexData): Map<string, number> {
  const out = new Map<string, number>();
  for (const [bone, span] of boneSpans(set, vertices, () => true)) {
    out.set(bone, span.min[1]!);
  }
  return out;
}

/**
 * Which of them ride, given every wheel the piece turned out to have.
 *
 * Answered once the whole piece is read rather than set by set: a chassis is
 * skinned in several sets and the belt's top run is rarely in the same one as
 * the wheels it clears, so a set asked on its own knows neither where the roof
 * is nor that it is under it.
 */
export function ridersOf(floors: Map<string, number>, wheels: Wheel[], levers: Lever[]): string[] {
  // The wheels that stand on the ground are the ones the arms carry, which the
  // client names outright. Reading the roof off every wheel instead takes in
  // the sprocket and the idler, which sit high and put the line above the belt
  // it was meant to separate.
  const carried = new Set(levers.map((l) => l.wheel));
  const road = wheels.filter((w) => carried.has(w.bone));
  if (road.length === 0) return [];
  const roof = Math.max(...road.map((w) => w.axle[1]! + w.radius));
  const out: string[] = [];
  for (const [bone, floor] of floors) if (floor >= roof) out.push(bone);
  return out.sort();
}

/** What each named bone's own vertices span, in the piece's space. */
function boneSpans(
  set: VisualRenderSet,
  vertices: VertexData,
  wanted: (name: string) => boolean,
): Map<string, { min: number[]; max: number[] }> {
  const spans = new Map<string, { min: number[]; max: number[] }>();
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
    const name = bone < 0 ? "" : (set.bones[bone] ?? "");
    if (!name || !wanted(name)) continue;
    let span = spans.get(name);
    if (!span) spans.set(name, (span = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    for (let axis = 0; axis < 3; axis++) {
      const value = vertices.positions[i * 3 + axis];
      if (value < span.min[axis]) span.min[axis] = value;
      if (value > span.max[axis]) span.max[axis] = value;
    }
  }
  return spans;
}

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


/**
 * The render set's bones, placed in the piece's space, or undefined when it has
 * none, with whatever chain an animation needs to reach them.
 *
 * **Flat unless something moves.** The bones come back as world placements with
 * no parent, which is what a viewer turning a single wheel relies on: it writes
 * the bone's own matrix and the bind pose cancels the rest. Give every bone a
 * parent and that stops holding, because the bone's world is no longer the
 * matrix the viewer wrote.
 *
 * So a chain is built only where one is needed. The client keyframes a node's
 * transform in its parent's space, so a gun chamber that swings open has to
 * carry the plunger inside it; `animated` names the nodes with keyframes, and
 * for each bone under one of them the ancestors between the two are appended
 * after the joints and the parent links filled in. A piece with no mechanism
 * comes back exactly as flat as it always was.
 */
export function skeletonOf(
  set: VisualRenderSet,
  nodes: Map<string, Placement>,
  tree?: Map<string, VisualPlace>,
  animated?: ReadonlySet<string>,
): GltfBone[] | undefined {
  if (set.bones.length === 0) return undefined;
  const rest = (name: string): Placement =>
    nodes.get(name) ?? { basis: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] };
  // The skeleton rides in the mirrored space with the vertices it drives.
  const bone = (name: string, parent?: string): GltfBone => {
    const at = rest(name);
    return { name, basis: at.basis, offset: mirrorPoint(at.offset), ...(parent ? { parent } : {}) };
  };
  const placed = set.bones.map((name) => bone(name));
  if (!tree || !animated || animated.size === 0) return placed;

  /** A node's ancestors, nearest first, as the client nests them. */
  const above = (name: string): string[] => {
    const out: string[] = [];
    for (let at = tree.get(name)?.parent; at; at = tree.get(at)?.parent) out.push(at);
    return out;
  };

  const extra = new Map<string, GltfBone>();
  const jointAt = new Map(placed.map((b) => [b.name, b]));
  for (const joint of placed) {
    const chain = above(joint.name);
    // The highest ancestor with keyframes of its own: everything between it and
    // the bone has to exist for the motion to reach the skin, and everything
    // above it never moves, so the chain stops there.
    let top = -1;
    for (let i = 0; i < chain.length; i++) if (animated.has(chain[i])) top = i;
    if (top < 0) continue;
    const line = [joint.name, ...chain.slice(0, top + 1)];
    for (let i = 0; i < line.length; i++) {
      const parent = line[i + 1];
      // A node on the chain can be a joint in its own right, on a piece whose
      // skin binds both a chamber and the plunger inside it. It is written
      // once, as a joint, and only its parent is filled in here.
      const known = jointAt.get(line[i]);
      if (known) known.parent = parent;
      else if (!extra.has(line[i])) extra.set(line[i], bone(line[i], parent));
    }
  }
  return [...placed, ...extra.values()];
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
