// Which runs a chassis lays, and which wheels each one goes round.
//
// **A path is not a belt.** The client authors a run per side and the wheels
// move underneath it, so the published belt is the two put together: the path
// pulled onto the wheels it actually rides, held down to where the chassis's
// own ribbon says the hull carries it, or, for a chassis that ships no path at
// all, the taut band those wheels leave a chain no choice but to settle into.
import { beltAround, hugWheels, mirrorPath } from "./track.js";
import { beltOffset, clipToCeiling, ribbonCeiling } from "./ceiling.js";
import type { ChassisBelt, PhysicalTrack } from "./chassis.js";
import type { Wheel } from "./wheels.js";

/**
 * How far a wheel may sit from a run's plane and still be turning inside it.
 *
 * A belt runs in a plane, so the wheels it carries are the ones in that plane.
 * Measured: a vehicle that really runs two belts down one side spaces them
 * well apart, the FV4025 Contriver's two lines sitting 780 mm from each other
 * and the Object 279 (e)'s 1,010 mm, against a spread of 130 mm at the widest
 * within any one line. Four tenths of a metre is three times the one and half
 * the other, and it separates the two sides of any vehicle outright.
 */
const SAME_PLANE = 0.4;

/**
 * How far outside its own wrap a wheel may sit for a run to be running on it.
 *
 * **This matches a path to a belt, it never decides what a belt carries.** The
 * client says what a belt carries, by numbering every wheel with the belt it
 * belongs to, and only the 28 chassis declaring more than one belt have
 * anything to match: a vehicle with one belt a side never reaches this.
 *
 * That is what lets it be strict. The authored loop is coarse and cuts
 * corners, so a wheel a belt really carries can sit well outside it, the
 * MBT-B's rear idler at 1.71 wraps from its own path; but a run only has to
 * touch one wheel of a group to claim it. Measured on the AE Phase I, whose
 * four runs share a plane and meet in the middle of the tank, 1.3 reproduces
 * the client's own numbering exactly on all four, where anything looser has
 * each run reaching past the turn into the belt opposite.
 */
const ON_BELT = 1.3;

/** One run as it was laid, beside the belt the chassis declared it under. */
export type LaidRun = {
  /** The closed path in the vehicle's space, in metres. */
  points: number[][];
  /** What the chassis says this run lays, where it named it. */
  belt?: ChassisBelt;
  /** The wheels it runs around, by bone, which is not every wheel on its side. */
  wheels: string[];
  /** Where the hull holds it down, where its own ribbon says anything. */
  ceiling?: number[][];
  /** How far the belt's outer face stands outside the band it is laid on. */
  standoff?: number;
};

/** Closest a run passes to a wheel's axle, read in the side view. */
function reach(points: number[][], wheel: Wheel): number {
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ez = b[2] - a[2];
    const ey = b[1] - a[1];
    const span = ez * ez + ey * ey;
    const along = span > 0 ? ((wheel.axle[2] - a[2]) * ez + (wheel.axle[1] - a[1]) * ey) / span : 0;
    const t = Math.max(0, Math.min(1, along));
    const gap = Math.hypot(wheel.axle[2] - (a[2] + t * ez), wheel.axle[1] - (a[1] + t * ey));
    if (gap < best) best = gap;
  }
  return best;
}

/** The wheels a run is close enough to be running on, in its own plane. */
function touching(points: number[][], wheels: Wheel[]): Wheel[] {
  return wheels.filter(
    (wheel) =>
      Math.abs(wheel.axle[0] - points[0][0]) < SAME_PLANE &&
      reach(points, wheel) < wheel.wrap * ON_BELT,
  );
}

/**
 * The wheels one run is fitted to, which is not every wheel on its side.
 *
 * **This is the whole of what was wrong with a four-belt tank.** Fitted to the
 * side, a belt covering the front half of the vehicle was stretched over the
 * rear half as well, so the AE Phase I's two belts a side came out as two
 * full-length ones lying on top of each other, reading as one. Its own chassis
 * mesh says otherwise outright: the baked ribbon's top run descends from 1.27 m
 * at each end to 0.77 in the middle, where the two belts turn back on
 * themselves, and that is the shape these wheels give.
 *
 * **The grouping is the client's and only the matching is ours.** Every wheel
 * is numbered with the belt it belongs to, so a run takes whole groups rather
 * than whichever wheels it happens to pass near: touching one wheel of a group
 * claims all of it. That is what keeps a coarse path from losing the idler it
 * cuts the corner at, and what makes a vehicle with one group come out of this
 * fitted to its whole side exactly as it was before.
 */
