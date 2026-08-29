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
import { type ChassisWheel, type CustomizationSlot, type PieceCamouflage } from "./script.js";
import { hardpoints, place, placements, readVisual, type Placement, type VisualMaterial, type VisualRenderSet } from "./visual.js";

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
const SRGB_PROPERTIES = new Set(["diffuseMap"]);

// `alphaReference` is a byte threshold, which glTF and three both express as a
// fraction of full opacity.
const ALPHA_SCALE = 255;

export type Piece = {
  /** File name of the geometry, relative to the vehicle's folder. */
  glb: string;
  /** Attachment points, by name, as a translation in the vehicle's space. */
  hardpoints: Record<string, number[]>;
  /**
   * One entry per mesh in the `.glb`, in the same order, listing the material
   * each of its primitives draws with. A mesh has more than one when the client
   * shades parts of the same geometry differently.
   */
  meshes: { name: string; materials: number[] }[];
};

/**
 * How a vehicle's tracks are drawn.
 *
 * The game lays copies of one link along a closed path around the road wheels
 * and slides them as the vehicle moves, rather than drawing the fixed ribbon
 * that also ships. `segment` names the piece holding that link.
 */
export type Tracks = {
  segment: string;
  /** Closed paths in the vehicle's space, by side, in metres. */
  paths: Record<string, number[][]>;
};

/**
 * What this build of the mirror packs, for a viewer that may be older than it.
 *
 * A texture's meaning can change between builds without its name changing, and
 * a viewer cannot tell by looking: a normal map whose blue channel is a mask
 * and one whose blue channel is zero are the same file to a loader. So the
 * model says, and a viewer that does not recognise a name simply ignores it.
 */
export enum MirrorFeature {
  /** The normal map's blue carries the client's alpha mask, not a filler. */
  NormalMask = "normal-mask",
}

export type VehicleModel = {
  /** Everything this build packs that a viewer has to be told about. */
  features: MirrorFeature[];
  /**
   * How high the chassis carries the hull, in the vehicle's own space.
   *
   * Every piece but the chassis hangs off this, the hull directly and the turret
   * and gun through it. It comes from the vehicle's script rather than from any
   * mesh, and without it a hull sits buried in its own tracks.
   *
   * Absent for the handful of vehicles whose geometry outlived their script:
   * the value is unknowable there, and publishing a zero would quietly claim
   * the hull sits on the ground.
   */
  hullPosition?: number[];
  pieces: Record<string, Piece>;
  materials: Material[];
  /** Absent when the client ships no path for this vehicle. */
  tracks?: Tracks;
  /**
   * The vehicle's 3D styles, by the name the client gives each one.
   *
   * A style is a complete set of pieces with textures of its own, published
   * under `_skins/<name>/` beside the vehicle. It is reached exactly the way the
   * vehicle is, so a viewer offering them needs no new loading path: only a
   * different folder.
   */
  skins?: string[];
  /**
   * Where each piece takes a mark, an emblem or an inscription, by piece.
   *
   * The client places these by projection rather than in a texture: a slot
   * carries a ray and a size, and the surface the ray crosses is what gets
   * marked. So the marks of excellence wrap a gun barrel and an emblem sits
   * flat on a sloped plate without either being drawn into a map.
   */
  slots?: Record<string, CustomizationSlot[]>;
  /**
   * How each piece stretches a camouflage, and what it keeps clear of one.
   *
   * The client multiplies the camouflage's own tiling by the piece's, which is
   * how one pattern reads at the same size across a hull, a turret and a gun
   * whose textures are packed at very different densities.
   */
  camouflage?: Record<string, PieceCamouflage>;
  /**
   * How much the vehicle as a whole stretches a camouflage, from its own
   * script. Only the computed tiling path uses it, and only for the patterns
   * the client marks `relativeWithFactor`.
   */
  camouflageDensity?: number[];
  /**
   * The three marks of excellence this vehicle's nation wears, smallest first.
   *
   * The same ten sets serve the whole catalogue, so they are published where
   * the client keeps them and named here rather than copied per vehicle.
   */
  marks?: string[];
  /**
   * Where the 2D styles live, when the client offers any on this vehicle.
   *
   * A separate file rather than a field: it is a long list nothing needs until
   * a player opens the paint shop, and the manifest is read on every load.
   */
  styles?: string;
  /**
   * The axle each road wheel turns about, in the chassis's own space.
   *
   * The bone a wheel is skinned to sits at the origin and says nothing about
   * where its wheel is, so a viewer that turns the bone on its own swings the
   * wheel around the middle of the tank. These are read from the wheels
   * themselves, so they are in the same space as the positions we write.
   */
  wheels?: Wheel[];
};

