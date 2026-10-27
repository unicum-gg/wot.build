// What a chassis says about its wheels, which no mesh carries.
//
// A wheel turns at a rate its radius decides, and the circle a track wraps it on
// is not its rim: on a drive sprocket the belt sits down in the tooth roots,
// on an idler it stands off by the link's own thickness.
import type { PackedNode } from "./packed.js";
import { child, children } from "./read.js";

/** The client writes vectors as text, and drops to a real array for some. */
function numbers(node: PackedNode | undefined): number[] {
  if (!node) return [];
  if (Array.isArray(node.value)) return node.value.map(Number);
  if (typeof node.value === "number") return [node.value];
  if (typeof node.value === "string") {
    return node.value.trim().split(/\s+/).map(Number);
  }
  return [];
}

/** What a chassis says about one of its wheels, which no mesh says. */
export type ChassisWheel = {
  /** The node the client turns, as the tree names it: `W_L0`, `WD_R1`. */
  name: string;
  /** How big the wheel is, which is what decides how fast it turns. */
  radius: number;
  /**
   * The circle the track wraps it on, which is not its rim, or null where the
   * chassis names none.
   *
   * On a drive sprocket the track sits down in the tooth roots, well inside the
   * tips: the IS-7's is a 432 mm wheel the track wraps at 381. On an idler it
   * stands off instead, by the link's own thickness. Only the road wheels have
   * the two the same.
   *
   * **Null rather than the rim, because the difference is the whole value of
   * it.** Filled in with the radius, a wheel the chassis says nothing about
   * reads as one it declares to carry its belt exactly on its rim, and the
   * caller can no longer tell a statement from a silence.
   */
  wrap: number | null;
  /**
   * The circle the belt actually seats on, where the chassis overrides the rim.
   *
   * **A drive sprocket's teeth stand through its track, so the belt rides well
   * inside the circle the mesh spans.** The AE Phase I's sprocket is a 463 mm
   * wheel and its chassis puts the chain on 411; its own baked ribbon has the
   * shoe's inner face at 425 and the rim at 463, so the teeth really do reach
   * out between the plates. Taken off the mesh instead, the belt climbs onto
   * the tips and its top run rides a tooth's depth too high all the way along.
   *
   * Read from `physicalTracks`, which is the chain the client simulates and
   * draws up close, and not from `trackDebris`'s `wheelGroups`, which is the
   * physics of a track that has come off: 1,712 of the 1,776 chassis override
   * at least one wheel here, where the debris block disagrees with the drawn
   * belt on vehicles like the Durendal and the AAT 60 by enough to drive their
   * road wheels through their own tracks.
   *
   * Null where the chassis overrides nothing for this wheel, which is the rim.
   */
  seat: number | null;
};

/**
 * How big a wheel the chassis says this is, wherever it keeps the figure.
 *
 * **The same trap `chassisBelts` documents, one field over.** A `<group>` keeps
 * its radius directly and a `<wheel>` keeps it under `<geometry>`, so a reader
 * that looks only at the direct child drops every wheel named one at a time.
 * That is the drive sprockets and the idlers on 41 chassis, 386 wheels, and
 * losing them is silent: the wheel still turns, measured off its own mesh, and
 * nothing downstream knows the chassis had anything to say about it. On the AE
 * Phase I it is all eight end wheels, which is exactly where a belt's shape is
 * decided.
 */
function wheelRadius(wheel: PackedNode): number {
  const direct = numbers(child(wheel, "radius"))[0];
  if (Number.isFinite(direct) && direct > 0) return direct;
  return numbers(child(child(wheel, "geometry"), "radius"))[0] ?? Number.NaN;
}

/**
 * The wheels a chassis declares.
 *
 * `wheels` names the drive wheels and idlers one at a time and the road wheels
 * as a run: a `group` with `template` `W_L`, `startIndex` 0 and `count` 7 means
 * `W_L0` through `W_L6`, all of one radius. Where the track wraps them is kept
 * somewhere else entirely, in the physical track's `wheelGroups`, and falls back
 * to the wheel itself where the vehicle gives none.
 */
