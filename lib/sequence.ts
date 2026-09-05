// Reading the animation a vehicle's mechanism plays, out of its CGF prefab.
//
// **No `.model` in the client declares an animation for a vehicle.** Of the
// 66179 that ship, sixteen do, and they are birds, flags and an arrow. Every
// moving part of a tank is either driven by the engine from a physical state
// (a wheel turning, a hull kneeling on its suspension, a barrel recoiling) or
// keyframed here, in the prefab the piece points at.
//
// The prefab is JSON, and its animation is a `BW::SequenceComponent`: layers of
// tracks, each track naming an object in the prefab's own tree and the property
// of that object it drives. The object is bound to a mesh node by a
// `BW::StartAtNodeTransformComponent`, so a track resolves to a node of the
// `.visual_processed` we already read, by name, with nothing to guess.
//
// What the Pz.Kpfw. Neu's gun does with it: six chambers swing forty degrees
// open, hold two seconds and close, their plungers sliding with them, over a
// five second cycle the client starts from the timestamp of a shot fired while
// the gun is calibrated.

import fs from "node:fs";
import path from "node:path";

/** Which part of a node's placement a track drives. */
export enum SequencePath {
  Translation = "translation",
  Rotation = "rotation",
  Scale = "scale",
}

/** One sample of one scalar curve. */
export type SequenceKey = {
  time: number;
  value: number;
  /**
   * Whether the client eases out of this key rather than leaving it straight.
   *
   * The client writes one of four interpolations per key. `Linear` and
   * `SpecialRotation` are straight lines (the latter being how it says "this is
   * a rotation, interpolate it as one"), `CubicBezier` and `Hermite` curve. The
   * slopes it stores alongside are real, in units per second, except where they
   * are exactly pi/2, which is the sentinel for "work it out", and which is
   * what 1272 of the 1500 tangents in the client are.
   */
  ease: boolean;
  /** Slope entering the key, in units per second, or null for the sentinel. */
  inSlope: number | null;
  /** Slope leaving it. */
  outSlope: number | null;
};

/** One node's curve for one axis of one property. */
export type SequenceCurve = {
  node: string;
  path: SequencePath;
  /** 0, 1 or 2 for x, y or z. */
  axis: number;
  keys: SequenceKey[];
};

export type SequenceClip = {
  /** The layer's own name, or its index where the client left it unnamed. */
  name: string;
  /** How long the client says the layer runs, in seconds. */
  duration: number;
  loop: boolean;
  curves: SequenceCurve[];
};

/** The value the client writes for a tangent it wants worked out rather than read. */
const AUTO_SLOPE = Math.PI / 2;

const PATHS: Record<string, SequencePath> = {
  position: SequencePath.Translation,
  rotation: SequencePath.Rotation,
  scale: SequencePath.Scale,
};

const AXES: Record<string, number> = { x: 0, y: 1, z: 2 };

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A CGF value, which wraps its payload in a type tag. */
function cvalue(v: unknown): unknown {
  return isObject(v) && "__cvalue__" in v ? v.__cvalue__ : v;
}

