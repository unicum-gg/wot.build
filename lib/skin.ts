// Putting a skinned mesh back into the pose it was modelled in.
//
// **The published pieces carry no skeleton of their own.** A viewer that draws
// a hull, a turret and a gun as three files hangs them off one another by the
// hardpoints the script names, so a mesh still parked in bone space would be
// placed twice: once by its bones and once by the piece it belongs to.
import { determinant, unit } from "./wheels.js";
import { place, type Placement, type VisualRenderSet } from "./visual.js";
import type { VertexData } from "./primitives.js";

/**
 * Move a skinned set's vertices out of bone space and into the piece's.
 *
 * This is the rest pose the game itself starts from: each vertex is placed by
 * every bone it leans on and the results blended by weight, rather than
 * snapped to whichever bone pulls hardest. The client's bones sit at the
 * identity save for a flip of the Z axis, so a set drawn without them comes
 * out back to front, a gun's muzzle ending up behind its breech. The flip also
 * reverses winding, so triangles are turned back around to keep their faces
 * pointing out.
 */
export function unskin(set: VisualRenderSet, vertices: VertexData, indices: number[], nodes: Map<string, Placement>): void {
  if (set.bones.length === 0 || vertices.bones.length === 0) return;
  const bones = set.bones.map((name) => nodes.get(name));
  if (!bones.some(Boolean)) return;

  const mirrored = bones.every((b) => !b || determinant(b.basis) < 0);
  const count = vertices.positions.length / 3;
  for (let i = 0; i < count; i++) {
    const at = i * 3;
    const skinAt = i * 4;
    const position = [0, 0, 0];
    const normal = [0, 0, 0];
    const tangent = [0, 0, 0];
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const weight = vertices.weights[skinAt + k];
      const bone = bones[vertices.bones[skinAt + k]];
      if (!(weight > 0) || !bone) continue;
      const rotation = { basis: bone.basis, offset: [0, 0, 0] };
      const p = place(bone, vertices.positions[at], vertices.positions[at + 1], vertices.positions[at + 2]);
      const n = place(rotation, vertices.normals[at], vertices.normals[at + 1], vertices.normals[at + 2]);
      const t = vertices.tangents.length
        ? place(rotation, vertices.tangents[i * 4], vertices.tangents[i * 4 + 1], vertices.tangents[i * 4 + 2])
        : [0, 0, 0];
      for (let axis = 0; axis < 3; axis++) {
        position[axis] += weight * p[axis];
        normal[axis] += weight * n[axis];
        tangent[axis] += weight * t[axis];
      }
      total += weight;
    }
    if (total <= 0) continue;
    for (let axis = 0; axis < 3; axis++) position[axis] /= total;
    // Blending shortens a direction, so both frames go back to unit length.
    const unitNormal = unit(normal);
    const unitTangent = unit(tangent);
    for (let axis = 0; axis < 3; axis++) {
      vertices.positions[at + axis] = position[axis];
      vertices.normals[at + axis] = unitNormal[axis];
      if (vertices.tangents.length) vertices.tangents[i * 4 + axis] = unitTangent[axis];
    }
    // A mirroring bone swaps which way the bitangent turns.
    if (mirrored && vertices.tangents.length) vertices.tangents[i * 4 + 3] *= -1;
  }
  // A mirroring bone was reversing the winding here as well. It should not:
  // the normals have just been carried through the same mirror, so they
  // already point the way the unreversed winding says they do. Doing both
  // left every skinned piece — every chassis in the mirror — with normals
  // facing the opposite way to its own triangles, which lights a track and
  // its road wheels from the wrong side.
}
