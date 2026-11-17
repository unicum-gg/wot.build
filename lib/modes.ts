// The event modes' vehicles, which the client keeps in a tree of their own.
//
// A mode ships as a package whose root is the mode's own res directory:
// `halloween/vehicles/british/GB123_GSOR_1006_v7_Halloween_event/...`, with its
// scripts under `halloween/scripts/item_defs/vehicles/` and its prefabs under
// `halloween/content/`. The client mounts that tree over its own while the mode
// is loaded, so every path a mode file writes names the mode first.
//
// **The mirror is not in a mode**, which is the rule `generate-assets` already
// follows for the interface: a mode's files are laid onto the base tree, and the
// base wins wherever both carry a path. Every reader here is built on
// `vehicles/<nation>/<code>/...`, so laying the mode down there, and reading the
// paths its files write as though they named the base tree, is what makes an
// event vehicle an ordinary vehicle to everything downstream. Without it, the
// sweep's globs matched nothing in these packages and Havoc, the Halloween
// bosses and the Last Stand roster had no model at all.
//
// Nothing collides, which was checked rather than assumed: the 55 vehicle
// folders the three packs ship are all named for their event (`_Halloween_event`,
// `_HW_BOT`, `_LS_BOT`, `_Hell_Boss`), and the few shared folders (`tracks`,
// `Camouflage`) only add files the base does not carry.
import fs from "node:fs";
import path from "node:path";
import { decodePacked, type PackedNode } from "./packed.js";

/**
 * The modes whose packages carry vehicles, named after their res directory.
 *
 * **A list, because which packages they are cannot be told from outside.** A
 * package's root is only known once its block has been downloaded, and the
 * client part holds a dozen mode packages (Onslaught, Frontline, Steel Hunter
 * and the rest) that carry no vehicle of their own. Their scripts have to be
 * read on every run (see `sweepScripts`), so reading every mode package to find
 * out would be gigabytes a run for nothing. A new event with vehicles of its
 * own is a name added here.
 */
export const VEHICLE_MODES = ["halloween", "last_stand", "story_mode"] as const;

/**
 * A package holding one of those trees, its high-definition textures included.
 *
 * The `hangar_v4_*` packages are named for the same events and hold the hangar
 * the mode shows, not its vehicles, so they stay out.
 */
export const MODE_PACKAGE = new RegExp(
  `^res\\/packages\\/(${VEHICLE_MODES.join("|")})(?:_hd)?(?:-part\\d+)?\\.pkg$`,
);

/** The mode a package's paths are rooted at, or null for a base package. */
export function modeOf(packageName: string): string | null {
  return MODE_PACKAGE.exec(packageName)?.[1] ?? null;
}

/**
 * The roots a mode's tree is laid onto. A mode ships other things (its own
 * interface, its scripts' Python), and those are left where they are.
 */
const FLATTENED = "(?:vehicles|content|scripts)/";
const MODED = new RegExp(`^(?:${VEHICLE_MODES.join("|")})/(?=${FLATTENED})`, "i");

/** A path a mode file writes, as the base tree names it. */
export function unmoded(at: string): string {
  return at.replace(MODED, "");
}

/**
 * A packed section, with every path a mode wrote read as the base tree's.
 *
 * Done on the decoded tree rather than inside the decoder, because the decoder
 * also feeds the source mirror, which publishes the client's files as they are
 * and must keep writing `halloween/...` where the client does.
 */
export function decodeFlat(buf: Buffer): PackedNode {
  const root = decodePacked(buf);
  const walk = (node: PackedNode): void => {
    if (typeof node.value === "string") node.value = unmoded(node.value);
    for (const c of node.children) walk(c);
  };
  walk(root);
  return root;
}

/** What a nation's vehicle list is called once a mode's copy sits beside the base one. */
export function modeListName(mode: string): string {
  return `list.${mode}.xml`;
}

/**
 * Lay a mode's swept tree onto the base one, then drop it.
 *
 * **The base wins**, as it does for the interface: a file the base tree already
 * holds is left alone. The one file both always carry is a nation's
 * `list.xml`, which names that nation's vehicles, so the mode's copy is kept
 * under a name of its own beside it rather than lost, and the identity reader
 * looks in both.
 */
export function flattenMode(work: string, mode: string): void {
  const root = path.join(work, mode);
  if (!fs.existsSync(root)) return;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      let relative = path.relative(root, full);
      if (entry.name === "list.xml") relative = path.join(path.dirname(relative), modeListName(mode));
      const target = path.join(work, relative);
      if (fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(full, target);
    }
  };
  walk(root);
  fs.rmSync(root, { recursive: true, force: true });
}
