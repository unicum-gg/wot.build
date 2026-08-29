// What a chassis says about its wheels, which no mesh carries.
//
// A wheel turns at a rate its radius decides, and the circle a track wraps it on
// is not its rim: on a drive sprocket the belt sits down in the tooth roots,
// on an idler it stands off by the link's own thickness.
import type { PackedNode } from "./packed.js";
import { child } from "./read.js";

/** The client writes vectors as text, and drops to a real array for some. */
function numbers(node: PackedNode | undefined): number[] {
  if (!node) return [];
  if (Array.isArray(node.value)) return node.value.map(Number);
  if (typeof node.value === "number") return [node.value];
  if (typeof node.value === "string") {
    return node.value.trim().split(/\s+/).map(Number);
  }
  return [];
}

/** What a chassis says about one of its wheels, which no mesh says. */
export type ChassisWheel = {
  /** The node the client turns, as the tree names it: `W_L0`, `WD_R1`. */
  name: string;
  /** How big the wheel is, which is what decides how fast it turns. */
  radius: number;
  /**
   * The circle the track wraps it on, which is not its rim.
   *
   * On a drive sprocket the track sits down in the tooth roots, well inside the
   * tips: the IS-7's is a 432 mm wheel the track wraps at 381. On an idler it
   * stands off instead, by the link's own thickness. Only the road wheels have
   * the two the same.
   */
  wrap: number;
};

/**
 * The wheels a chassis declares.
 *
 * `wheels` names the drive wheels and idlers one at a time and the road wheels
 * as a run: a `group` with `template` `W_L`, `startIndex` 0 and `count` 7 means
 * `W_L0` through `W_L6`, all of one radius. Where the track wraps them is kept
 * somewhere else entirely, in the physical track's `wheelGroups`, and falls back
 * to the wheel itself where the vehicle gives none.
 */
export function chassisWheels(node: PackedNode): Record<string, ChassisWheel> {
  const declared = child(node, "wheels");
  if (!declared) return {};
  const radius: Record<string, number> = {};
  for (const wheel of declared.children) {
    const size = numbers(child(wheel, "radius"))[0];
    if (!Number.isFinite(size) || size <= 0) continue;
    if (wheel.name === "wheel") {
      const name = String(child(wheel, "name")?.value ?? "").trim();
      if (name) radius[name] = size;
      continue;
    }
    if (wheel.name !== "group") continue;
    const template = String(child(wheel, "template")?.value ?? "").trim();
    const start = numbers(child(wheel, "startIndex"))[0] || 0;
    const count = numbers(child(wheel, "count"))[0] || 0;
    if (!template) continue;
    for (let i = 0; i < count; i++) radius[`${template}${start + i}`] = size;
  }

  const wrap: Record<string, number> = {};
  const groups = (from: PackedNode): void => {
    if (from.name === "wheelGroup") {
      const size = numbers(child(from, "groupRadius"))[0];
      if (Number.isFinite(size) && size > 0) {
        for (const named of from.children.filter((c) => c.name === "wheelName")) {
          const name = String(named.value ?? "").trim();
          if (name && wrap[name] === undefined) wrap[name] = size;
        }
      }
      return;
    }
    for (const c of from.children) groups(c);
  };
  const tracks = child(node, "tracks");
  if (tracks) groups(tracks);

  return Object.fromEntries(
    Object.entries(radius).map(([name, size]) => [name, { name, radius: size, wrap: wrap[name] ?? size }]),
  );
}
