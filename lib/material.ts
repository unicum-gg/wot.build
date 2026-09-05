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

/**
 * The vehicle's materials as the manifest publishes them.
 *
 * A material can name a texture the client no longer ships: the detail and
 * colour-id maps are referenced by every vehicle but absent from the packages,
 * so publishing the reference would send a viewer after a file that is not
 * there. `published` holds the mirror-relative path of every texture written.
 */
export function finishMaterials(
  list: Material[],
  published: Set<string>,
): Material[] {
  // The client ships each texture twice, the second at twice the side under a
  // `_hd` name. The pair is published side by side and named here, so a
  // viewer can offer the choice without the manifest describing two vehicles.
  const highDefinition = (path: string) => path.replace(/\.webp$/, "_hd.webp");
  const finished = list.map((material) => ({
    ...material,
    textures: Object.fromEntries(
      Object.entries(material.textures)
        .filter(([, texture]) => published.has(texture.path))
        .map(([property, texture]) => [
          property,
          published.has(highDefinition(texture.path))
            ? { ...texture, hd: highDefinition(texture.path) }
            : texture,
        ]),
    ),
  }));
  
  // Fill in the ones the client left empty, from the richest material the
  // vehicle has that is not itself empty. Preferring one whose name shares a
  // part with theirs keeps a turret with a turret where both exist.
  const donors = finished.filter((m) => Object.keys(m.textures).length > 0);
  if (donors.length > 0) {
    for (const material of finished) {
      if (Object.keys(material.textures).length > 0) continue;
      const part = material.name.replace(/^tank_/, "").replace(/_skinned$/, "");
      const named = donors.find((d) => d.name.includes(part));
      const donor = named ?? donors.reduce((a, b) => (Object.keys(b.textures).length > Object.keys(a.textures).length ? b : a));
      material.textures = donor.textures;
      material.shader = material.shader || donor.shader;
      material.inheritedFrom = donor.name;
    }
  }
  return finished;
}