export function chassisWheels(node: PackedNode): Record<string, ChassisWheel> {
  const declared = child(node, "wheels");
  if (!declared) return {};
  const radius: Record<string, number> = {};
  for (const wheel of declared.children) {
    const size = wheelRadius(wheel);
    if (!Number.isFinite(size) || size <= 0) continue;
    if (wheel.name === "wheel") {
      const name = String(child(wheel, "name")?.value ?? "").trim();
      if (name) radius[name] = size;
      continue;
    }
    if (wheel.name !== "group") continue;
    const template = String(child(wheel, "template")?.value ?? "").trim();
    const start = numbers(child(wheel, "startIndex"))[0] || 0;
    const count = numbers(child(wheel, "count"))[0] || 0;
    if (!template) continue;
    for (let i = 0; i < count; i++) radius[`${template}${start + i}`] = size;
  }

  const wrap: Record<string, number> = {};
  const groups = (from: PackedNode): void => {
    if (from.name === "wheelGroup") {
      const size = numbers(child(from, "groupRadius"))[0];
      if (Number.isFinite(size) && size > 0) {
        for (const named of from.children.filter((c) => c.name === "wheelName")) {
          const name = String(named.value ?? "").trim();
          if (name && wrap[name] === undefined) wrap[name] = size;
        }
      }
      return;
    }
    for (const c of from.children) groups(c);
  };
  const tracks = child(node, "tracks");
  if (tracks) groups(tracks);

  const seat = chainRadii(node);
  return Object.fromEntries(
    Object.entries(radius).map(([name, size]) => [
      name,
      { name, radius: size, wrap: wrap[name] ?? null, seat: seat[name] ?? null },
    ]),
  );
}

/**
 * The radius the client's own chain gives each wheel, where it overrides one.
 *
 * `physicalTracks > radiusOverrides` is the client telling its chain simulation
 * that a wheel is not the size it is drawn: smaller for a sprocket whose teeth
 * stand through the belt, larger for an idler the belt stands off. It is given
 * in the scale the vehicle is modelled at rather than in the chassis's own,
 * which the FV304 settles: it declares 289 mm road wheels on a mesh spanning
 * 400 and overrides one of them to 393.
 *
 * Empty on the 64 chassis that simulate no chain at all.
 */
function chainRadii(node: PackedNode): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (from: PackedNode): void => {
    if (from.name === "radiusOverrides") {
      for (const wheel of children(from, "wheel")) {
        const name = String(child(wheel, "name")?.value ?? "").trim();
        const size = numbers(child(wheel, "radius"))[0];
        if (name && Number.isFinite(size) && size > 0 && out[name] === undefined) out[name] = size;
      }
      return;
    }
    for (const c of from.children) walk(c);
  };
  const physical = child(node, "physicalTracks");
  if (physical) walk(physical);
  return out;
}

/**
 * Which belt each wheel runs in, as the client numbers them.
 *
 * **Read on its own rather than beside the radius, because the two are not
 * written in the same place.** A `<wheel>` carries its size under `geometry`
 * and a `<group>` carries it directly, so the reader above, which wants a
 * figure it can publish, sees only the groups on a chassis like the AE
 * Phase I's and silently files its four end wheels under belt zero. That put
 * the front sprocket of one belt in with the whole of the other.
 *
 * Empty on the 1,623 chassis declaring one belt, where every wheel is in it.
 */
export function chassisBelts(node: PackedNode): Record<string, number> {
  const declared = child(node, "wheels");
  if (!declared) return {};
  const belts: Record<string, number> = {};
  for (const wheel of declared.children) {
    const pair = numbers(child(wheel, "trackPairIdx"))[0];
    if (!Number.isFinite(pair) || pair === 0) continue;
    if (wheel.name === "wheel") {
      const name = String(child(wheel, "name")?.value ?? "").trim();
      if (name) belts[name] = pair;
      continue;
    }
    if (wheel.name !== "group") continue;
    const template = String(child(wheel, "template")?.value ?? "").trim();
    const start = numbers(child(wheel, "startIndex"))[0] || 0;
    const count = numbers(child(wheel, "count"))[0] || 0;
    if (!template) continue;
    for (let i = 0; i < count; i++) belts[`${template}${start + i}`] = pair;
  }
  return belts;
}

/**
 * How a chassis lays one of its belts, which is not something the geometry says.
 *
 * **The pitch is declared, not measured.** A viewer that spaces links by the
 * link mesh's own length gets it wrong wherever the model overlaps its
 * neighbour or carries a second run: the E 100's mesh is 205 mm long and its
 * belt steps 150.
 *
 * **And a belt is often two runs, not one.** The client names a second segment
 * model and gives each run its own offset along the path, so the E 100 lays
 * `segment2.model` every 300 mm from 144 mm and `segment.model` every 300 mm
 * from 150 mm: alternating models, half a pitch apart, a link every 150.
 */
export type ChassisBelt = {
  /** Which belt this is, as the client numbers them. */
  pair: number;
  /** Metres between two links of one run, as the client declares it. */
  segmentLength: number;
  /** Where the first run starts along the path, in metres. */
  segmentOffset: number;
  /** Where the second run starts, when there is one. */
  segment2Offset: number;
  /** The client's path for each side, which is where the belt runs. */
  left: string | null;
  right: string | null;
  /** The link models, by side, the second being absent on a single-run belt. */
  models: {
    left: string | null;
    right: string | null;
    secondLeft: string | null;
    secondRight: string | null;
  };
};

