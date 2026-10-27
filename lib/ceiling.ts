// Where the hull holds a belt down, read off the ribbon the chassis bakes.
//
// **The taut band is the belt's outer limit, not its shape.** A belt pulled
// tight around a row of wheels is the convex hull of their circles, and that is
// what `hugWheels` builds. It is right wherever the wheels are what the belt
// rests on, which is most of the catalogue, and it is wrong wherever something
// else carries the top run: return rollers the chassis never declares as
// wheels, a guide rail along the sponson, the hull roof itself. There the hull
// is above the band and the band goes through it.
//
// The Crusher is the clearest case. It declares two drive wheels, one at each
// end, with their axles at 0.84 and 0.93 and a wrap of 0.53, and ten small road
// wheels along the bottom. The tangent between the two big ones runs at 1.34 to
// 1.42, which is 410 mm over where the belt really goes and 250 mm inside the
// hull plate above it, so the links lie flat on the fender.
//
// **The client says where it really goes, in the one place that cannot be
// argued with: the shape it draws itself.** Every chassis bakes a fixed ribbon
// per side (`track_L_Shape`, `track_LShape`, sometimes split in two), which is
// the belt the game shows past `_PHYSICAL_TRACKS_MAX_DISTANCE`. It cannot be
// drawn up close, since every one of its vertices is bound to a single bone at
// full weight and moving any part of it tears the band open, but its rest shape
// is still the client's own answer. Read as a ceiling over the band, it carries
// the return rollers and the guides without anything having to know they exist.
//
// `physicalTracks > snapWheels` was the other candidate and it is a different
// quantity. It gives the physics chain's attachment per corner, which sits near
// the axles rather than on the belt: on the Crusher it reads 1.05 and 1.16
// against the ribbon's 0.97, and on the Tiger I 0.89 and 0.67 against a ribbon
// that runs 0.92 to 1.18. It disagrees with the drawn shape in both directions,
// so it is not the top run.

/** A wheel as the ceiling sees it: where it turns, and the circle it carries. */
export type CeilingWheel = {
  axle: number[];
  wrap: number;
};

/** How finely the ribbon is sampled across the band it has to hold down. */
const SLICES = 64;

/**
 * How far apart two heights have to be to be two surfaces.
 *
 * A ray up through a belt crosses its outer face, its inner face and the tip
 * of its centre guide, and the two runs of the loop give six of those.
 * Anything closer than this is one face sampled twice across a seam.
 */
const SURFACE = 0.02;

/** How far from a straight line a profile point has to sit to carry shape. */
const SIMPLIFY = 0.004;

/** How close to its own lowest point a band is still running flat. */
const FLAT = 0.03;

/**
 * The heights a ray straight up at (x, z) crosses a set of triangles at.
 *
 * Barycentric, in the ground plane, so a triangle is hit when the query point
 * falls inside its own shadow. **Counting vertices instead does not work**: a
 * long straight top run carries vertices only at its ends, so a profile taken
 * from them reads as a vehicle with no top run modelled at all.
 */
function surfaces(triangles: number[][][], x: number, z: number): number[] {
  const hits: number[] = [];
  for (const [a, b, c] of triangles) {
    const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (Math.abs(d) < 1e-12) continue;
    const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
    const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
    const w = 1 - u - v;
    if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
    hits.push(u * a[1] + v * b[1] + w * c[1]);
  }
  hits.sort((p, q) => p - q);
  const out: number[] = [];
  for (const hit of hits) if (out.length === 0 || hit - out[out.length - 1] > SURFACE) out.push(hit);
  return out;
}

/** The band's own lower and upper edge at a z, where it has one. */
function edgesAt(points: number[][], z: number): { under: number; over: number } {
  let under = Infinity;
  let over = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if ((a[2] - z) * (b[2] - z) > 0) continue;
    const span = b[2] - a[2];
    const at = Math.abs(span) < 1e-9 ? a[1] : a[1] + ((z - a[2]) / span) * (b[1] - a[1]);
    if (at < under) under = at;
    if (at > over) over = at;
  }
  return { under, over };
}

