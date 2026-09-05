// How a vehicle aims, out of its script.
//
// **None of it is in the geometry.** A turret is a mesh that turns, and nothing
// in the mesh says how far: the limits, the ring's own tilt, the joint that
// cancels it and the suspension a Swedish destroyer aims with are all script,
// and a viewer handed only the meshes lets every gun point anywhere.
//
// Read in one pass with the rest of the script, since it is the same tree, but
// kept here because it is the one part of it that a reader interrogates rather
// than draws: everything else says what the vehicle looks like, and this says
// what it can do.
import type { PackedNode } from "./packed.js";
import { child, numbers } from "./read.js";

/**
 * A point from the script, flipped into the space the geometry is published in.
 *
 * The client is left-handed and glTF is not, so every piece is mirrored across
 * its centreline on the way out. A mount point that skipped that flip would put
 * a turret slightly off to the wrong side of a hull that had taken it.
 */
export function vector3(value: PackedNode | undefined): number[] | null {
  const raw = numbers(value);
  if (!(raw.length >= 3 && raw.every((n) => !Number.isNaN(n)))) return null;
  return [-raw[0], raw[1], raw[2]];
}

/** Where a vehicle carries its gun, and everywhere it can point it. */
export type Aiming = {
  /**
   * Where the turret sits on the hull, and where each turret carries its gun.
   *
   * A piece is modelled around its own origin, so a viewer has to be told where
   * each hangs off the one before. The meshes carry the same points as named
   * hardpoints, but only where the piece has a visual model at all, and a few
   * vehicles ship none for their hull.
   */
  turret: number[] | null;
  guns: Record<string, number[]>;
  /**
   * How far each gun lets its turret turn, in degrees either side of straight
   * ahead. A vehicle with no limit turns all the way round; a casemate is a
   * casemate precisely because it cannot.
   */
  yaw: Record<string, number[]>;
  /**
   * What the gun can do at each turret bearing, which is not one pair.
   *
   * The client gives the limits as `(bearing, degrees)` runs, the bearing
   * being a fraction of a full turn from straight ahead: the Tiger's gun goes
   * 8 degrees down over the nose and 3 over the engine deck, because its own
   * deck is in the way. Collapsing that to the widest pair, which is what a
   * viewer needed while nothing asked where the turret pointed, throws away
   * the whole of what a player means by depression over the rear.
   *
   * `down` is the client's `maxPitch` and `up` its `minPitch`, kept under the
   * names a reader uses rather than the ones the file happens to have.
   */
  sweep: Record<string, { up: number[][]; down: number[][] }>;
  /**
   * How far the hull itself tips, for a vehicle that aims by kneeling.
   *
   * The Swedish destroyers bolt the gun to the hull and put the aiming in the
   * suspension: the wheels ride levers and the body pitches on them, which
   * the client declares here as a pair of degrees rather than anywhere near
   * the gun. Null for every vehicle that aims with a turret.
   */
  hullPitch: number[] | null;
  /** Where along the hull the tipping pivots, in metres from the vehicle's origin. */
  hullPitchCentre: number | null;
  /** The angle the turret ring is mounted at, in degrees, where it is not level. */
  turretPitch: number | null;
  /** What the turret's own joint does to the gun, which cancels that angle. */
  gunJoint: number | null;
  /**
   * How far each gun elevates and depresses, in degrees. The client counts
   * downwards, so its `maxPitch` is the depression a player talks about.
   */
  pitch: Record<string, number[]>;
};

/**
 * The same aiming, as the vehicle stands once it has deployed.
 *
 * A vehicle that can plant itself ships a **second definition** of itself,
 * `<code>_siege_mode.xml`, identical but for how it aims: the Strv 103B's gun
 * is pinned at one degree while it drives and gets four down and two up once
 * planted, and its hull aiming is only switched on there. Read as one vehicle
 * and the two states merge into a tank that has never existed, pointing its gun
 * as it does in one and tipping its hull as in the other.
 *
 * Where the vehicle stands is the whole of the difference, so this is the parts
 * of its aiming that the switch moves and nothing else: the mounts themselves
 * do not travel between the two definitions.
 */
export type Deployed = Pick<
  Aiming,
  "yaw" | "sweep" | "hullPitch" | "hullPitchCentre" | "pitch"
>;

/** What a vehicle aims like before anything has been read for it. */
export function noAiming(): Aiming {
  return {
    turret: null,
    guns: {},
    yaw: {},
    pitch: {},
    sweep: {},
    hullPitch: null,
    hullPitchCentre: null,
    turretPitch: null,
    gunJoint: null,
  };
}

