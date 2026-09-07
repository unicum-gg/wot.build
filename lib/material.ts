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

/**
 * A set of file paths, matched the way the client writes them.
 *
 * **The client's own paths do not agree with its own files.** The T-34-85's
 * hull material asks for `T-34-85_Hull_01_AM.dds` where the package ships
 * `T-34-85_hull_01_AM.dds`, and the game never notices: it runs on Windows,
 * where a path is case-insensitive. Read literally, a reference like that names
 * a file nobody wrote, so it was dropped and the piece went out with no albedo,
 * no relief and no gloss. Eleven vehicles carry twenty-two of them, and on the
 * T-34-85 it took the hull: the tank reached the viewer as a turret and two
 * tracks floating over the gap where it should have been.
 *
 * So a path is matched folded, and answered with the spelling the file was
 * really written under, which is the one a viewer has to ask for.
 */
export type PathIndex = {
  /** Whether the set holds this file, however the client spells it. */
  has(path: string): boolean;
  /** The spelling it was written under, or null where the set holds none. */
  at(path: string): string | null;
};

/** Index a set of paths, so a reference can be resolved against it. */
export function indexPaths(paths: Iterable<string>): PathIndex {
  const exact = new Set<string>();
  const folded = new Map<string, string>();
  for (const path of paths) {
    exact.add(path);
    // A spelling that exists is always answered with itself, so folding can
    // only ever rename a reference that matches nothing as written. Which of
    // two files sharing a folded name it lands on never comes up: the client
    // builds on a filesystem that could not hold both.
    if (!folded.has(path.toLowerCase())) folded.set(path.toLowerCase(), path);
  }
  return {
    has: (path) => exact.has(path) || folded.has(path.toLowerCase()),
    at: (path) => (exact.has(path) ? path : (folded.get(path.toLowerCase()) ?? null)),
  };
}

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
  published: PathIndex,
): Material[] {
  // The client ships each texture twice, the second at twice the side under a
  // `_hd` name. The pair is published side by side and named here, so a
  // viewer can offer the choice without the manifest describing two vehicles.
  const highDefinition = (path: string) => path.replace(/\.webp$/, "_hd.webp");
  const finished = list.map((material) => {
    const textures: Material["textures"] = {};
    for (const [property, texture] of Object.entries(material.textures)) {
      // The mirror's spelling, not the material's: they differ on eleven
      // vehicles and the viewer asks for the file by name.
      const path = published.at(texture.path);
      if (!path) continue;
      const hd = published.at(highDefinition(path));
      textures[property] = hd ? { ...texture, path, hd } : { ...texture, path };
    }
    return { ...material, textures };
  });
  
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