export type Wheel = {
  /** The bone to turn, as the skin names it. */
  bone: string;
  /** Where its axle sits, so the turn happens about the right point. */
  axle: number[];
  /**
   * How far the rim stands from that axle, so a turn can match a distance.
   *
   * The chassis script's own figure where it gives one. Measuring the mesh
   * instead comes out 5% short on every wheel of the IS-7, which is a belt and
   * a set of wheels running at different speeds.
   */
  radius: number;
  /**
   * The circle the belt runs on around it, which is not the rim.
   *
   * A drive sprocket carries its track in the tooth roots, 51 mm inside the
   * tips on the IS-7, and an idler stands it off instead. Only the road wheels
   * have the two the same. Equal to the radius for a vehicle whose script the
   * client has dropped, which is the best that can be said without one.
   */
  wrap: number;
};

/**
 * A wheel's bones, as the client names them: `W_L0_BlendBone`,
 * `WD_R1_BlendBone`, and on a wheeled vehicle `WD_L0_SCR_BlendBone`.
 *
 * **The `_SCR_` one is not optional.** Where a vehicle steers, the wheel's disc
 * is bound to it and the plain bone beside it carries only the suspension arm.
 * Leaving it out of the pattern threw the disc's vertices away, so the arm alone
 * was measured: the Panhard EBR came out with a radius of 0.29 against a real
 * 0.59 and an axle off the wheel's centre, and its steered wheels swung instead
 * of turning.
 */
const WHEEL_BONE = /^WD?_[LR]\d+(_SCR)?_BlendBone$/;

/** The plain bone a steering bone sits beside, which holds the arm and not the disc. */
const steeringSibling = (name: string) => name.replace("_SCR_", "_");

/**
 * Where each of a piece's wheels turns, read from the wheel itself.
 *
 * The node tree does carry a placement beside each wheel bone, but in the
 * bone's own space rather than the mesh's, so using it puts every axle on the
 * wrong side of the tank. The geometry has no such ambiguity: every vertex is
 * bound rigidly to one bone, so a wheel is exactly the cloud of vertices
 * naming it, its axle is that cloud's centre and its radius half the height it
 * spans. Called once the rest pose is baked and the piece mirrored, so what
 * comes out is already in the space the `.glb` positions live in.
 */
function wheelsOf(set: VisualRenderSet, vertices: VertexData): Wheel[] {
  const clouds = new Map<number, { min: number[]; max: number[] }>();
  for (let i = 0; i * 4 < vertices.bones.length; i++) {
    let bone = -1;
    let best = 0;
    for (let k = 0; k < 4; k++) {
      const weight = vertices.weights[i * 4 + k];
      if (weight > best) {
        best = weight;
        bone = vertices.bones[i * 4 + k];
      }
    }
    if (bone < 0 || !WHEEL_BONE.test(set.bones[bone] ?? "")) continue;
    let cloud = clouds.get(bone);
    if (!cloud) clouds.set(bone, (cloud = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    for (let axis = 0; axis < 3; axis++) {
      const value = vertices.positions[i * 3 + axis];
      if (value < cloud.min[axis]) cloud.min[axis] = value;
      if (value > cloud.max[axis]) cloud.max[axis] = value;
    }
  }
  const out: Wheel[] = [];
  for (const [bone, cloud] of clouds) {
    // A wheel is a disc standing on edge, so the height it spans is its
    // diameter. Width would be the hub, which says nothing about the turn.
    const radius = (cloud.max[1] - cloud.min[1]) / 2;
    out.push({
      bone: set.bones[bone],
      axle: cloud.min.map((low, axis) => (low + cloud.max[axis]) / 2),
      // Both stand in until the script is read, which is where the real figures
      // are. Measuring a rim comes out about 5% under what the game turns it at.
      radius,
      wrap: radius,
    });
  }
  // Where a wheel steers, two bones answer to it and only one carries the disc.
  // The arm is not a wheel and measuring it says nothing about the turn.
  const steered = new Set(out.filter((w) => w.bone.includes("_SCR_")).map((w) => steeringSibling(w.bone)));
  return out.filter((w) => !steered.has(w.bone));
}

/** The render set's bones, placed in the piece's space, or undefined when it has none. */
function skeletonOf(set: VisualRenderSet, nodes: Map<string, Placement>): GltfBone[] | undefined {
  if (set.bones.length === 0) return undefined;
  const placed = set.bones.map((name) => {
    const at = nodes.get(name) ?? { basis: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] };
    // The skeleton rides in the mirrored space with the vertices it drives.
    return { name, basis: at.basis, offset: mirrorPoint(at.offset) };
  });
  return placed.length > 0 ? placed : undefined;
}

/** Scale a vector back to unit length, leaving a zero vector alone. */
function unit(v: number[]): number[] {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : v;
}

/** Whether a basis mirrors rather than rotates, which reverses triangle winding. */
function determinant(b: number[]): number {
  return (
    b[0] * (b[4] * b[8] - b[5] * b[7]) -
    b[1] * (b[3] * b[8] - b[5] * b[6]) +
    b[2] * (b[3] * b[7] - b[4] * b[6])
  );
}

/** The client's own name for the map holding occlusion and the camouflage mask. */
const EXCLUDE_AND_AO_PROPERTY = "excludeMaskAndAOMap";

/** What the manifest calls the mask once it is published on its own. */
const CAMOUFLAGE_MASK_PROPERTY = "camouflageMask";

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