function number(v: unknown): number | null {
  const n = Number(cvalue(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Every object in the prefab, by the id its tracks refer to it with.
 *
 * A track names a uuid; what a viewer needs is the mesh node, which the object
 * carries on its `BW::StartAtNodeTransformComponent`. The object's own name is
 * the fallback, and it is usually close but not equal: the gun's third left
 * chamber is `chamber_3_L` in the prefab and `chamber_3_L0` in the mesh, which
 * is exactly why the binding is read rather than matched by name.
 */
function bindings(root: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isObject(node)) return;
    const id = node.uuid;
    if (typeof id === "string") {
      const components = isObject(node.components) ? node.components : {};
      const at = components["BW::StartAtNodeTransformComponent"];
      const bound = isObject(at) && typeof at.nodeName === "string" ? at.nodeName : null;
      const own = typeof node.name === "string" ? node.name : null;
      const target = bound?.trim() || own;
      if (target) out.set(id, target);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(root);
  return out;
}

/** Every `BW::SequenceComponent` anywhere in the prefab. */
function sequences(root: unknown): Json[] {
  const out: Json[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isObject(node)) return;
    if (isObject(node.components)) {
      const found = node.components["BW::SequenceComponent"];
      if (isObject(found)) out.push(found);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(root);
  return out;
}

/** `["position", "z"]` out of the wrapped strings the client writes it as. */
function property(parameter: Json): string[] {
  const raw = parameter.property;
  if (!Array.isArray(raw)) return [];
  return raw.map((part) => String(cvalue(part)));
}

/** The slope stored beside a key, or null where the client left the sentinel. */
function slope(tangents: unknown, side: string, axis: number): number | null {
  if (!isObject(tangents)) return null;
  const at = tangents[side];
  if (!isObject(at)) return null;
  const value = number(["x", "y", "z"][axis] in at ? at[["x", "y", "z"][axis]] : null);
  if (value === null) return null;
  return Math.abs(value - AUTO_SLOPE) < 1e-4 ? null : value;
}

/** Whether the client curves out of a key of this kind rather than leaving it straight. */
const eases = (type: unknown): boolean =>
  type === "CubicBezier" || type === "Hermite" || type === "TCB";

/**
 * The keyframes of one axis of one parameter.
 *
 * A scalar parameter (`position.z`) writes one number per key; a vector one
 * (`rotation`) writes all three at once, and is split here into an axis apiece
 * so everything downstream handles one shape.
 */
function curveOf(parameter: Json, axis: number, vector: boolean): SequenceKey[] {
  const raw = parameter.keys;
  if (!Array.isArray(raw)) return [];
  const out: SequenceKey[] = [];
  for (const key of raw) {
    if (!isObject(key)) continue;
    const time = number(key.time);
    if (time === null) continue;
    const held = cvalue(key.value);
    const value = vector
      ? isObject(held)
        ? number(held[["x", "y", "z"][axis]]) ?? 0
        : null
      : number(held);
    if (value === null) continue;
    out.push({
      time,
      value,
      ease: eases(key.type),
      inSlope: slope(key.tangents, "left", vector ? axis : 0),
      outSlope: slope(key.tangents, "right", vector ? axis : 0),
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * Every animation the prefab holds, one clip per named layer.
 *
 * Only what moves geometry: a layer's tracks also drive particle emission and
 * light intensity, which a mirror of shapes has nothing to do with.
 */
export function readSequences(json: string | Buffer): SequenceClip[] {
  let root: unknown;
  try {
    root = JSON.parse(typeof json === "string" ? json : json.toString("utf8"));
  } catch {
    return [];
  }
  const bound = bindings(root);
  const clips: SequenceClip[] = [];
  for (const sequence of sequences(root)) {
    const layers = Array.isArray(sequence.layers) ? sequence.layers : [];
    layers.forEach((layer, index) => {
      if (!isObject(layer)) return;
      const curves: SequenceCurve[] = [];
      const tracks = Array.isArray(layer.tracks) ? layer.tracks : [];
      for (const track of tracks) {
        if (!isObject(track)) continue;
        const node = bound.get(String(track.object));
        if (!node) continue;
        const parameters = Array.isArray(track.parameters) ? track.parameters : [];
        for (const parameter of parameters) {
          if (!isObject(parameter)) continue;
          if (parameter.component !== "cgf::TransformComponent") continue;
          const [name, axis] = property(parameter);
          const path = PATHS[name];
          if (!path) continue;
          const vector = axis === undefined;
          const wanted = vector ? [0, 1, 2] : [AXES[axis]];
          for (const which of wanted) {
            if (which === undefined) continue;
            const keys = curveOf(parameter, which, vector);
            if (keys.length > 0) curves.push({ node, path, axis: which, keys });
          }
        }
      }
      if (curves.length === 0) return;
      clips.push({
        name: typeof layer.name === "string" && layer.name ? layer.name : `layer${index}`,
        duration: number(layer.duration) ?? 0,
        loop: layer.loop === true,
        curves,
      });
    });
  }
  return clips;
}

/**
 * The clips at a set of prefab paths, following what they reference.
 *
 * A prefab is a tree of objects that can each name another prefab, and a
 * mechanism is often two levels down: the BV 111 hangs its loading animation
 * off a hardpoint the vehicle names, and the vehicle names only the sound.
 * References are matched on the bytes rather than parsed for, since a path can
 * sit under any key the client feels like.
 *
 * A missing file is skipped rather than raised: a prefab a package has not
 * brought is a piece without its mechanism, which is what the piece already was.
 */
export function readPrefabs(root: string, paths: string[], seen = new Set<string>()): SequenceClip[] {
  const out: SequenceClip[] = [];
  for (const at of paths) {
    const key = at.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const full = path.join(root, at);
    if (!fs.existsSync(full)) continue;
    const raw = fs.readFileSync(full);
    out.push(...readSequences(raw));
    const nested = [...raw.toString("utf8").matchAll(/"prefab"\s*:\s*"([^"]+\.prefab)"/gi)].map((m) => m[1]);
    out.push(...readPrefabs(root, nested, seen));
  }
  return out;
}
