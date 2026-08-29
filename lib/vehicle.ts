// Turning one vehicle's client files into what a browser can draw.
//
// A piece (hull, a turret, a gun, the chassis) becomes a `.glb` holding its
// geometry and nothing else, so a viewer gets the shape on screen before any
// texture has arrived, and so the textures the client shares between pieces are
// fetched once rather than baked into every file that uses them.
//
// The manifest published beside them is what ties it back together: which piece
// hangs off which attachment point, which material each mesh draws with, and
// where every texture lives. Materials are deduplicated across the vehicle,
// since a hull and its turret routinely share the detail and colour-id maps.
import { blocks, readIndices, readUvStream, readVertices, type VertexData } from "./primitives.js";
import { hugWheels, mirrorPath, type BeltWheel } from "./track.js";
import { writeGlb, type GltfBone, type GltfMesh } from "./gltf.js";
import { mirrorPoint, mirrorPositions, reverseWinding } from "./handedness.js";
import type { ChassisWheel } from "./chassis.js";
import type { CustomizationSlot } from "./slots.js";
import type { PieceCamouflage } from "./script.js";
import {
  ALPHA_SCALE,
  CAMOUFLAGE_MASK_PROPERTY,
  camouflageMaskPath,
  ColorSpace,
  EXCLUDE_AND_AO_PROPERTY,
  SRGB_PROPERTIES,
  texturePath,
  type Material,
} from "./material.js";
import { MirrorFeature, type Piece, type Tracks, type VehicleModel } from "./model.js";
import { hardpoints, place, placements, readVisual, type Placement, type VisualMaterial, type VisualRenderSet } from "./visual.js";
import { determinant, skeletonOf, unit, wheelsOf, type Wheel } from "./wheels.js";





















/**
 * Accumulates a vehicle's pieces, keeping one material list for the whole
 * vehicle so shared textures are declared once.
 */
export class VehicleBuilder {
  private readonly pieces: Record<string, Piece> = {};
  private readonly materials: Material[] = [];
  private readonly byKey = new Map<string, number>();
  /** Client paths of every texture the vehicle needs, deduplicated. */
  readonly textures = new Set<string>();
  private readonly paths: Record<string, number[][]> = {};
  /** The wheels the chassis turns, gathered as its pieces come in. */
  private readonly wheels: Wheel[] = [];
  /** What the script says about those wheels, which the meshes do not say. */
  private declared: Record<string, ChassisWheel> = {};

  /**
   * Take the chassis's own account of its wheels.
   *
   * The mesh says where a wheel is and roughly how big it looks. The script says
   * how big the game turns it and, separately, the circle its track wraps it on,
   * and neither is guessable from geometry: a drive sprocket's track sits in the
   * tooth roots, 50 mm inside the tips.
   */
  declareWheels(wheels: Record<string, ChassisWheel>): void {
    this.declared = wheels;
  }

  /** Record one side's track path. */
  track(side: string, points: number[][]): void {
    this.paths[side] = points;
  }

