// Publishing a vehicle texture as something a browser can sample directly.
//
// The client's textures are not plain images. It stores a normal map in two
// channels (the trick that survives DXT compression: X in alpha, Y in green,
// with red and blue left at zero) and an occlusion map in one, so converting
// them as RGBA would encode two channels of nothing and, worse, compress that
// nothing as noise. A normal map written that way came out three times the size
// of the albedo it accompanies.
//
// So each texture is rebuilt for what it actually is, which both shrinks it and
// leaves it usable as is: the normal map gets its Z reconstructed and becomes an
// ordinary tangent-space map, occlusion becomes greyscale, and the rest drop an
// alpha channel that is constant.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { decodeDDS } from "./dds.js";

export enum TextureRole {
  /** Base colour. */
  Albedo = "AM",
  /** Tangent-space normals, two channels. */
  Normal = "ANM",
  /** Metalness, gloss and a mask, one per channel. */
  MetallicGloss = "GMM",
  /** Baked occlusion, one channel. */
  Occlusion = "AO",
  /** The mask that says which areas a player's camouflage recolours. */
  ColorId = "ID",
  /** Anything the client names differently. */
  Other = "",
}

/**
 * A texture's role, read from the suffix the client names it with.
 *
 * The suffix is the only signal available at conversion time: a texture is
 * routinely shipped in a different package from the material referencing it, so
 * waiting to be told what it is would mean holding both packages at once.
 */
export function textureRole(file: string): TextureRole {
  // The high-definition set is the same texture at twice the side, named with a
  // `_hd` after the role. Reading the suffix without dropping it makes every one
  // of them look like an ordinary colour map, and a normal or a gloss-metal map
  // taken as colour is what turns a whole hull black.
  const name = path.basename(file, path.extname(file)).replace(/_hd$/i, "");
  const suffix = name.slice(name.lastIndexOf("_") + 1).toUpperCase();
  // A camouflage's own gloss-metal map is written `_GM` where a vehicle's is
  // `_GMM`, and the two carry the same channels: 333 of the first against 113
  // of the second, measured the same on both. Taken as an ordinary colour map
  // it publishes gloss as red, which is a coat of paint rendered as rust.
  const known = Object.values(TextureRole).find((r) => r !== TextureRole.Other && r === (suffix === "GM" ? "GMM" : suffix));
  return known ?? TextureRole.Other;
}

/**
 * Repack a normal map: its two stored directions, and the mask that rides with
 * them.
 *
 * The client keeps a normal in two channels, alpha and green, and rebuilds the
 * third in its shader, because the third is derivable: `z = sqrt(1 - x^2 -
 * y^2)`. We keep it that way. Writing the third out is a channel's worth of
 * data that carries nothing, and it is the channel an encoder handles worst.
 *
 * Which leaves blue free, and the client has something to put in it. **The red
 * channel of this same texture is the alpha mask**: a material that alpha-tests
 * compares `red + g_maskBias` against its `alphaReference` and discards below
 * it, which is what cuts the gaps out of a track and the mesh out of a grille.
 * We had been testing the diffuse map's alpha instead, which is a different
 * channel of a different file and only right by accident. Carrying the mask in
 * blue costs nothing and keeps a texture that alpha-tests to one lookup.
 */
function rebuildNormal(rgba: Buffer, pixels: number): Buffer {
  const out = Buffer.alloc(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    out[i * 3] = rgba[i * 4 + 3];
    out[i * 3 + 1] = rgba[i * 4 + 1];
    out[i * 3 + 2] = rgba[i * 4];
  }
  return out;
}

/**
 * Rewrite the client's gloss-metal-mask texture into the metal-roughness layout
 * glTF defines, so it can be sampled with no remapping in the viewer.
 *
 * The client names the texture after its channels: gloss in red, metalness in
 * green, and a mask in blue that only the camouflage system reads. glTF puts
 * roughness in green and metalness in blue, and roughness is the inverse of
 * gloss, so both move. Feeding the client's own layout to a renderer makes a
 * tank look chrome-plated.
 */
function toMetalRoughness(rgba: Buffer, pixels: number): Buffer {
  const out = Buffer.alloc(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    out[i * 3] = 0;
    out[i * 3 + 1] = 255 - rgba[i * 4];
    out[i * 3 + 2] = rgba[i * 4 + 1];
  }
  return out;
}

/** Whether the alpha channel varies, rather than being a constant fill. */
function hasAlpha(rgba: Buffer, pixels: number): boolean {
  for (let i = 0; i < pixels; i++) {
    if (rgba[i * 4 + 3] !== 255) return true;
  }
  return false;
}

/**
 * An occlusion map is two maps in one, and the second is its **alpha**.
 *
 * The client's material calls it `excludeMaskAndAOMap`. The occlusion is the
 * green channel, and the alpha is how much of a piece takes customization at
 * all: paint, camouflage and everything else are laid through it, read at five
 * times its value and clamped, which is how the client scales it.
 *
 * **Its average reads far lower than the vehicle looks**, around 30 of 255 on a
 * hull, because a texture's area is mostly the small islands of its stowage and
 * its tools, where the mask is zero, while the armour it does cover is a few
 * large islands. Painted onto the model the split is plain: the plates and the
 * turret take it and the fenders, the boxes and the aerials do not. Reading the
 * red instead, which is that same split inverted, camouflaged a vehicle's
 * accessories and left its armour bare.
 *
 * Published with the occlusion in red so anything sampling `.r` keeps working,
 * and the coverage in green.
 */
