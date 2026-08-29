// The marks of excellence, which the client calls insignia on the gun.
//
// One mark per nation, in three states for the one, two and three a player can
// earn. The client ships them as `gun_<nation>_<n>.dds` and names only the third
// in its data, the other two being the same file with a different number, which
// is also how the game asks for them.
//
// They are not drawn into any texture. The vehicle's gun carries an
// `insigniaOnGun` slot holding a ray and a size, and the mark is projected onto
// whatever surface that ray crosses. So one mark serves every barrel it is
// offered on, and a viewer has to project it too.
import fs from "node:fs";
import path from "node:path";
import { decodePacked, type PackedNode } from "./packed.js";
import { child, text } from "./read.js";

const HIGHEST_MARK = 3;



/**
 * The three files a mark is shipped in, from the one the data names.
 *
 * The client names only the third and keeps the other two beside it under the
 * same name counted down. That is its own convention rather than a guess: it
 * ships `_1` and `_2` beside every `_3`.
 */
function counted(texture: string): string[] {
  return Array.from({ length: HIGHEST_MARK }, (_, i) => texture.replace(/_(\d+)(\.dds)$/i, `_${i + 1}$2`));
}

/** Every `<insignia>` in a file, however the file nests them. */
function everyInsignia(node: PackedNode, into: PackedNode[] = []): PackedNode[] {
  for (const c of node.children) {
    if (c.name === "insignia") into.push(c);
    else everyInsignia(c, into);
  }
  return into;
}

/**
 * Whether a mark's file belongs to a nation.
 *
 * The client names the files after the nation but not always with the name the
 * scripts use: `italy` is `gun_italian_3`, and France and the United Kingdom
 * share `gun_france_uk_3`. Matching the first four letters covers the spelling
 * without a table of the eleven pairs, and the shared file answers to both of
 * the nations in its name.
 */
function belongsTo(file: string, nation: string): boolean {
  const name = path.basename(file).toLowerCase();
  return name.includes(nation.toLowerCase()) || name.includes(nation.slice(0, 4).toLowerCase());
}

/**
 * The three marks a nation's guns wear, as the client paths them.
 *
 * Empty when the client offers none, which is the honest answer for a nation
 * whose file the packages do not carry.
 */
export function readMarks(customizationDir: string, nation: string): string[] {
  const file = path.join(customizationDir, "insignias", "national_insignias.xml");
  if (!fs.existsSync(file)) return [];
  for (const insignia of everyInsignia(decodePacked(fs.readFileSync(file)))) {
    const texture = text(child(insignia, "texture"));
    if (!texture || !belongsTo(texture, nation)) continue;
    return counted(texture);
  }
  return [];
}

/**
 * The marks one particular insignia carries, by the id a style names it with.
 *
 * A style can replace the national mark with one of its own: 59 of the client's
 * 3D styles do, and 326 of its 2D outfits. It is the same three files under a
 * different name, so the vehicle keeps its slot and only the picture changes.
 */
export function readInsignia(customizationDir: string, id: number): string[] {
  const dir = path.join(customizationDir, "insignias");
  if (!id || !fs.existsSync(dir)) return [];
  for (const file of fs.readdirSync(dir).sort()) {
    for (const insignia of everyInsignia(decodePacked(fs.readFileSync(path.join(dir, file))))) {
      if (Number(child(insignia, "id")?.value ?? 0) !== id) continue;
      const texture = text(child(insignia, "texture"));
      if (texture) return counted(texture);
    }
  }
  return [];
}