/**
 * How far the belt's outer face stands off the band, read under the bottom run.
 *
 * **Which surface of the ribbon is the belt's inner face cannot be counted
 * off.** A ray up through the top run crosses the guide's tip, the inner face
 * and the outer face, and how many of those it resolves depends on the
 * vehicle: the Pershing answers three heights there, the IS-7 four. Taking the
 * lowest of them reads the guide as the belt and puts the ceiling a hundred
 * millimetres under the rollers the belt plainly rests on, which marks almost
 * the whole catalogue as broken.
 *
 * The outermost surface needs no counting at all, and the bottom run says what
 * to take off it. Down there the band is riding its road wheels and is known
 * to be right (not one published band in the catalogue reaches more than 30 mm
 * under the ground), the guide points up into the loop where it cannot be
 * mistaken for the plate, and the belt's cross section is the same one it has
 * on the way back. So the gap between the band and the lowest surface under it
 * is the offset, and the ceiling is the highest surface less that.
 *
 * Read across the flat stretch only. Around the end wheels the band is on a
 * wrap while the ribbon is leaving it, and the gap there grows by half again,
 * which is ceiling the clip has no business taking.
 *
 * **Refused when it comes out bigger than the smallest wheel the belt runs
 * on**, which says the band's bottom run is not on the ribbon's and the gap is
 * measuring a defect rather than a plate. The FCM 2C is the one vehicle in
 * that state: its band hangs 583 mm clear of the ground where its ribbon sits
 * on it, so the gap reads 426 mm against road wheels of 124, and taken at face
 * value it would have pulled the top run down by another 181. The band is the
 * thing wrong there, and a ceiling read off it would hide that rather than fix
 * it.
 */
export function beltOffset(
  triangles: number[][][],
  band: number[][],
  wheels: CeilingWheel[],
): number | null {
  if (triangles.length === 0 || band.length < 3) return null;
  const x = band[0][0];
  const zs = band.map((point) => point[2]);
  const from = Math.min(...zs);
  const to = Math.max(...zs);
  const floor = Math.min(...band.map((point) => point[1]));
  const gaps: number[] = [];
  for (let i = 0; i <= SLICES; i++) {
    const z = from + ((to - from) * i) / SLICES;
    const { under } = edgesAt(band, z);
    if (!Number.isFinite(under) || under > floor + FLAT) continue;
    const crossed = surfaces(triangles, x, z);
    if (crossed.length < 3) continue;
    gaps.push(under - crossed[0]);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const offset = Math.max(0, gaps[Math.floor(gaps.length / 2)]);
  const smallest = wheels.reduce((least, wheel) => Math.min(least, wheel.wrap), Infinity);
  return offset > smallest ? null : offset;
}

/**
 * Where the ribbon puts the belt's inner face over the span a band covers.
 *
 * Sampled on the band's own plane, which is what separates two belts running
 * one inboard of the other down a single side.
 */
export function ribbonCeiling(
  triangles: number[][][],
  band: number[][],
  wheels: CeilingWheel[],
): number[][] {
  const offset = beltOffset(triangles, band, wheels);
  if (offset === null) return [];
  const x = band[0][0];
  const zs = band.map((point) => point[2]);
  const from = Math.min(...zs);
  const to = Math.max(...zs);
  const read: number[][] = [];
  for (let i = 0; i <= SLICES; i++) {
    const z = from + ((to - from) * i) / SLICES;
    const crossed = surfaces(triangles, x, z);
    if (crossed.length < 3) continue;
    read.push([z, crossed[crossed.length - 1] - offset]);
  }
  if (read.length < 2) return [];
  // A flat top run is two points, and the profile is published rather than
  // recomputed, so the samples that carry no shape go.
  const kept = [read[0]];
  for (let i = 1; i < read.length - 1; i++) {
    const last = kept[kept.length - 1];
    const next = read[i + 1];
    const span = next[0] - last[0];
    const line = span === 0 ? last[1] : last[1] + ((read[i][0] - last[0]) / span) * (next[1] - last[1]);
    if (Math.abs(read[i][1] - line) > SIMPLIFY) kept.push(read[i]);
  }
  kept.push(read[read.length - 1]);
  return kept;
}

/** The profile's own height at a z, or null where it says nothing there. */
function profileAt(profile: number[][], z: number): number | null {
  if (profile.length === 0) return null;
  if (z < profile[0][0] || z > profile[profile.length - 1][0]) return null;
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1];
    const b = profile[i];
    if (z > b[0]) continue;
    const span = b[0] - a[0];
    return span === 0 ? Math.min(a[1], b[1]) : a[1] + ((z - a[0]) / span) * (b[1] - a[1]);
  }
  return profile[profile.length - 1][1];
}