  private material(source: VisualMaterial): number {
    const textures: Material["textures"] = {};
    for (const [property, clientPath] of Object.entries(source.textures)) {
      this.textures.add(clientPath);
      textures[property] = {
        path: texturePath(clientPath),
        colorSpace: SRGB_PROPERTIES.has(property) ? ColorSpace.Srgb : ColorSpace.Linear,
      };
      // The occlusion map carries the camouflage mask in another channel, and
      // it is published beside it. Naming it here rather than leaving a viewer
      // to guess the filename means the manifest's own filter drops it when the
      // texture turns out not to have been published.
      if (property === EXCLUDE_AND_AO_PROPERTY) {
        textures[CAMOUFLAGE_MASK_PROPERTY] = { path: camouflageMaskPath(clientPath), colorSpace: ColorSpace.Linear };
      }
    }
    const reference = source.values.alphaReference;
    const material: Material = {
      name: source.name,
      shader: source.shader,
      textures,
      values: source.values,
      doubleSided: source.values.doubleSided === true,
      alphaTest:
        source.values.alphaTestEnable === true
          ? (typeof reference === "number" ? reference : ALPHA_SCALE / 2) / ALPHA_SCALE
          : null,
    };

    const key = JSON.stringify(material);
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    this.materials.push(material);
    this.byKey.set(key, this.materials.length - 1);
    return this.materials.length - 1;
  }

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
  private unskin(set: VisualRenderSet, vertices: VertexData, indices: number[], nodes: Map<string, Placement>): void {
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

  /**
   * Convert one piece. Returns the `.glb` to write, or null when the piece has
   * no geometry to draw, which is what a visual whose blocks live in another
   * file looks like from here.
   */
  add(name: string, visualBuf: Buffer, primitivesBuf: Buffer): Buffer | null {
    const visual = readVisual(visualBuf);
    const index = blocks(primitivesBuf);
    const nodes = placements(visual.root);

    const meshes: GltfMesh[] = [];
    const entries: { name: string; materials: number[] }[] = [];
    for (const set of visual.renderSets) {
      const vertexBlock = index.get(set.vertices);
      const indexBlock = index.get(set.indices);
      if (!vertexBlock || !indexBlock) continue;
      const vertices = readVertices(primitivesBuf, vertexBlock);
      const indices = readIndices(primitivesBuf, indexBlock);
      this.unskin(set, vertices, indices.indices, nodes);
      const label = set.vertices.replace(/\.vertices$/, "") || name;

      // The extra stream is a second UV set or vertex colours, told apart by
      // name. Only the UV set means anything to a glTF consumer.
      const streamBlock = set.stream.endsWith(".uv2") ? index.get(set.stream) : undefined;
      const uv2 = streamBlock ? readUvStream(primitivesBuf, streamBlock) : undefined;

      // The client pairs its primitive groups with its materials by position.
      // A set whose index block declares no group is drawn whole.
      const slices = indices.groups.length > 0 ? indices.groups : [{ startIndex: 0, triangles: indices.indices.length / 3, startVertex: 0, vertices: 0 }];
      const groups = slices.map((slice, at) => ({
        start: slice.startIndex,
        count: slice.triangles * 3,
        material: set.materials[at] ? this.material(set.materials[at]) : -1,
      }));

      // The client's space is left-handed and glTF's is not, so every piece is
      // flipped across its centreline on the way out and its triangles rewound.
      // Positions, normals and the tangent frame all carry the flip; the
      // tangent's handedness sits in its fourth component, which the mirror
      // reverses too or the normal map lights from the wrong side.
      mirrorPositions(vertices.positions);
      mirrorPositions(vertices.normals);
      for (let i = 0; i < vertices.tangents.length; i += 4) {
        vertices.tangents[i] = -vertices.tangents[i];
        vertices.tangents[i + 3] = -vertices.tangents[i + 3];
      }
      reverseWinding(indices.indices);

      // The wheels are read here, with the piece in its final space.
      for (const wheel of wheelsOf(set, vertices)) {
        if (!this.wheels.some((w) => w.bone === wheel.bone)) this.wheels.push(wheel);
      }

      meshes.push({
        name: label,
        positions: vertices.positions,
        normals: vertices.normals,
        uvs: vertices.uvs,
        tangents: vertices.tangents,
        uv2,
        indices: indices.indices,
        groups,
        // The rest pose is already baked into the positions, so the skeleton
        // rides along only for a viewer that wants to move a wheel.
        skeleton: skeletonOf(set, nodes),
        joints: vertices.bones.length ? vertices.bones : undefined,
        weights: vertices.weights.length ? vertices.weights : undefined,
      });
      entries.push({ name: label, materials: groups.map((g) => g.material) });
    }
    if (meshes.length === 0) return null;

    this.pieces[name] = {
      glb: `${name}.glb`,
      hardpoints: Object.fromEntries(
        Object.entries(hardpoints(visual.root)).map(([name, at]) => [name, mirrorPoint(at)]),
      ),
      meshes: entries,
    };
    return writeGlb(meshes);
  }

  /**
   * The manifest, keeping only textures that were actually published.
   *
   * A material can name a texture the client no longer ships: the detail and
   * colour-id maps are referenced by every vehicle but absent from the packages,
   * so publishing the reference would send a viewer after a file that is not
   * there. `published` holds the mirror-relative path of every texture written.
   */
  /** Name the track link is published under, when the vehicle ships one. */
  static readonly TRACK_SEGMENT = "TrackSegment";

  build(published: Set<string>, hullPosition: number[] | null): VehicleModel {
    // The client ships each texture twice, the second at twice the side under a
    // `_hd` name. The pair is published side by side and named here, so a
    // viewer can offer the choice without the manifest describing two vehicles.
    const highDefinition = (path: string) => path.replace(/\.webp$/, "_hd.webp");
    const materials = this.materials.map((material) => ({
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
    const donors = materials.filter((m) => Object.keys(m.textures).length > 0);
    if (donors.length > 0) {
      for (const material of materials) {
        if (Object.keys(material.textures).length > 0) continue;
        const part = material.name.replace(/^tank_/, "").replace(/_skinned$/, "");
        const named = donors.find((d) => d.name.includes(part));
        const donor = named ?? donors.reduce((a, b) => (Object.keys(b.textures).length > Object.keys(a.textures).length ? b : a));
        material.textures = donor.textures;
        material.shader = material.shader || donor.shader;
        material.inheritedFrom = donor.name;
      }
    }
    // The script is the authority on how big a wheel is; the mesh only says
    // where it is. Its names are the tree's, without the `_BlendBone` the skin
    // adds, and it says nothing about a vehicle whose script is gone.
    const wheels = this.wheels.map((wheel) => {
      const declared = this.declared[wheel.bone.replace(/_BlendBone$/, "")];
      return declared ? { ...wheel, radius: declared.radius, wrap: declared.wrap } : wheel;
    });

    const segment = this.pieces[VehicleBuilder.TRACK_SEGMENT];
    // Most vehicles ship a path per side, but a symmetrical one ships a single
    // file and expects the other side to be its mirror.
    const paths = { ...this.paths };
    const sides = Object.keys(paths);
    if (sides.length === 1) {
      const other = sides[0] === "left" ? "right" : "left";
      paths[other] = mirrorPath({ points: paths[sides[0]] }).points;
    }
    // A belt runs around the wheels on its own side, told apart by which side of
    // the tank they sit on rather than by their names, which the client keeps
    // from before the mirror.
    for (const [side, points] of Object.entries(paths)) {
      if (points.length === 0) continue;
      const band: BeltWheel[] = wheels
        .filter((wheel) => Math.sign(wheel.axle[0]) === Math.sign(points[0][0]))
        .map((wheel) => ({ axle: wheel.axle, wrap: wheel.wrap }));
      paths[side] = hugWheels(points, band);
    }

    // Name each belt for the side it is actually on. The client's own names are
    // from before the mirror, so carrying them through leaves a path called
    // `left` lying down the vehicle's right. Nothing reads them today, but the
    // same thing on the armour plates was the bug that made the hover readout
    // name the wrong track.
    const sided: Record<string, number[][]> = {};
    for (const [side, points] of Object.entries(paths)) {
      sided[points[0]?.[0] >= 0 ? "left" : "right"] = points;
    }
    const tracks =
      segment && Object.keys(sided).length > 0
        ? { segment: VehicleBuilder.TRACK_SEGMENT, paths: sided }
        : undefined;
    return {
      features: [MirrorFeature.NormalMask],
      ...(hullPosition ? { hullPosition } : {}),
      pieces: this.pieces,
      materials,
      tracks,
      ...(wheels.length > 0 ? { wheels } : {}),
    };
  }

  get empty(): boolean {
    return Object.keys(this.pieces).length === 0;
  }
}