function occlusionAndCoverage(rgba: Buffer, pixels: number): Buffer {
  const out = Buffer.alloc(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    out[i * 3] = rgba[i * 4 + 1];
    out[i * 3 + 1] = rgba[i * 4 + 3];
  }
  return out;
}

/**
 * How many of a pattern's channels are really weights.
 *
 * **A flat opaque alpha is padding, not a fourth weight.** Plenty of patterns
 * ship in a three-channel block format, where decoding fills the alpha with
 * 255, and a palette whose fourth colour is opaque then lays that colour over
 * the whole surface at full weight. Measured across 400 of the client's
 * patterns, 277 are padded that way and 123 carry a real fourth weight, so the
 * two cannot be told apart by anything but the pixels.
 *
 * Left in the file rather than zeroed: a WebP written fully transparent loses
 * its colour to premultiplication in a browser, which would cost the three
 * weights that are real to fix the one that is not.
 */
export function patternWeights(rgba: Buffer, pixels: number): 3 | 4 {
  for (let i = 0; i < pixels; i++) {
    if (rgba[i * 4 + 3] !== 255) return 4;
  }
  return 3;
}

/**
 * A camouflage pattern, whose channels are **weights, not colours**.
 *
 * Each channel says how much of one of the palette's four colours to lay down,
 * and the client authors them to sum to one: measured across a four-colour
 * pattern, `r + g + b + a` is 255 on every pixel of it. So every channel is
 * kept and the conversion stays gentle: a weight that drifts is a colour that
 * bleeds into its neighbour.
 */
export async function convertCamouflage(
  src: string,
  outFile: string,
  maxEdge = 512,
): Promise<{ size: [number, number]; weights: 3 | 4 }> {
  const { width, height, rgba } = decodeDDS(fs.readFileSync(src));
  const weights = patternWeights(rgba, width * height);
  let img = sharp(rgba, { raw: { width, height, channels: 4 } });
  // A pattern is blotches, not detail, and it is laid several times across a
  // hull. Some ship at 2048, which is 226 KB of blotch each and, over the seven
  // hundred a single vehicle is offered, 158 MB.
  if (Math.max(width, height) > maxEdge) {
    const scale = maxEdge / Math.max(width, height);
    img = img.resize(Math.round(width * scale), Math.round(height * scale), { kernel: "lanczos3" });
  }
  await img.webp({ quality: 88, alphaQuality: 100, effort: 4 }).toFile(outFile);
  // The client's computed tiling divides by the pattern's own size, so it is
  // the size the client ships rather than the one published here.
  return { size: [width, height], weights };
}

/**
 * How hard the encoder is allowed to press.
 *
 * The high-definition set is the one a player switches to for a close look, so
 * it is worth several times the bytes: measured on the IS-7's hull, going from
 * 85 to 95 cuts the error by a third, for 316 KB against 131.
 */
export enum TextureQuality {
  Standard = "standard",
  High = "high",
}

/**
 * Convert one client texture to WebP, sized down to `maxEdge` on its longest
 * side. Aspect ratio is kept, since a stretched texture slides across a model.
 */
export async function convertTexture(
  src: string,
  outFile: string,
  maxEdge?: number,
  press: TextureQuality = TextureQuality.Standard,
): Promise<void> {
  const { width, height, rgba } = decodeDDS(fs.readFileSync(src));
  const pixels = width * height;
  const role = textureRole(src);

  const raw =
    role === TextureRole.Normal
      ? { data: rebuildNormal(rgba, pixels), channels: 3 as const }
      : role === TextureRole.Occlusion
        ? { data: occlusionAndCoverage(rgba, pixels), channels: 3 as const }
        : role === TextureRole.MetallicGloss
          ? { data: toMetalRoughness(rgba, pixels), channels: 3 as const }
          : { data: rgba, channels: 4 as const };

  let img = sharp(raw.data, { raw: { width, height, channels: raw.channels } });
  // An alpha channel is usually a constant the client never reads, and keeping
  // it would cost a quarter of the file for nothing. It is load-bearing on the
  // textures a material alpha-tests, which is what cuts the gaps out of a track,
  // so it is kept exactly when it carries something.
  if (raw.channels === 4 && !hasAlpha(rgba, pixels)) img = img.removeAlpha();
  if (maxEdge && Math.max(width, height) > maxEdge) {
    const scale = maxEdge / Math.max(width, height);
    img = img.resize(Math.round(width * scale), Math.round(height * scale), { kernel: "lanczos3" });
  }
  // A normal map is written without loss, and nothing else is.
  //
  // WebP's lossy mode always subsamples chroma, which halves the resolution of
  // the two channels a normal keeps its direction in. Measured on the buffer we
  // publish, that tilts every normal on a hull by 3.7 degrees on average and by
  // 75 at worst, and no quality setting touches it: q100 measures the same as
  // q97. It is what a flat, washed-out relief looks like. Lossless costs about
  // 2.7 times the bytes on these files and is exact.
  //
  // Colour is a different case: at 95 an albedo is within an rmse of 2.5 of the
  // client's own pixels, about 1% of the range, and lossless would cost 2.4x for
  // that 1%.
  const high = press === TextureQuality.High;
  if (role === TextureRole.Normal) {
    await img.webp({ lossless: true, effort: 4 }).toFile(outFile);
    return;
  }
  await img.webp({ quality: high ? 95 : 85 }).toFile(outFile);
}