/** The highest any wheel circle reaches at a z, or null where none does. */
function wheelsAt(wheels: CeilingWheel[], z: number): number | null {
  let best: number | null = null;
  for (const wheel of wheels) {
    const gap = Math.abs(z - wheel.axle[2]);
    if (gap >= wheel.wrap) continue;
    const top = wheel.axle[1] + Math.sqrt(wheel.wrap * wheel.wrap - gap * gap);
    if (best === null || top > best) best = top;
  }
  return best;
}

/**
 * Hold a band down to where the ribbon says the belt runs.
 *
 * **Never below a wheel, which is what makes this safe to apply everywhere.**
 * A guide can hold a belt down between its wheels and it cannot pull it inside
 * one, so the ceiling at any z is the higher of the ribbon and the wheel
 * circles there. That is not a guard bolted on: it is the one rule that keeps
 * the wraps intact at both ends, where the ray crosses the end cap rather than
 * a run and the reading is worth nothing. On the Crusher the ribbon reads 0.46
 * straight through the front sprocket, and the sprocket's own circle lifts the
 * ceiling back to 1.37 there, so the band is cut across its flat middle and
 * nowhere else.
 *
 * Applied after `hugWheels` rather than inside it, so a band whose ribbon says
 * nothing comes out of this byte for byte as it went in: three chassis ship no
 * ribbon at all, and most of the catalogue is already under its own.
 */
