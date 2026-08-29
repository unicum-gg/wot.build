// Reading a vehicle's track path.
//
// The game does not draw a track as one fixed ribbon. It ships the closed curve
// the belt follows around the road wheels and a single link, and lays copies of
// that link along the curve, sliding them as the vehicle moves. The ribbon that
// also ships is the cheap stand-in, which is what a viewer ends up drawing if it
// never looks for this file.
//
// The curve is a COLLADA scene, packed the same way the client packs its XML,
// exported from 3ds Max in centimetres. Its nodes are the path's points, already
// in order around the loop, each holding a four-by-four matrix whose translation
// is all we need.
import { decodePacked, isPacked, type PackedNode } from "./packed.js";
import { child } from "./read.js";

/** Where a vehicle keeps its track path and the link laid along it. */
export const TRACK_GLOB = "vehicles/*/*/track/*";

export type TrackPath = {
  /** Points around the closed loop, in metres, in order. */
  points: number[][];
};


function numbers(node: PackedNode | undefined): number[] {
  if (!node) return [];
  if (Array.isArray(node.value)) return node.value as number[];
  if (typeof node.value === "string") {
    return node.value.trim().split(/\s+/).map(Number).filter((n) => !Number.isNaN(n));
  }
  return [];
}

/** Metres per unit, which the exporter records rather than assuming. */
function scale(root: PackedNode): number {
  const meter = child(child(child(root, "asset") ?? root, "unit") ?? root, "meter");
  const value = typeof meter?.value === "number" ? meter.value : Number(meter?.value);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * A node's own transform, as a three-by-three basis and a translation.
 *
 * COLLADA writes a four-by-four in row-major order, so the translation is the
 * fourth column, read at 3, 7 and 11.
 */
function transformOf(node: PackedNode): { basis: number[]; offset: number[] } | null {
  const m = numbers(child(node, "matrix"));
  if (m.length !== 16) return null;
  return { basis: [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]], offset: [m[3], m[7], m[11]] };
}

/** Apply a transform to a point, the basis being row-major. */
function apply(t: { basis: number[]; offset: number[] }, p: number[]): number[] {
  return [0, 1, 2].map((r) => t.basis[r * 3] * p[0] + t.basis[r * 3 + 1] * p[1] + t.basis[r * 3 + 2] * p[2] + t.offset[r]);
}

/**
 * The path a track follows, or null when the file is not one.
 *
 * The points hang off a single root node, and the client writes them in the
 * order they run around the loop, so they are taken as they come.
 */
export function readTrackPath(buf: Buffer): TrackPath | null {
  if (!isPacked(buf)) return null;
  const root = decodePacked(buf);
  const scene = child(root, "library_visual_scenes")?.children.find((c) => c.name === "visual_scene");
  if (!scene) return null;

  const metres = scale(root);
  const points: number[][] = [];

  // A point's transform is relative to whatever node it hangs under, and the
  // exporter nests them differently from one vehicle to the next. Reading the
  // raw translation works only where the parents happen to sit at the origin,
  // and puts a track four metres in the air where they do not.
  const walk = (node: PackedNode, parent: { basis: number[]; offset: number[] }): void => {
    const own = transformOf(node);
    const here = own
      ? {
          basis: [0, 1, 2].flatMap((r) => apply({ basis: parent.basis, offset: [0, 0, 0] }, own.basis.slice(r * 3, r * 3 + 3))),
          offset: apply(parent, own.offset),
        }
      : parent;
    const children = node.children.filter((c) => c.name === "node");
    // Only a leaf is a point on the path; the nodes above it are grouping.
    //
    // **There are two dialects and a vehicle ships one or the other.** The one
    // above is COLLADA proper, a four-by-four per point in the unit the file's
    // own `asset` block declares, which is centimetres. The other writes a bare
    // `position` triple already in metres and carries no `asset` at all, so the
    // scale falls back to one on its own. The Maus, the ST-B1 and the Strv 103B
    // are all in the second, and reading only the first left them with a track
    // and no path, which the viewer answers by drawing a plain ribbon.
    const bare = children.length === 0 && !own ? numbers(child(node, "position")) : [];
    if (children.length === 0 && own) points.push(here.offset.map((v) => v * metres));
    else if (bare.length === 3) points.push(apply(parent, bare));
    for (const c of children) walk(c, here);
  };

  const identity = { basis: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] };
  for (const node of scene.children.filter((c) => c.name === "node")) walk(node, identity);

  // Flipped across the centreline with everything else, so a path published as
  // the left one still runs down the vehicle's left side.
  //
  // Mirroring on X touches neither the height nor the length of the loop, so it
  // does not decide which way round the belt runs.
  for (const p of points) p[0] = -p[0];
  if (points.length < 3) return null;

  // **Which way the loop runs is not agreed between files, so it is measured.**
  // A link is laid facing along the path, so a loop written the other way round
  // turns every one of them over and rides the centre guides on the outside.
  // Counted across the client's own paths, 96 of the COLLADA ones run one way
  // and 1 the other, and all 16 of the `position` ones run against them, which
  // is a rule the exporter clearly never held itself to. The shoelace area in
  // the side view says it outright, so the file is normalised rather than
  // trusted, and a dialect nobody has seen yet arrives already the right way up.
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += a[2] * b[1] - b[2] * a[1];
  }
  if (area < 0) points.reverse();
  return { points };
}

