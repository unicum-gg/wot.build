// The belt a chassis wears, and which link goes on which side of it.
//
// **A path is not a belt.** The client authors a run per side and the wheels
// move underneath it, so the published belt is the two put together: the path
// pulled onto the wheels it actually rides, or, for a chassis that ships none,
// the taut band those wheels leave a chain no choice but to settle into.
//
// The side a link belongs on is read off the coordinates rather than off the
// file's own name. The client's `left` does survive the mirror, since X is the
// axis the flip negates and its left-and-right lives there, but a link fitted
// to the wrong side is exactly the defect this exists to prevent, and the
// coordinates cannot be wrong about it.
import { beltAround, hugWheels, mirrorPath, type BeltWheel } from "./track.js";
import { TRACK_SEGMENT, trackSegment } from "./model.js";
import type { ChassisSpline, PhysicalTrack } from "./chassis.js";
import type { Piece, Tracks } from "./model.js";
import type { Wheel } from "./wheels.js";

/** What the manifest says about the belt, or nothing where there is none. */
export function beltOf({
  pieces,
  paths,
  spline,
  chain,
  wheels,
}: {
  pieces: Record<string, Piece>;
  /** The runs the chassis authored, by the file each came from. */
  paths: Record<string, number[][]>;
  spline: ChassisSpline | null;
  chain: PhysicalTrack | null;
  /** The wheels as they came out, which is what a belt is fitted to. */
  wheels: Wheel[];
}): Tracks | undefined {
  // Which piece each run lays. The chassis names its models by path, so the
  // file's own name is what ties its declaration to what was converted.
  const named = (at: string | null | undefined) => {
    if (!at) return undefined;
    const file = at.split("/").pop()?.replace(/\.model$/i, "") ?? "";
    const piece = trackSegment(file);
    return pieces[piece] ? piece : undefined;
  };
  const laid = Object.keys(pieces).filter((name) =>
    name.startsWith(`${TRACK_SEGMENT}_`),
  );
  // **A shoe plate is not symmetric, so the two sides are not one model.** The
  // chassis names a link per side and 58 vehicles name two different files,
  // the Tiger I and the T29 among them. Measured on the Tiger's pair, one is
  // the other mirrored in x to the vertex, so laying the left link down both
  // sides reads as a track fitted backwards on one of them. Only published
  // where the two differ, so the 909 vehicles that really do use one link
  // carry nothing extra.
  //
  // **Which side a link is on is read off its own path, not off its name.**
  // The client's `left` survives the mirror by design, since X is the axis the
  // flip negates and its left-and-right lives there: its `W_L0` comes out at
  // positive x and the path it calls left comes out beside it. That is worth
  // deriving rather than trusting, because a link put on the wrong side is
  // exactly the defect this is here to fix, and the coordinates cannot be
  // wrong about it.
  const sideOfPath = (at: string | null | undefined) => {
    const file = at?.split("/").pop()?.replace(/\.track$/i, "");
    const start = file ? paths[file]?.[0] : undefined;
    return start ? (start[0]! >= 0 ? "left" : "right") : undefined;
  };
  const clientLeftIsRight = sideOfPath(spline?.left) === "right";
  const models = spline?.models;
  const firstRight = named(clientLeftIsRight ? models?.left : models?.right);
  const secondRight = named(
    clientLeftIsRight ? models?.secondLeft : models?.secondRight,
  );
  // A chained belt names its own link, and naming it matters: the ST-B1 ships
  // two in the same folder, so taking whatever was converted first is a coin
  // toss. Falling back to that still keeps a vehicle drawing the one link it
  // does ship when nothing named it.
  const first =
    named(clientLeftIsRight ? models?.right : models?.left) ??
    named(chain?.model) ??
    laid[0];
  const second = named(
    clientLeftIsRight ? models?.secondRight : models?.secondLeft,
  );
  const segment = first ? pieces[first] : undefined;
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
  // A belt runs around the wheels on its own side, told apart by which side of
  // the tank they sit on rather than by their names, which the client keeps
  // from before the mirror.
  for (const [side, points] of Object.entries(laidOut)) {
    if (points.length === 0) continue;
    const band: BeltWheel[] = wheels
      .filter((wheel) => Math.sign(wheel.axle[0]) === Math.sign(points[0][0]))
      .map((wheel) => ({ axle: wheel.axle, wrap: wheel.wrap }));
    laidOut[side] = hugWheels(points, band);
  }

  // Name each belt for the side it is actually on, which the coordinates say
  // and the file name only claims. Measured, the two agree: X is the axis the
  // mirror negates and the client's left-and-right lives on it, so a path it
  // calls left comes out at positive x beside the wheels it calls `W_L0`.
  // Taken from the geometry all the same, because the link laid on each side
  // is chosen by this label and a belt fitted backwards is not a small defect.
  const sided: Record<string, number[][]> = {};
  for (const [side, points] of Object.entries(laidOut)) {
    sided[points[0]?.[0] >= 0 ? "left" : "right"] = points;
  }
  return (
    segment && first && Object.keys(sided).length > 0
      ? {
          segment: first,
          ...(firstRight && firstRight !== first ? { segmentRight: firstRight } : {}),
          ...(second ? { segment2: second } : {}),
          ...(secondRight && secondRight !== second ? { segment2Right: secondRight } : {}),
          // A chained belt says how many links go round, which is the one
          // thing a path cannot: laying that many evenly closes the loop with
          // no part link at the join, and carries the slack a real chain has
          // over its rollers without having to model the sag.
          ...(!spline && chain
            ? { segmentLength: chain.segmentLength, segments: chain.segments }
            : {}),
          ...(spline
            ? {
                segmentLength: spline.segmentLength,
                segmentOffset: spline.segmentOffset,
                segment2Offset: spline.segment2Offset,
              }
            : {}),
          paths: sided,
        }
      : undefined
  );
}
