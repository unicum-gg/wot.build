// Turning the client's keyframes into the clips a `.glb` carries.
//
// The prefab gives a node's own transform in its parent's space, over time. A
// published piece is the same tree mirrored across the vehicle's centreline and
// flattened, so the two do not line up: writing the client's numbers straight
// into a published node would animate it in a space it does not live in.
//
// What holds instead is stated once here. Skinning applies
// `world(t) * world(0)^-1` to a vertex, so all a clip has to reproduce is that
// product, mirrored. Every node therefore gets a fixed pair of placements
// around the client's own local transform, chosen so the product comes out
// right and so the pose at t=0 is exactly the pose the piece already publishes.
// Nothing about the rest of the mirror has to change for it.
import type { GltfAnimation, GltfChannel } from "./gltf.js";
import { mirrorPoint } from "./handedness.js";
import {
  compose,
  decompose,
  fromEuler,
  IDENTITY,
  invert,
  MIRROR,
  type Placement,
} from "./placement.js";
import { SequencePath, type SequenceClip, type SequenceCurve, type SequenceKey } from "./sequence.js";
import type { VisualPlace } from "./visual.js";

/** How finely an eased segment is cut up, in samples per second. */
const EASED_RATE = 30;

/** How close two samples have to be for the middle one to be dropped. */
const FLAT = 1e-5;

/**
 * How long a layer has to run to be an animation rather than a pose.
 *
 * The client uses the same mechanism for both. Beside its real opening and
 * closing, the Object 432U carries `layer0` and `opened`, a tenth of a second
 * each, and the Strv 107-12 one of a hundredth: their job is to hold a part
 * somewhere, not to move it. Published, they would be offered to a reader as
 * something to watch and would snap the vehicle instead.
 *
 * A quarter of a second separates the two cleanly here. Every real clip in the
 * client runs a second or more, and every pose runs a tenth or less, which is
 * also about where a motion stops reading as one at all.
 */
const SHORTEST = 0.25;

/** The published placement of a node: the client's, flipped across the centreline. */
const published = (at: Placement): Placement => ({ basis: at.basis, offset: mirrorPoint(at.offset) });

/** A scale as a placement. */
const scaled = (s: number[]): Placement => ({
  basis: [s[0], 0, 0, 0, s[1], 0, 0, 0, s[2]],
  offset: [0, 0, 0],
});

/** A basis split into the rotation it turns by and the scale it stretches by. */
function split(at: Placement): { rotation: Placement; scale: number[] } {
  const rows = [at.basis.slice(0, 3), at.basis.slice(3, 6), at.basis.slice(6, 9)];
  const scale = rows.map((r) => Math.hypot(r[0], r[1], r[2]) || 1);
  const basis = rows.flatMap((r, i) => r.map((v) => v / scale[i]));
  return { rotation: { basis, offset: [0, 0, 0] }, scale };
}

/** Where a curve stands at one moment. */
function at(keys: SequenceKey[], time: number): number {
  if (keys.length === 0) return 0;
  if (time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].time <= time) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.time - a.time;
  if (span <= 0) return b.value;
  const s = (time - a.time) / span;
  if (!a.ease) return a.value + (b.value - a.value) * s;
  // A cubic Hermite through the slopes the client stores, in units per second,
  // and flat where it stored the sentinel that means "work it out". Flat at
  // both ends is an ease in and out, which is what the sentinel looks like.
  const m0 = (a.outSlope ?? 0) * span;
  const m1 = (b.inSlope ?? 0) * span;
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    (2 * s3 - 3 * s2 + 1) * a.value +
    (s3 - 2 * s2 + s) * m0 +
    (-2 * s3 + 3 * s2) * b.value +
    (s3 - s2) * m1
  );
}

/**
 * When to sample a node, given every curve that drives it.
 *
 * The client's own key times, plus a cut through any span one of its curves
 * eases across, since a straight line between two keys of a curve is exactly
 * what an eased key says it is not.
 */
function times(curves: SequenceCurve[]): number[] {
  const marks = [...new Set(curves.flatMap((c) => c.keys.map((k) => k.time)))].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < marks.length; i++) {
    out.push(marks[i]);
    const next = marks[i + 1];
    if (next === undefined) continue;
    const eased = curves.some((c) =>
      c.keys.some((k, j) => k.ease && k.time <= marks[i] && (c.keys[j + 1]?.time ?? -1) >= next),
    );
    if (!eased) continue;
    const steps = Math.max(1, Math.round((next - marks[i]) * EASED_RATE));
    for (let s = 1; s < steps; s++) out.push(marks[i] + ((next - marks[i]) * s) / steps);
  }
  return out;
}