export function clipToCeiling(
  points: number[][],
  profile: number[][],
  wheels: CeilingWheel[],
): number[][] {
  if (points.length < 3 || profile.length < 2) return points;
  // **Nothing is added above the reading.** The clustering threshold used to be
  // carried here as a margin, on the grounds that a band hovering within a few
  // millimetres of its ribbon crosses it over and over along one straight run
  // and each crossing is a corner the clip then puts in. Measured over the
  // catalogue it bought nothing: with no margin at all the deepest sag between
  // two clipped stretches stays under 5 mm and no run is split into more than
  // five of them. What it cost was visible, since it held the belt a constant
  // 20 mm outside the surface the game draws it against, which on a vehicle
  // whose fender sits right on the belt is a sliver of track over the fender.
  const held = (z: number): number | null => {
    const ribbon = profileAt(profile, z);
    if (ribbon === null) return null;
    const wheel = wheelsAt(wheels, z);
    return wheel !== null && wheel > ribbon ? wheel : ribbon;
  };
  /** How far a point stands over the ceiling, or nothing where there is none. */
  const over = (point: number[]): number => {
    const limit = held(point[2]);
    return limit === null ? 0 : point[1] - limit;
  };
  const x = points[0][0];
  // **A vertex wherever the ribbon changes slope.** An edge of the band can
  // span several of them, and across such an edge the two shapes may cross
  // twice, which a test taken at the ends alone reads as no crossing at all.
  // Subdivided first, every edge spans one straight stretch of ribbon and the
  // single crossing the clip below solves for is the only one there is.
  // The breaks go into every edge rather than into the top run alone: the ones
  // that land on the bottom run are collinear and carry nothing, and telling
  // the two runs apart before the clip has run is the question being answered.
  const breaks = profile.slice(1, -1).map(([z]) => z);
  const dense: number[][] = [];
  for (let i = 0; i < points.length; i++) {
    const here = points[i];
    const next = points[(i + 1) % points.length];
    dense.push(here);
    const span = next[2] - here[2];
    if (span === 0) continue;
    const inside = breaks
      .filter((z) => (z - here[2]) * (z - next[2]) < 0)
      .sort((a, b) => (span > 0 ? a - b : b - a));
    for (const z of inside) {
      const t = (z - here[2]) / span;
      dense.push([x, here[1] + (next[1] - here[1]) * t, z]);
    }
  }
  // **Tested after the subdivision, never before it.** A taut band carries a
  // vertex only where it touches a wheel, so a straight top run spanning the
  // whole vehicle is two points, both of them sitting on an end wheel where
  // the ceiling is high too. Asked of those two alone, a band running 400 mm
  // over the middle of its own ribbon answers that nothing is over anything.
  // The original points go back untouched, so a band already under its ribbon
  // comes out of this byte for byte as it went in.
  if (!dense.some((point) => over(point) > 0)) return points;

  const out: number[][] = [];
  const keep = (point: number[]) => {
    const last = out[out.length - 1];
    if (last && Math.hypot(point[2] - last[2], point[1] - last[1]) < 0.002) return;
    out.push(point);
  };
  /** Where the ceiling crosses the segment between two points. */
  const crossing = (a: number[], b: number[]): number[] => {
    const from = over(a);
    const to = over(b);
    const span = from - to;
    // Clamped, because `held` carries a wheel's arc as well as the ribbon's
    // straight stretches and an arc is not linear along an edge.
    const t = Math.abs(span) < 1e-9 ? 0 : Math.max(0, Math.min(1, from / span));
    const z = a[2] + (b[2] - a[2]) * t;
    const limit = held(z);
    return [x, limit ?? a[1] + (b[1] - a[1]) * t, z];
  };
  for (let i = 0; i < dense.length; i++) {
    const here = dense[i];
    const next = dense[(i + 1) % dense.length];
    const standing = over(here) > 0;
    const rising = over(next) > 0;
    // A point under the ceiling is the band's own, and nothing above it
    // survives: a belt cannot hang from a guide, only rest under it.
    // A point over the ceiling is pulled down onto it rather than dropped: the
    // subdivision above already put a vertex at every corner the ribbon turns
    // at, so pulling each one down reproduces the ribbon's own shape and keeps
    // the band's spacing along the rest of the loop.
    keep(standing ? [x, here[1] - over(here), here[2]] : here);
    // And the corner where the two shapes meet, which neither of them carries:
    // without it the belt cuts a chord from the last point under the ceiling
    // straight to the first one on it.
    if (standing !== rising) keep(crossing(here, next));
  }
  if (
    out.length > 2 &&
    Math.hypot(out[0][2] - out[out.length - 1][2], out[0][1] - out[out.length - 1][1]) < 0.002
  )
    out.pop();
  return out.length >= 3 ? out : points;
}

/** What the client calls the fixed band it bakes into a chassis. */
const RIBBON = /^track_/i;

/**
 * The ribbon's own triangles out of one render set, by the side they are on.
 *
 * Named `track_L_Shape`, `track_LShape`, or either of those with a `_split_N`
 * where the exporter had to cut the mesh in two, so the name says which side
 * only by convention. **Taken from the coordinates instead**, which is the rule
 * the belt's own link already follows: X is the axis the mirror negates and the
 * client's left and right live on it, so a side read off the geometry cannot be
 * wrong where a name could.
 */
export function ribbonOf(
  label: string,
  positions: number[],
  indices: number[],
): { side: string; triangles: number[][][] } | null {
  if (!RIBBON.test(label) || indices.length < 3 || positions.length < 9) return null;
  const at = (i: number) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  let sum = 0;
  for (let i = 0; i * 3 < positions.length; i++) sum += positions[i * 3];
  const triangles: number[][][] = [];
  for (let i = 0; i + 2 < indices.length; i += 3)
    triangles.push([at(indices[i]), at(indices[i + 1]), at(indices[i + 2])]);
  return { side: sum >= 0 ? "left" : "right", triangles };
}