/** A number the client wrote as text, or null where it wrote nothing. */
function figure(node: PackedNode | undefined): number | null {
  const [only] = numbers(node);
  return typeof only === "number" && Number.isFinite(only) ? only : null;
}

/** A string the client wrote, trimmed, or null where it wrote nothing. */
function text(node: PackedNode | undefined): string | null {
  const value = typeof node?.value === "string" ? node.value.trim() : "";
  return value.length > 0 ? value : null;
}

/**
 * A belt the client simulates as a chain rather than lays along a curve.
 *
 * Two systems ship side by side. `splineDesc` names a path and a link and the
 * game repeats one along the other, which is what most vehicles have. The
 * Swedish destroyers have none of that and a `physicalTracks` block instead:
 * a count of segments, the link they are made of, and the wheels they run on,
 * simulated as a chain on springs. Read the same way here, because what a
 * viewer needs out of either is a link, a pitch and a path.
 */
export type PhysicalTrack = {
  /** How many links go round, which the client counts rather than derives. */
  segments: number;
  /** Metres between two of them. */
  segmentLength: number;
  /** The link model, by client path. */
  model: string | null;
};

/**
 * The wheels a chassis hangs from arms, by the name the wheel is skinned under.
 *
 * **Read from the declaration, not from the arm's geometry.** The arm is only
 * needed to draw one; which wheels ride on the ground rather than on the body
 * is a fact about the vehicle, and two of them (the UDES 15/16, the Object
 * Kust) declare twelve arms while binding no geometry at all to them. Recovered
 * from the geometry alone, those come out with every wheel bolted to the hull,
 * so nothing stays on the ground when the body tips.
 */
export function chassisCarried(node: PackedNode): string[] {
  const suspension = child(node, "leveredSuspension");
  if (!suspension) return [];
  const out: string[] = [];
  for (const lever of suspension.children) {
    if (lever.name !== "lever") continue;
    const start = text(child(lever, "startNode")) ?? text(child(lever, "jointNode"));
    const suffix = start?.replace(/^Lever_(?:Start|Joint)_/, "");
    if (suffix && !out.includes(`W_${suffix}`)) out.push(`W_${suffix}`);
  }
  return out;
}

/** What a chassis says about a belt it simulates, or null where it lays one. */
export function chassisPhysicalTrack(node: PackedNode): PhysicalTrack | null {
  const declared = child(node, "physicalTracks");
  if (!declared) return null;
  const side = child(declared, "left") ?? child(declared, "right") ?? declared;
  const main = child(side, "mainSegment");
  const segments = figure(child(side, "segmentsCount"));
  const segmentLength = figure(child(main, "length"));
  if (!segments || !segmentLength || segmentLength <= 0) return null;
  return { segments, segmentLength, model: text(child(main, "model")) };
}

/**
 * Every belt a chassis lays, in the order the client numbers them.
 *
 * **The client declares one `trackPair` per belt, and 28 chassis declare two.**
 * Each names its own path per side, its own link models and its own phase along
 * the path, so there is nothing here to infer: the AE Phase I writes
 * `track/left.track` at an offset of 271 mm and `track/left2.track` at 311 mm,
 * which is a tank with a belt fore and a belt aft on each side. Reading the
 * first pair alone left the other three belts with the first one's phase and no
 * way for anything downstream to tell which path was which, which is what a
 * viewer then had to guess at.
 *
 * A chassis that writes the fields straight into `splineDesc` with no
 * `trackPair` at all is the ordinary single-belt vehicle, and is read as one
 * pair so that every caller sees the same shape.
 *
 * Returns null where the chassis declares no spline at all, which is a vehicle
 * whose track is simulated as a chain or drawn as a plain ribbon.
 */
export function chassisSpline(node: PackedNode): ChassisBelt[] | null {
  const desc = child(node, "splineDesc");
  if (!desc) return null;
  const declared = children(desc, "trackPair");
  const belts: ChassisBelt[] = [];
  for (const [at, pair] of (declared.length > 0 ? declared : [desc]).entries()) {
    const segmentLength = figure(child(pair, "segmentLength"));
    if (segmentLength === null || segmentLength <= 0) continue;
    belts.push({
      pair: figure(child(pair, "trackPairIdx")) ?? at,
      segmentLength,
      segmentOffset: figure(child(pair, "segmentOffset")) ?? 0,
      segment2Offset: figure(child(pair, "segment2Offset")) ?? 0,
      left: text(child(pair, "left")),
      right: text(child(pair, "right")),
      models: {
        left: text(child(pair, "segmentModelLeft")),
        right: text(child(pair, "segmentModelRight")),
        secondLeft: text(child(pair, "segment2ModelLeft")),
        secondRight: text(child(pair, "segment2ModelRight")),
      },
    });
  }
  return belts.length > 0 ? belts : null;
}