/** Mirror a path to the other side of the vehicle. */
export function mirrorPath(path: TrackPath): TrackPath {
  return { points: path.points.map(([x, y, z]) => [-x, y, z]) };
}

/** A wheel the belt has to run around, in the space the path is published in. */
export type BeltWheel = {
  /** Where it turns, as a point on the path's own plane. */
  axle: number[];
  /** The circle the belt runs on around it, which is not always its rim. */
  wrap: number;
};

/** How finely each wheel is sampled when the taut band is built. */
const WHEEL_SAMPLES = 96;

/** The two-dimensional convex hull of a set of points, anticlockwise in (z, y). */
function hull(points: number[][]): number[][] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (from: number[][]): number[][] => {
    const out: number[][] = [];
    for (const p of from) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/**
 * The taut band a belt makes around a set of wheels.
 *
 * A belt pulled tight around a row of pulleys is the convex hull of their
 * circles: an arc where it wraps a wheel, a straight tangent where it spans two.
 * Sampling each circle and hulling the samples gets there without a case for
 * every way two wheels of different sizes can sit, and a wheel that contributes
 * nothing (a road wheel in the middle of a straight run) simply drops out.
 */
function tautBand(wheels: BeltWheel[]): number[][] {
  const samples: number[][] = [];
  for (const wheel of wheels) {
    for (let i = 0; i < WHEEL_SAMPLES; i++) {
      const at = (i / WHEEL_SAMPLES) * Math.PI * 2;
      samples.push([wheel.axle[2] + Math.cos(at) * wheel.wrap, wheel.axle[1] + Math.sin(at) * wheel.wrap]);
    }
  }
  return hull(samples);
}

/**
 * How far inside its wheels the client draws this belt.
 *
 * `groupRadius` is where the track *touches* a wheel, and the path is the line
 * the link's own origin travels, which sits inside that by however far the
 * modeller put the origin from the link's inner face. The client never says by
 * how much, but the path itself does: on the wheels it draws well, the gap is
 * the same one everywhere. Taking the middle value ignores the wheel it draws
 * badly, which is the whole point of doing this.
 *
 * Never positive: the band this feeds is a floor under the path, and letting it
 * grow past the wheels would push a belt that was already fine outwards.
 */
function inset(points: number[][], wheels: BeltWheel[]): number {
  const gaps: number[] = [];
  for (const wheel of wheels) {
    let closest = Infinity;
    for (const p of points) {
      const d = Math.hypot(p[2] - wheel.axle[2], p[1] - wheel.axle[1]);
      if (d < closest) closest = d;
    }
    if (closest < wheel.wrap * 1.3) gaps.push(closest - wheel.wrap);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return Math.min(0, gaps[Math.floor(gaps.length / 2)]);
}

/**
 * Lift a track path out of the wheels it is supposed to run around.
 *
 * The path the client ships is a coarse hand-placed loop, a few dozen points for
 * the whole belt, and it is only ever as good as it needed to look. On the IS-7
 * it runs true around the drive sprocket and then cuts the corner at the idler
 * by 100 mm, which puts the idler through the front of the track: the wheel
 * reads as sitting too far forward, out of its own belt. The wheels are not
 * wrong there, the path is.
 *
 * A belt cannot pass inside the band its wheels pull it into, so any point that
 * has is moved straight out onto that band, and the corners of the band the path
 * had skipped past are put back. Points already outside are left exactly as they
 * are, which is what keeps the top run where the client put it: it rides high on
 * the track guards, well clear of any wheel, and no wheel has a say in it.
 */
export function hugWheels(points: number[][], wheels: BeltWheel[]): number[][] {
  if (wheels.length === 0 || points.length < 3) return points;
  const slack = inset(points, wheels);
  const band = tautBand(wheels.map((wheel) => ({ ...wheel, wrap: Math.max(wheel.wrap * 0.5, wheel.wrap + slack) })));
  if (band.length < 3) return points;

  const centre = [
    wheels.reduce((sum, w) => sum + w.axle[2], 0) / wheels.length,
    wheels.reduce((sum, w) => sum + w.axle[1], 0) / wheels.length,
  ];
  const angleOf = (z: number, y: number) => Math.atan2(y - centre[1], z - centre[0]);
  const corners = band
    .map((p) => ({ point: p, at: angleOf(p[0], p[1]) }))
    .sort((a, b) => a.at - b.at);

  // The band is convex and the middle of the wheels is inside it, so a point is
  // outside whenever it is on the outer side of any one of its edges.
  const outside = (z: number, y: number): boolean => {
    for (let i = 0; i < band.length; i++) {
      const a = band[i];
      const b = band[(i + 1) % band.length];
      if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (z - a[0]) < 0) return true;
    }
    return false;
  };

  /**
   * Where the band sits straight out from the middle, at this angle.
   *
   * The middle of the wheels is inside a convex band, so the ray leaves it
   * across exactly one edge. Solving `centre + t·direction = a + u·edge` gives
   * both how far out that is and whether it happened within the edge's ends.
   */
  const bandAt = (at: number): number[] => {
    const dz = Math.cos(at);
    const dy = Math.sin(at);
    let reach = 0;
    for (let i = 0; i < band.length; i++) {
      const a = band[i];
      const b = band[(i + 1) % band.length];
      const ez = b[0] - a[0];
      const ey = b[1] - a[1];
      const determinant = ez * dy - dz * ey;
      if (Math.abs(determinant) < 1e-12) continue;
      const offZ = a[0] - centre[0];
      const offY = a[1] - centre[1];
      const along = (dz * offY - dy * offZ) / determinant;
      if (along < -1e-9 || along > 1 + 1e-9) continue;
      const t = (ez * offY - ey * offZ) / determinant;
      if (t > reach) reach = t;
    }
    return [centre[0] + dz * reach, centre[1] + dy * reach];
  };

  // Two points that both had to be lifted are two points of one arc, and a
  // straight line between them cuts across it, so the band's own corners go in
  // between. Only between two lifted points: a point the path put outside the
  // band is a point the band has nothing to say about, and threading corners up
  // to it is what put a spike in the loop and made links jump as they slid past.
  const lifted = points.map((point) => {
    if (outside(point[2], point[1])) return { point, at: 0, on: false };
    const at = angleOf(point[2], point[1]);
    const seat = bandAt(at);
    return { point: [point[0], seat[1], seat[0]], at, on: true };
  });

  const out: number[][] = [];
  const keep = (point: number[]) => {
    const last = out[out.length - 1];
    // Points a fraction of a millimetre apart are a curve's undoing: they carry
    // no shape and they wreck the arc-length spacing that keeps links even.
    if (last && Math.hypot(point[2] - last[2], point[1] - last[1]) < 0.002) return;
    out.push(point);
  };
  for (let i = 0; i < lifted.length; i++) {
    const here = lifted[i];
    const next = lifted[(i + 1) % lifted.length];
    keep(here.point);
    if (!here.on || !next.on) continue;
    let sweep = next.at - here.at;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    const between = corners
      .map((corner) => {
        let step = corner.at - here.at;
        while (step > Math.PI) step -= Math.PI * 2;
        while (step < -Math.PI) step += Math.PI * 2;
        return { corner, step };
      })
      .filter(({ step }) => (sweep > 0 ? step > 0 && step < sweep : step < 0 && step > sweep))
      .sort((a, b) => (sweep > 0 ? a.step - b.step : b.step - a.step));
    for (const { corner } of between) keep([here.point[0], corner.point[1], corner.point[0]]);
  }
  // The loop closes on itself, so the join needs the same guard the rest had.
  if (out.length > 2 && Math.hypot(out[0][2] - out[out.length - 1][2], out[0][1] - out[out.length - 1][1]) < 0.002) out.pop();
  return out;
}
