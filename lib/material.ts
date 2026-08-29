// A piece's materials, and where their textures land in the mirror.
//
// The client names a texture by the property it fills rather than by what it is,
// so the mapping from one to the other lives here, next to the paths it rewrites.
import path from "node:path";

/** Texture extension the mirror publishes, replacing the client's `.dds`. */
export const TEXTURE_EXTENSION = ".webp";

/** Whether a texture holds colour a viewer must decode, or raw numbers. */
export enum ColorSpace {
  Srgb = "srgb",
  Linear = "linear",
}

export type Material = {
  name: string;
  shader: string;
  /** Shader property name to the texture it samples. */
  textures: Record<string, { path: string; colorSpace: ColorSpace; hd?: string }>;
  /** Every shader parameter that is not a texture, by property name. */
  values: Record<string, boolean | number | number[]>;
  /** Draw both faces: thin geometry such as a track loses its far side without it. */
  doubleSided: boolean;
  /** Cut away alpha below this fraction, or null when the material is opaque. */
  alphaTest: number | null;
  /**
   * Set when this material's look was taken from another on the same vehicle,
   * naming which. The client leaves a material empty where a piece is painted
   * like the one it grows out of, a casemate sharing its hull's skin being the
   * common case, and a viewer drawing the empty one gets a white turret.
   */
  inheritedFrom?: string;
};

// Only the base colour carries colour a viewer has to decode. Everything else
// holds numbers (directions, roughness, masks) that must be sampled as they are.
export const SRGB_PROPERTIES = new Set(["diffuseMap"]);

// `alphaReference` is a byte threshold, which glTF and three both express as a
// fraction of full opacity.
export const ALPHA_SCALE = 255;

/** The client's own name for the map holding occlusion and the camouflage mask. */
export const EXCLUDE_AND_AO_PROPERTY = "excludeMaskAndAOMap";

/** What the manifest calls the mask once it is published on its own. */
export const CAMOUFLAGE_MASK_PROPERTY = "camouflageMask";

/** Rewrite a client texture path to the one the mirror publishes. */
export function texturePath(clientPath: string): string {
  return clientPath.replace(/\.dds$/i, TEXTURE_EXTENSION);
}

/**
 * Where the camouflage mask that accompanies an occlusion map is published.
 *
 * It is a file of its own rather than a channel of the occlusion, so a viewer
 * that is not painting a camouflage never loads it.
 */
export function camouflageMaskPath(clientPath: string): string {
  // `_camo` goes in front of the `_hd`, not after it, so the pair still reads
  // as one texture and its high-definition twin to everything downstream.
  return clientPath.replace(/(_hd)?\.dds$/i, (_, hd: string | undefined) => `_camo${hd ?? ""}${TEXTURE_EXTENSION}`);
}
