// The shape of what the mirror publishes for one vehicle.
//
// This is the contract a consumer reads: the pieces, where they hang off each
// other, the wheels, the track, and everything a 2D style needs to be laid on
// top. It is kept apart from the builder that fills it in, because a reader of
// the mirror needs the shape and none of the machinery.
import type { ChassisWheel } from "./chassis.js";
import type { Material } from "./material.js";
import type { PieceCamouflage } from "./script.js";
import type { CustomizationSlot } from "./slots.js";
import type { Style2D } from "./style.js";
import type { Wheel } from "./wheels.js";

export type Piece = {
  /** File name of the geometry, relative to the vehicle's folder. */
  glb: string;
  /** Attachment points, by name, as a translation in the vehicle's space. */
  hardpoints: Record<string, number[]>;
  /**
   * One entry per mesh in the `.glb`, in the same order, listing the material
   * each of its primitives draws with. A mesh has more than one when the client
   * shades parts of the same geometry differently.
   */
  meshes: { name: string; materials: number[] }[];
};

/**
 * How a vehicle's tracks are drawn.
 *
 * The game lays copies of one link along a closed path around the road wheels
 * and slides them as the vehicle moves, rather than drawing the fixed ribbon
 * that also ships. `segment` names the piece holding that link.
 */
export type Tracks = {
  segment: string;
  /** Closed paths in the vehicle's space, by side, in metres. */
  paths: Record<string, number[][]>;
};

/**
 * What this build of the mirror packs, for a viewer that may be older than it.
 *
 * A texture's meaning can change between builds without its name changing, and
 * a viewer cannot tell by looking: a normal map whose blue channel is a mask
 * and one whose blue channel is zero are the same file to a loader. So the
 * model says, and a viewer that does not recognise a name simply ignores it.
 */
export enum MirrorFeature {
  /** The normal map's blue carries the client's alpha mask, not a filler. */
  NormalMask = "normal-mask",
}

export type VehicleModel = {
  /** Everything this build packs that a viewer has to be told about. */
  features: MirrorFeature[];
  /**
   * How high the chassis carries the hull, in the vehicle's own space.
   *
   * Every piece but the chassis hangs off this, the hull directly and the turret
   * and gun through it. It comes from the vehicle's script rather than from any
   * mesh, and without it a hull sits buried in its own tracks.
   *
   * Absent for the handful of vehicles whose geometry outlived their script:
   * the value is unknowable there, and publishing a zero would quietly claim
   * the hull sits on the ground.
   */
  hullPosition?: number[];
  pieces: Record<string, Piece>;
  materials: Material[];
  /** Absent when the client ships no path for this vehicle. */
  tracks?: Tracks;
  /**
   * The vehicle's 3D styles, by the name the client gives each one.
   *
   * A style is a complete set of pieces with textures of its own, published
   * under `_skins/<name>/` beside the vehicle. It is reached exactly the way the
   * vehicle is, so a viewer offering them needs no new loading path: only a
   * different folder.
   */
  skins?: string[];
  /**
   * Where each piece takes a mark, an emblem or an inscription, by piece.
   *
   * The client places these by projection rather than in a texture: a slot
   * carries a ray and a size, and the surface the ray crosses is what gets
   * marked. So the marks of excellence wrap a gun barrel and an emblem sits
   * flat on a sloped plate without either being drawn into a map.
   */
  slots?: Record<string, CustomizationSlot[]>;
  /**
   * How each piece stretches a camouflage, and what it keeps clear of one.
   *
   * The client multiplies the camouflage's own tiling by the piece's, which is
   * how one pattern reads at the same size across a hull, a turret and a gun
   * whose textures are packed at very different densities.
   */
  camouflage?: Record<string, PieceCamouflage>;
  /**
   * How much the vehicle as a whole stretches a camouflage, from its own
   * script. Only the computed tiling path uses it, and only for the patterns
   * the client marks `relativeWithFactor`.
   */
  camouflageDensity?: number[];
  /**
   * The three marks of excellence this vehicle's nation wears, smallest first.
   *
   * The same ten sets serve the whole catalogue, so they are published where
   * the client keeps them and named here rather than copied per vehicle.
   */
  marks?: string[];
  /**
   * Where this vehicle's 2D styles live, when the client offers any.
   *
   * A separate file rather than a field: it is a long list nothing needs until
   * a player opens the paint shop, and the manifest is read on every load.
   *
   * **It holds a patch, not the styles.** The recipes themselves are the same on
   * every vehicle that can wear them, so they are published once at the root of
   * the mirror, also as `styles2d.json`, and this names which of them this
   * vehicle is offered and the handful whose tiling the client tuned for it.
   */
  styles?: string;
  /**
   * The axle each road wheel turns about, in the chassis's own space.
   *
   * The bone a wheel is skinned to sits at the origin and says nothing about
   * where its wheel is, so a viewer that turns the bone on its own swings the
   * wheel around the middle of the tank. These are read from the wheels
   * themselves, so they are in the same space as the positions we write.
   */
  wheels?: Wheel[];
};