/** Drop the samples that sit on the straight line between their neighbours. */
function thin(keep: number[], values: number[][]): { times: number[]; values: number[][] } {
  if (keep.length < 3) return { times: keep, values };
  const outTimes = [keep[0]];
  const outValues = [values[0]];
  for (let i = 1; i < keep.length - 1; i++) {
    const a = outValues[outValues.length - 1];
    const b = values[i];
    const c = values[i + 1];
    const ta = outTimes[outTimes.length - 1];
    const s = (keep[i] - ta) / (keep[i + 1] - ta || 1);
    const straight = b.every((v, k) => Math.abs(v - (a[k] + (c[k] - a[k]) * s)) < FLAT);
    if (straight) continue;
    outTimes.push(keep[i]);
    outValues.push(b);
  }
  outTimes.push(keep[keep.length - 1]);
  outValues.push(values[values.length - 1]);
  return { times: outTimes, values: outValues };
}

/**
 * The client's local transform for a node at one moment.
 *
 * Whatever the curves do not say stays as the piece rests: a node with only a
 * `position.z` track keeps the rotation and the other two axes its artist gave
 * it, rather than being rebuilt from nothing at the origin.
 */
function localAt(rest: Placement, curves: SequenceCurve[], time: number): Placement {
  const base = split(rest);
  const offset = [...rest.offset];
  const scale = [...base.scale];
  let rotation = base.rotation;
  const euler = [0, 0, 0];
  let turned = false;
  for (const curve of curves) {
    const value = at(curve.keys, time);
    if (curve.path === SequencePath.Translation) offset[curve.axis] = value;
    else if (curve.path === SequencePath.Scale) scale[curve.axis] = value;
    else {
      euler[curve.axis] = value;
      turned = true;
    }
  }
  if (turned) rotation = fromEuler(euler[0], euler[1], euler[2]);
  return { ...compose(rotation, scaled(scale)), offset };
}

/**
 * Every clip a piece plays, in the space the piece is published in.
 *
 * `tree` is the piece's own node tree, which is where a node's parent and its
 * resting transform come from. A curve naming a node the piece does not have is
 * dropped: prefabs are shared between a gun and the styles worn over it, and a
 * style that leaves a part off should not carry a channel for it.
 */
export function clipsFor(
  clips: SequenceClip[],
  tree: Map<string, VisualPlace>,
  parents: Map<string, string | undefined>,
): GltfAnimation[] {
  const out: GltfAnimation[] = [];
  for (const clip of clips) {
    const byNode = new Map<string, SequenceCurve[]>();
    for (const curve of clip.curves) {
      if (!tree.has(curve.node)) continue;
      byNode.set(curve.node, [...(byNode.get(curve.node) ?? []), curve]);
    }
    const channels: GltfChannel[] = [];
    for (const [node, curves] of byNode) {
      const here = tree.get(node);
      if (!here) continue;
      const above = here.parent ? tree.get(here.parent)?.world ?? IDENTITY : IDENTITY;
      const emitted = parents.get(node);
      const over = emitted ? tree.get(emitted)?.world : undefined;
      // The fixed pair either side of the client's own local transform. Read
      // outermost first: undo the emitted parent, mirror, and drop into the
      // client parent's space on the left; come back out of the node's rest
      // world, mirror, and into its published placement on the right.
      const before = compose(
        over ? invert(published(over)) : IDENTITY,
        compose(MIRROR, above),
      );
      const after = compose(invert(here.world), compose(MIRROR, published(here.world)));

      const marks = times(curves);
      const poses = marks.map((time) =>
        decompose(compose(before, compose(localAt(here.local, curves, time), after))),
      );
      const paths: [SequencePath, (t: ReturnType<typeof decompose>) => number[]][] = [
        [SequencePath.Translation, (t) => t.translation],
        [SequencePath.Rotation, (t) => t.rotation],
        [SequencePath.Scale, (t) => t.scale],
      ];
      for (const [path, pick] of paths) {
        // Only what the node is actually asked to do: a chamber that turns
        // publishes a rotation and nothing else, and its translation and scale
        // stay on the node where the rest pose put them.
        if (!curves.some((c) => c.path === path)) continue;
        const cut = thin(marks, poses.map(pick));
        if (cut.times.length === 0) continue;
        channels.push({
          node,
          path,
          times: cut.times,
          values: cut.values.flat(),
        });
      }
    }
    if (channels.length === 0) continue;
    const span = Math.max(...channels.map((c) => c.times[c.times.length - 1] - c.times[0]));
    if (span < SHORTEST) continue;
    // **Named clips collide.** A prefab reaches others, and a vehicle whose
    // mechanism is built from four of them arrives with `opening` four times
    // over. A player asked for one by name would get whichever the loader kept.
    if (out.some((known) => known.name === clip.name)) continue;
    out.push({ name: clip.name, channels });
  }
  return out;
}

/** The nodes a set of clips moves, which is what needs a chain to move through. */
export function movedBy(clips: SequenceClip[]): Set<string> {
  return new Set(clips.flatMap((clip) => clip.curves.map((curve) => curve.node)));
}