function ridden(points: number[][], wheels: Wheel[], near: Wheel[]): Wheel[] {
  const groups = new Set(near.map((wheel) => wheel.pair ?? 0));
  return wheels.filter(
    (wheel) =>
      Math.abs(wheel.axle[0] - points[0][0]) < SAME_PLANE &&
      groups.has(wheel.pair ?? 0),
  );
}

/**
 * Where a belt hangs, per side, from the paths the chassis authored.
 *
 * Lifted out of `beltOf` because it answers on its own, and because a vehicle
 * that has to borrow its link still lays it along paths of its own: publishing
 * the donor's instead moved the Churchill St. Gloriana's belt 74 mm back from
 * the front of its own wheels.
 */
export function layPaths({
  paths,
  belts,
  chain,
  wheels,
  ribbons,
}: {
  /** The runs the chassis authored, by the file each came from. */
  paths: Record<string, number[][]>;
  /** What the chassis declares, so a run keeps the phase it was given. */
  belts?: ChassisBelt[] | null;
  chain: PhysicalTrack | null;
  /** The wheels as they came out, which is what a belt is fitted to. */
  wheels: Wheel[];
  /** The fixed band the chassis bakes, by side, where it was read. */
  ribbons?: Record<string, number[][][]> | null;
}): Record<string, LaidRun> {
  // Most vehicles ship a path per side, but a symmetrical one ships a single
  // file and expects the other side to be its mirror.
  const laidOut: Record<string, number[][]> = { ...paths };
  // A chassis that chains its belt ships no path to lay it along, so the
  // wheels are the only thing that says where it goes. What a chain pulled
  // tight around them settles into is the taut band, and the client agrees:
  // the band round the Strv 103B's eight wheels is 11.18 m, which at the
  // 132.7 mm link it declares is 84.2 links against the 86 it counts, the
  // couple of links of slack a real chain carries over its return rollers.
  if (Object.keys(laidOut).length === 0 && chain) {
    for (const sign of [1, -1]) {
      const side = wheels.filter((wheel) => Math.sign(wheel.axle[0]) === sign);
      if (side.length < 2) continue;
      // The belt rides on the road wheels, so their plane is its plane.
      const widest = side.reduce((big, wheel) => (wheel.wrap > big.wrap ? wheel : big));
      const band = beltAround(
        side.map((wheel) => ({ axle: wheel.axle, wrap: wheel.wrap })),
        widest.axle[0],
      );
      if (band.length >= 3) laidOut[sign > 0 ? "left" : "right"] = band;
    }
  }
  const sides = Object.keys(laidOut);
  if (sides.length === 1) {
    const other = sides[0] === "left" ? "right" : "left";
    laidOut[other] = mirrorPath({ points: laidOut[sides[0]] }).points;
  }

  // Which declared belt each run came out of, so it keeps its own link and its
  // own phase. Matched on the file the chassis named, which is the same name
  // the conversion filed the run under.
  const declared = new Map<string, ChassisBelt>();
  for (const belt of belts ?? [])
    for (const at of [belt.left, belt.right]) {
      const file = at?.split("/").pop()?.replace(/\.track$/i, "");
      if (file) declared.set(file, belt);
    }

  const runs = Object.entries(laidOut)
    .filter(([, points]) => points.length >= 3)
    .map(([file, points]) => {
      const near = touching(points, wheels);
      return {
        file,
        points,
        belt: declared.get(file),
        near,
        band: ridden(points, wheels, near),
      };
    });

  // **Two runs round the same wheels are one belt written twice.** The Steel
  // Hunter vehicles grow their running gear during a battle, so their chassis
  // authors both states: a short belt over the front wheels and the full one
  // that replaces it, the second carrying every wheel the first does. Laid as
  // published, the short one is drawn on top of the long one and the front of
  // the tank wears two tracks. The vehicle is shown fully upgraded everywhere
  // else on the page, so the belt that carries the whole chassis is the one
  // that stays, and the chassis's own ribbon agrees: the M V Y's is a single
  // loop running the length of the wheelbase.
  //
  // Judged on the wheels a run really passes rather than on the groups it
  // claimed, so a run holding one wheel of its own is never dropped: the AE
  // Phase I's two runs a side share none at all, and a vehicle whose paths
  // meet closer than that keeps both belts rather than losing one to a
  // mismatch.
  //
  // A run carrying no wheel at all is kept rather than dropped, since nothing
  // has been established about it: the vehicles with no chassis to declare any
  // would otherwise come out with one belt where they publish two.
  const drawn = runs.filter(
    (run, at) =>
      run.near.length === 0 ||
      !runs.some(
        (other, index) =>
          index !== at &&
          run.near.every((wheel) => other.near.includes(wheel)) &&
          (other.near.length > run.near.length || index < at),
      ),
  );

  // Name each belt for the side it is actually on, which the coordinates say
  // and the file name only claims. Measured, the two agree: X is the axis the
  // mirror negates and the client's left-and-right lives on it, so a path it
  // calls left comes out at positive x beside the wheels it calls `W_L0`.
  // Taken from the geometry all the same, because the link laid on each side
  // is chosen by this label and a belt fitted backwards is not a small defect.
  //
  // **A side can carry more than one belt**, and the client says so by
  // declaring a `trackPair` per belt. 28 chassis do: the AE Phase I and the
  // ST-66 wear one fore and one aft, the FV4025 Contriver and the Object
  // 279 (e) wear one inboard and one outboard. The innermost of a side keeps
  // the bare name, so every two-belt vehicle in the catalogue is published
  // exactly as it was and a rebuild touches only the handful that have more.
  //
  // Ordered by the client's own numbering first and by distance from the
  // centreline second: the Contriver's two belts are told apart by where they
  // sit, and the AE Phase I's are 0.3 mm apart in x, which is no ordering at
  // all.
  const perSide: Record<string, typeof drawn> = { left: [], right: [] };
  for (const run of drawn) perSide[run.points[0][0] >= 0 ? "left" : "right"].push(run);
  const sided: Record<string, LaidRun> = {};
  for (const [side, held] of Object.entries(perSide)) {
    held.sort(
      (a, b) =>
        (a.belt?.pair ?? 0) - (b.belt?.pair ?? 0) ||
        Math.abs(a.points[0][0]) - Math.abs(b.points[0][0]),
    );
    for (const [at, run] of held.entries()) {
      // A run that carries no wheel is fitted to its whole side, which is what
      // every belt was fitted to before the wheels were read per run.
      const band =
        run.band.length > 0
          ? run.band
          : wheels.filter(
              (wheel) => Math.sign(wheel.axle[0]) === Math.sign(run.points[0][0]),
            );
      // **The band first, then the hull above it.** The taut band is where a
      // belt pulled round these wheels has to pass, and it is the whole answer
      // only while the wheels are what carries it. Where something else does,
      // the chassis's own ribbon says so and the band is held down to it; see
      // `ceiling.ts`. Measured per run rather than per side, on the run's own
      // plane, so a side carrying one belt inboard of another holds each to
      // the ribbon it really runs under.
      const hugged = hugWheels(run.points, band);
      const seats = band.map((wheel) => ({ axle: wheel.axle, wrap: wheel.wrap }));
      const triangles = ribbons?.[hugged[0][0] >= 0 ? "left" : "right"] ?? [];
      // **Measured against the band a READER builds, not against this path.**
      // A ceiling is a height, so it only means anything beside a band in the
      // same convention, and the two are not. `hugWheels` seats the path a
      // little inside the wheels, because the published loop is the line a
      // link's own origin travels and the modeller put that origin inside the
      // link's inner face. A reader rebuilding the band when the suspension
      // moves has no such path to take that from and uses the wrap circles
      // themselves, so the band it draws sits that much further out all the
      // way round. Published in its convention, since it is the band that ends
      // up on screen, and brought back into this one below.
      const reading = beltAround(seats, hugged[0][0]);
      const readable = triangles.length > 0 && reading.length >= 3;
      const ceiling = readable ? ribbonCeiling(triangles, reading, seats) : [];
      const held = ceiling.length >= 2;
      // **How far the belt's own body stands outside that band**, which a
      // reader cannot work out and has to be told. A link model is laid with
      // its origin on the band, and the modeller put that origin at the tip of
      // the centre guide rather than on the face that seats on a wheel, so a
      // reader doing the obvious thing draws the whole belt a guide's height
      // too far out: 86 mm for the median vehicle, 192 at the worst. Measured
      // off the ribbon under the flat bottom run, which is where the band is
      // known to be right and the belt's section is the one it has on the way
      // back, so the same figure holds all the way round the loop.
      const standoff = readable ? beltOffset(triangles, reading, seats) : null;
      // What the seating took off, which is the same figure everywhere round
      // the loop, so the lowest point of each says it.
      const inset =
        Math.min(...hugged.map((point) => point[1])) -
        Math.min(...reading.map((point) => point[1]));
      sided[at === 0 ? side : `${side}${at}`] = {
        points: held
          ? clipToCeiling(
              hugged,
              ceiling.map(([z, y]) => [z, y - inset]),
              seats,
            )
          : hugged,
        belt: run.belt,
        wheels: run.band.map((wheel) => wheel.bone),
        ...(held ? { ceiling } : {}),
        ...(standoff !== null ? { standoff } : {}),
      };
    }
  }
  return sided;
}