/** The half of it the switch moves, taken off a deployed definition. */
export function deployedFrom(aiming: Aiming): Deployed {
  return {
    yaw: aiming.yaw,
    sweep: aiming.sweep,
    pitch: aiming.pitch,
    hullPitch: aiming.hullPitch,
    hullPitchCentre: aiming.hullPitchCentre,
  };
}

/**
 * Whatever this one node says about aiming, read into `into`.
 *
 * Called on every node of the script rather than on the few that look likely:
 * the pieces are found by shape and so is this, so a vehicle that nests its
 * turrets unusually is read anyway.
 *
 * `own` is the piece **this node itself declares a model for**, not the piece
 * it sits under. A limit belongs to the gun that states it, and a node that
 * merely hangs below a turret states nothing about it.
 */
export function aimingFrom(
  node: PackedNode,
  into: Aiming,
  own: string | null,
): void {
  // The hull's own aiming, which sits at the top of the file rather than under
  // the chassis: the walk reaches everything, so it is caught by name.
  if (node.name === "hull_aiming") {
    // **A vehicle carries this block whether or not it can use it.** Both of a
    // vehicle's definitions declare the same correction angles and only the
    // deployed one adds `isEnabled`, so the flag is the whole of what says
    // whether the tank aims by tipping. Read without it, every one of the 64
    // vehicles that deploys looks as though it tips while driving.
    const pitch = child(node, "pitch");
    const enabled = /^true$/i.test(String(child(pitch, "isEnabled")?.value ?? "").trim());
    const angles = child(pitch, "wheelsCorrectionAngles");
    const low = numbers(child(angles, "pitchMin"))[0];
    const high = numbers(child(angles, "pitchMax"))[0];
    if (enabled && typeof low === "number" && typeof high === "number") {
      into.hullPitch = [low, high];
      // **Where along the hull it pivots**, which is not where the hull hangs.
      // A body tipped about the wrong point rises or falls as well as turning,
      // and the running gear it is tipping over does not follow: 1.165 m out on
      // the Kunze Panzer and the UDES 16, which at their travel is 10 to 14 cm
      // of hull driven down through its own track guards.
      into.hullPitchCentre = numbers(child(pitch, "wheelCorrectionCenterZ"))[0] ?? 0;
    }
  }
  // A hull names one turret position and each turret names where its gun goes.
  const turret = child(node, "turretPositions")?.children.map(vector3).find(Boolean);
  if (turret && !into.turret) into.turret = turret;
  // **The turret ring is not always level.** Four vehicles mount it at an
  // angle, and the gun's own joint is set to cancel that angle so the barrel
  // still sits level at rest: the Kunze Panzer's ring is 5.20 degrees and its
  // joint -5.26. Mounted flat, the pair cancels to nothing and the gun keeps
  // its full depression all the way round, which puts the barrel through the
  // engine deck. Turned on a tilted ring it sweeps a cone instead, and how far
  // it can look down depends on where it is looking. That is the whole reason
  // a vehicle can declare one depression and still not have it everywhere.
  const ring = numbers(child(node, "turretPitches")?.children[0])[0] ?? null;
  if (ring !== null && !into.turretPitch) into.turretPitch = ring;
  const gun = vector3(child(node, "gunPosition"));
  if (gun && own) into.guns[own] = gun;
  if (!own) return;
  // What the turret does to the gun before the gun does anything, which on a
  // tilted ring is what keeps it level at rest.
  const joint = numbers(child(node, "gunJointPitch"))[0] ?? null;
  if (joint !== null) into.gunJoint = joint;
  const yaw = numbers(child(node, "turretYawLimits"));
  if (yaw.length >= 2) into.yaw[own] = [yaw[0], yaw[1]];
  // The limits come as pairs of (turret angle, limit) because a gun can be
  // stopped by its own hull: only the widest of them matters to a viewer that
  // is not simulating where the turret is pointed.
  const limits = child(node, "pitchLimits");
  // The runs as the client writes them: bearing, degrees, bearing, degrees.
  const runs = (name: string): number[][] => {
    const flat = numbers(child(limits, name));
    const out: number[][] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
    return out;
  };
  const down = runs("maxPitch");
  const up = runs("minPitch");
  if (down.length > 0 || up.length > 0) {
    // The widest pair stays, for every reader that only asks how far the gun
    // goes at all, and the runs go beside it for the one that asks where.
    into.pitch[own] = [
      Math.min(...up.map(([, deg]) => deg), 0),
      Math.max(...down.map(([, deg]) => deg), 0),
    ];
    into.sweep[own] = { up, down };
  }
}
