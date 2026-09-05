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
import { beltOf } from "./belt.js";
import { finishMaterials } from "./material.js";
import { unskin } from "./skin.js";
import { writeGlb, type GltfBone, type GltfMesh } from "./gltf.js";
import { mirrorPoint, mirrorPositions, reverseWinding } from "./handedness.js";
import type { ChassisSpline, ChassisWheel, PhysicalTrack } from "./chassis.js";
import type { CustomizationSlot } from "./slots.js";
import type { PieceCamouflage } from "./pieces.js";
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
import { MirrorFeature, type Piece, type VehicleModel } from "./model.js";
import { hardpoints, place, placements, readVisual, tree, type Placement, type VisualMaterial, type VisualRenderSet } from "./visual.js";
import { clipsFor, movedBy } from "./animation.js";
import type { SequenceClip } from "./sequence.js";
import {
  determinant,
  skeletonOf,
  unit,
  floorsOf,
  leverSpansOf,
  leversFrom,
  ridersOf,
  wheelsOf,
  type Lever,
  type Wheel,
} from "./wheels.js";

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
   * Convert one piece. Returns the `.glb` to write, or null when the piece has
   * no geometry to draw, which is what a visual whose blocks live in another
   * file looks like from here.
   */
  add(name: string, visualBuf: Buffer, primitivesBuf: Buffer, clips: SequenceClip[] = []): Buffer | null {
    const visual = readVisual(visualBuf);
    const index = blocks(primitivesBuf);
    const nodes = placements(visual.root);
    // The same tree, unflattened, which is what an animation moves through: a
    // chamber that swings open has to carry the plunger inside it.
    const shape = tree(visual.root);
    const animated = new Set([...movedBy(clips)].filter((node) => shape.has(node)));
    /** What each node ends up hanging off, once the skeletons are built. */
    const parents = new Map<string, string | undefined>();

    const meshes: GltfMesh[] = [];
    const entries: { name: string; materials: number[] }[] = [];
    for (const set of visual.renderSets) {
      const vertexBlock = index.get(set.vertices);
      const indexBlock = index.get(set.indices);
      if (!vertexBlock || !indexBlock) continue;
      const vertices = readVertices(primitivesBuf, vertexBlock);
      const indices = readIndices(primitivesBuf, indexBlock);
      unskin(set, vertices, indices.indices, nodes);
      const label = set.vertices.replace(/\.vertices$/, "") || name;

      const skeleton = skeletonOf(set, nodes, shape, animated);
      for (const bone of skeleton ?? []) parents.set(bone.name, bone.parent);

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
      const found = wheelsOf(set, vertices);
      for (const wheel of found) {
        if (!this.wheels.some((w) => w.bone === wheel.bone)) this.wheels.push(wheel);
      }
      // And the arms they ride on, where the vehicle has them, with the half
      // of the running gear that rides clear of the ground beside it. Kept as
      // spans and matched to wheels once every set has been read, because a
      // chassis does not always draw an arm and the wheel it carries together.
      for (const [bone, span] of leverSpansOf(set, vertices)) {
        if (!this.leverSpans.has(bone)) this.leverSpans.set(bone, span);
      }
      for (const [bone, floor] of floorsOf(set, vertices)) {
        const known = this.floors.get(bone);
        if (known === undefined || floor < known) this.floors.set(bone, floor);
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
        skeleton: skeleton,
        jointCount: set.bones.length,
        joints: vertices.bones.length ? vertices.bones : undefined,
        weights: vertices.weights.length ? vertices.weights : undefined,
      });
      entries.push({ name: label, materials: groups.map((g) => g.material) });
    }
    if (meshes.length === 0) return null;

    const animations = clipsFor(clips, shape, parents);
    this.pieces[name] = {
      glb: `${name}.glb`,
      ...(animations.length > 0 ? { clips: animations.map((a) => a.name) } : {}),
      hardpoints: Object.fromEntries(
        Object.entries(hardpoints(visual.root)).map(([name, at]) => [name, mirrorPoint(at)]),
      ),
      meshes: entries,
    };
    return writeGlb(meshes, animations);
  }

  /** Every arm bone's span, until the wheels they carry are all known. */
  private leverSpans = new Map<string, { min: number[]; max: number[] }>();

  /** How low each of the piece's bones reaches, for the split above. */
  private floors = new Map<string, number>();

  /** How this chassis lays its belt, once its script has been read. */
  private spline: ChassisSpline | null = null;

  /** How this chassis chains its belt, where it lays none along a path. */
  private chain: PhysicalTrack | null = null;

  /** The wheels the chassis says ride on arms, whether or not one is drawn. */
  private carried: string[] = [];

  /** Told which wheels ride the ground rather than the body. */
  declareCarried(wheels: string[]): void {
    this.carried = wheels;
  }

  /** Which piece each module draws, by the key the scripts name it with. */
  private modules: Record<string, string> = {};

  /** Told what the scripts call each module that has a model. */
  declareModules(modules: Record<string, string>): void {
    this.modules = modules;
  }

  /** Told what the chassis declares about its belt, laid or chained. */
  declareSpline(spline: ChassisSpline | null, chain: PhysicalTrack | null = null): void {
    this.spline = spline;
    this.chain = chain;
  }

  /**
   * The manifest, keeping only textures that were actually published.
   *
   * A material can name a texture the client no longer ships: the detail and
   * colour-id maps are referenced by every vehicle but absent from the packages,
   * so publishing the reference would send a viewer after a file that is not
   * there. `published` holds the mirror-relative path of every texture written.
   */
  build(published: Set<string>, hullPosition: number[] | null): VehicleModel {
    const materials = finishMaterials(this.materials, published);
    // The script is the authority on how big a wheel is; the mesh only says
    // where it is. Its names are the tree's, without the `_BlendBone` the skin
    // adds, and it says nothing about a vehicle whose script is gone.
    const wheels = this.wheels.map((wheel) => {
      const declared = this.declared[wheel.bone.replace(/_BlendBone$/, "")];
      if (!declared) return wheel;
      // **Never inside the wheel a player can see.** The chassis is the better
      // source for what a wheel turns at, and on most vehicles it says a little
      // more than the rim measures, which is the belt standing proud of it. The
      // FV304 is the other way round: it declares 289 mm on wheels drawn at 400,
      // so a belt laid on the declared figure runs straight through them. What
      // the mesh spans is a floor no declaration gets to go under.
      //
      // Measured rather than assumed to be a disc: `wheelsOf` takes the cloud a
      // bone drives, so a bone that also carries an arm would read large. Every
      // wheel checked spans the same height as length to within one percent, so
      // the cloud is the wheel.
      return {
        ...wheel,
        radius: declared.radius,
        wrap: Math.max(declared.wrap, wheel.wrap),
      };
    });

    // The arms, matched now that every piece's wheels are in: an arm and the
    // wheel it carries are not always drawn in the same set.
    const levers = leversFrom(this.leverSpans, wheels);

    const tracks = beltOf({
      pieces: this.pieces,
      paths: this.paths,
      spline: this.spline,
      chain: this.chain,
      wheels,
    });
    return {
      features: [MirrorFeature.NormalMask],
      ...(hullPosition ? { hullPosition } : {}),
      pieces: this.pieces,
      materials,
      tracks,
      ...(wheels.length > 0 ? { wheels } : {}),
      // **Which piece each module draws.** Published only for the pieces this
      // build actually carries: a key naming a gun the mirror never converted
      // would send a reader's choice at a file that is not there.
      ...(Object.keys(this.modules).length > 0
        ? {
            modules: Object.fromEntries(
              Object.entries(this.modules).filter(([, piece]) => this.pieces[piece]),
            ),
          }
        : {}),
      // **Which wheels stay on the ground, said outright.** Recovering it from
      // the arms alone loses the two vehicles that declare arms and draw none,
      // and those come out with every wheel bolted to the body.
      ...(this.carried.length > 0
        ? {
            carried: wheels
              .map((w) => w.bone)
              .filter((bone) => this.carried.includes(bone.replace(/_BlendBone$/, ""))),
          }
        : {}),
      ...(levers.length > 0
        ? { levers, riders: ridersOf(this.floors, wheels, levers) }
        : {}),
    };
  }

  get empty(): boolean {
    return Object.keys(this.pieces).length === 0;
  }
}
