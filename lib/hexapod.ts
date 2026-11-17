// The legs a walking vehicle stands on, which none of its modules draw.
//
// The Halloween spider (`G00_Spider_Boss_HW26_bot`) is a hull, a turret and a
// gun like any tank, and seven legs that are not a module of any kind. Its
// folder ships ONE leg, `Leg_01`, and the client places it seven times from a
// CGF prefab of its own, `content/CGFPrefabs/Hexapod/<code>.prefab`, where each
// copy is an object under the prefab's `normal` node carrying the leg's model
// and a transform. The game then bends each one by inverse kinematics towards a
// point on the ground, which is animation and not geometry, so what is
// published here is the pose the prefab sets them in.
//
// Without this, the mirror converted the leg and nothing ever drew it: a
// viewer draws the pieces the modules name, and no module names a leg.
import fs from "node:fs";
import path from "node:path";
import { compose, decompose, fromEuler, MIRROR, type Placement } from "./placement.js";
import type { PieceCopy } from "./model.js";

/** Where the client keeps the prefab that stands a vehicle on its legs. */
export function hexapodPrefab(work: string, code: string): string {
  return path.join(work, "content", "CGFPrefabs", "Hexapod", `${code}.prefab`);
}

type Vector = { x?: number | string; y?: number | string; z?: number | string };

type PrefabObject = {
  name?: string;
  components?: Record<string, { modelName?: string; position?: Vector; rotation?: Vector } | undefined>;
  children?: PrefabObject[];
};

/** Prefab numbers are written as numbers or as strings, sometimes in one file. */
const num = (v: number | string | undefined): number => Number(v ?? 0) || 0;

/** An object's own transform, in the client's space. */
function transformOf(object: PrefabObject): Placement {
  const t = object.components?.["cgf::TransformComponent"];
  const r = t?.rotation;
  const turned = r ? fromEuler(num(r.x), num(r.y), num(r.z)) : fromEuler(0, 0, 0);
  const p = t?.position;
  return { basis: turned.basis, offset: p ? [num(p.x), num(p.y), num(p.z)] : [0, 0, 0] };
}

/**
 * Every copy of a piece the prefab stands the vehicle on, in the mirror's space.
 *
 * **Read under `normal` only.** The prefab carries the same seven legs twice
 * more, under `crash` and `critical`, which are the destroyed and the damaged
 * vehicle: drawing all three would put twenty-one legs on it.
 *
 * The transform is carried across the centreline like everything else the
 * mirror publishes. The leg's own mesh was flipped when it was converted, so a
 * copy is the client's transform seen from the other side, `M P M`, which turns
 * a yaw of -135 degrees into one of 135 and leaves the left legs on the left.
 */
export function readHexapod(buf: Buffer): PieceCopy[] {
  const prefab = JSON.parse(buf.toString("utf8")) as { objects?: PrefabObject };
  const normal = prefab.objects?.children?.find((c) => c.name === "normal");
  if (!normal) return [];
  const body = transformOf(normal);
  const copies: PieceCopy[] = [];
  for (const object of normal.children ?? []) {
    const model = object.components?.["BW::DynamicModel"]?.modelName;
    const piece = model && /\/normal\/lod0\/([^/]+)\.model$/i.exec(model)?.[1];
    if (!piece) continue;
    const client = compose(body, transformOf(object));
    const { translation, rotation } = decompose(compose(MIRROR, compose(client, MIRROR)));
    copies.push({ piece, translation, rotation });
  }
  return copies;
}

/** The legs this vehicle stands on, when the run holds its prefab. */
export function hexapodOf(work: string, code: string): PieceCopy[] | null {
  const at = hexapodPrefab(work, code);
  if (!fs.existsSync(at)) return null;
  return readHexapod(fs.readFileSync(at));
}
