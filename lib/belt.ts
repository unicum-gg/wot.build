// The belt a chassis wears, and which link goes on which side of it.
//
// Where its runs come from and what each one is fitted to is `runs.ts`; this is
// what the manifest says about them.
//
// The side a link belongs on is read off the coordinates rather than off the
// file's own name. The client's `left` does survive the mirror, since X is the
// axis the flip negates and its left-and-right lives there, but a link fitted
// to the wrong side is exactly the defect this exists to prevent, and the
// coordinates cannot be wrong about it.
import { layPaths } from "./runs.js";
import { TRACK_SEGMENT, trackSegment } from "./model.js";
import type { ChassisBelt, PhysicalTrack } from "./chassis.js";
import type { BeltRun, Piece, Tracks } from "./model.js";
import type { Wheel } from "./wheels.js";

/** What the manifest says about the belt, or nothing where there is none. */
export function beltOf({
  pieces,
  paths,
  spline,
  chain,
  wheels,
  ribbons,
}: {
  pieces: Record<string, Piece>;
  /** The runs the chassis authored, by the file each came from. */
  paths: Record<string, number[][]>;
  spline: ChassisBelt[] | null;
  chain: PhysicalTrack | null;
  /** The wheels as they came out, which is what a belt is fitted to. */
  wheels: Wheel[];
  /** The fixed band the chassis bakes, by side, where it was read. */
  ribbons?: Record<string, number[][][]> | null;
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
  /** What one declared belt lays, with the two sides the right way round. */
  const linksOf = (belt: ChassisBelt | undefined) => {
    const flipped = sideOfPath(belt?.left) === "right";
    const models = belt?.models;
    return {
      segment: named(flipped ? models?.right : models?.left),
      segmentRight: named(flipped ? models?.left : models?.right),
      segment2: named(flipped ? models?.secondRight : models?.secondLeft),
      segment2Right: named(flipped ? models?.secondLeft : models?.secondRight),
    };
  };
  const sided = layPaths({ paths, belts: spline, chain, wheels, ribbons });
  // **The belt described here is one that is actually laid.** A chassis can
  // declare a belt the vehicle no longer wears: the Steel Hunter vehicles
  // write the short track they start a battle with beside the full one that
  // replaces it, and it is the full one that survives the lay. Reading the
  // first declaration regardless left the vehicle described by a link and a
  // pitch belonging to a belt nothing draws.
  const first = Object.values(sided)[0]?.belt ?? spline?.[0];
  const own = linksOf(first);
  // A chained belt names its own link, and naming it matters: the ST-B1 ships
  // two in the same folder, so taking whatever was converted first is a coin
  // toss. Falling back to that still keeps a vehicle drawing the one link it
  // does ship when nothing named it.
  const segment = own.segment ?? named(chain?.model) ?? laid[0];
  const piece = segment ? pieces[segment] : undefined;
  if (!piece || !segment || Object.keys(sided).length === 0) return undefined;

  // **What each run is, where a side carries more than one.** The chassis
  // gives every belt its own phase along the path and may give it its own link
  // and its own pitch: the AE Phase I starts one at 271 mm and the other at
  // 311, and the FV4025 Contriver lays `segment_01` outboard and `segment_02`
  // inboard. Reading one declaration for all of them put three of the AE
  // Phase I's four belts out of phase and half the Contriver's on the wrong
  // link. The wheels go with it because the reader has to rebuild the belt on
  // them, and grouping them by the side or by the line cannot separate two
  // belts that share a plane.
  //
  // Published only for a vehicle whose sides carry more than one belt each,
  // which is 23 of them, so every other vehicle comes out of a rebuild
  // unchanged.
  const doubled = Object.keys(sided).some((side) => /\d$/.test(side));
  const runs: Record<string, BeltRun> = {};
  if (doubled)
    for (const [side, run] of Object.entries(sided)) {
      const own = run.belt && run.belt !== first ? run.belt : undefined;
      const links = linksOf(own);
      runs[side] = {
        ...(links.segment && links.segment !== segment ? { segment: links.segment } : {}),
        ...(links.segmentRight && links.segmentRight !== links.segment
          ? { segmentRight: links.segmentRight }
          : {}),
        ...(links.segment2 ? { segment2: links.segment2 } : {}),
        ...(links.segment2Right && links.segment2Right !== links.segment2
          ? { segment2Right: links.segment2Right }
          : {}),
        ...(own
          ? {
              segmentLength: own.segmentLength,
              segmentOffset: own.segmentOffset,
              segment2Offset: own.segment2Offset,
            }
          : {}),
        ...(run.wheels.length > 0 ? { wheels: run.wheels } : {}),
      };
    }

  return {
    segment,
    ...(own.segmentRight && own.segmentRight !== segment
      ? { segmentRight: own.segmentRight }
      : {}),
    ...(own.segment2 ? { segment2: own.segment2 } : {}),
    ...(own.segment2Right && own.segment2Right !== own.segment2
      ? { segment2Right: own.segment2Right }
      : {}),
    // A chained belt says how many links go round, which is the one thing a
    // path cannot: laying that many evenly closes the loop with no part link
    // at the join, and carries the slack a real chain has over its rollers
    // without having to model the sag.
    ...(!first && chain
      ? { segmentLength: chain.segmentLength, segments: chain.segments }
      : {}),
    ...(first
      ? {
          segmentLength: first.segmentLength,
          segmentOffset: first.segmentOffset,
          segment2Offset: first.segment2Offset,
        }
      : {}),
    ...(Object.keys(runs).length > 0 ? { belts: runs } : {}),
    // **One ceiling per side, not one per run.** Two belts down one side are
    // held by the same hull, and each was measured on its own plane across its
    // own span, so the two profiles agree wherever they overlap and the first
    // of them answers for the side. Said only where a ribbon said something.
    ...(Object.values(sided).some((run) => run.ceiling)
      ? {
          ceilings: Object.fromEntries(
            Object.entries(sided)
              .filter(([, run]) => run.ceiling)
              .map(([side, run]) => [side.replace(/\d+$/, ""), run.ceiling!]),
          ),
        }
      : {}),
    // **And how far the belt's body stands outside the band it is laid on**,
    // which is the one thing about a link a reader cannot see for itself. Per
    // run rather than per side, since two belts down one side are two link
    // models and nothing says they are the same plate.
    ...(Object.values(sided).some((run) => run.standoff !== undefined)
      ? {
          standoffs: Object.fromEntries(
            Object.entries(sided)
              .filter(([, run]) => run.standoff !== undefined)
              .map(([side, run]) => [side, run.standoff!]),
          ),
        }
      : {}),
    paths: Object.fromEntries(
      Object.entries(sided).map(([side, run]) => [side, run.points]),
    ),
  };
}
