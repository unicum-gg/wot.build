// The vehicle as it looks in the game: its own meshes, its own textures, and a
// track laid link by link along the path the client ships.
//
// This is the third of the three views, and the only one that draws the vehicle
// rather than its collision shell, so it brings its own lighting: the armour
// views paint answers and want none, this one is lit like a hangar.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DecalGeometry } from "three/addons/geometries/DecalGeometry.js";


/** The ribbon the chassis carries is the game's cheap stand-in for a track. */
const RIBBON = /^track_/;
/** The road wheels the client skins the chassis to. */
const WHEEL = /^W_[LR]\d+_BlendBone$/;
/** `?wheels=off` holds the wheels still, which is how they are compared. */
const TURN_WHEELS = new URLSearchParams(location.search).get("wheels") !== "off";
/**
 * Which way round a link sits on its path.
 *
 * Counting vertices says the narrow face (12 of them across 4 cm) is the centre
 * guide and the wide one (104 across 70 cm) is the shoe, which argues for the
 * wide face outwards. In the game it is the other way round, so the count is
 * measuring something else: the 12 are the tip of the guide, not the guide.
 *
 * There is nothing in the client to check this against: its own track ribbon,
 * which would have settled it, carries no relief at all. So this is set from
 * what the game shows, and `?links=flip` still swaps it if it ever needs
 * revisiting.
 */
const SOFT_RELIEF = new URLSearchParams(location.search).get("relief") === "soft";
const LINK_FACING = new URLSearchParams(location.search).get("links") === "flip" ? 1 : -1;

/**
 * The path a belt follows, as a curve rather than as the polygon the client
 * ships.
 *
 * The client gives about thirty points around the loop. Reading them as
 * straight segments makes every link snap through a new heading the moment it
 * crosses a corner, which is what a running track looks like when it stutters.
 * A centripetal Catmull-Rom through the same points keeps the heading
 * continuous, and its arc-length parameterisation is what keeps links a fixed
 * distance apart: sampling the curve by `t` alone would bunch them up wherever
 * the curve tightens, which is exactly at the idler and the drive wheel.
 */
function pathOf(points) {
  const curve = new THREE.CatmullRomCurve3(
    points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    true,
    "centripetal",
  );
  // The default division count is far too coarse for a loop this long: it is
  // what decides how evenly `getPointAt` spaces things.
  curve.arcLengthDivisions = Math.max(600, points.length * 24);
  return { curve, total: curve.getLength() };
}

/**
 * Lay links along one side's path, the way the game does: a link every
 * link-length, each turned to follow the path.
 *
 * A link is modelled with its centre guide on the low side and its shoe on the
 * high side. The guide has to point **into** the loop so it rides between the
 * road wheels, which puts the shoe outwards: against the ground on the bottom
 * run, skywards on the top one. So the link's own up axis faces out of the
 * loop, and the belt turns over correctly at each end.
 *
 * A link is laid on the **chord** to the next one, not on the tangent under its
 * own centre. A link is a rigid bar between two pins, and pins sit a straight
 * line apart, so a chord is what it actually spans. Sitting it on the tangent
 * instead lifts both its ends off the curve, by 25 mm on a wheel as small as an
 * idler, and every joint round that wheel opens a gap you can see through. On
 * the chord the ends land back on the curve and consecutive links overlap by a
 * few millimetres, which is what a real track does at the pin.
 */
function layTrack(geometry, material, points, linkLength) {
  const { curve, total } = pathOf(points);
  const count = Math.max(1, Math.round(total / linkLength));
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const basis = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const along = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const outward = new THREE.Vector3();
  const side = new THREE.Vector3();
  // Sliding every link by the same distance is how the game runs a track: the
  // belt moves, the path does not.
  const place = (offset) => {
    for (let i = 0; i < count; i++) {
      // A tank rolling forward drives its belt backwards along the top run,
      // which is the direction the loop is wound in, so the offset subtracts.
      const t = (((i / count - offset / total) % 1) + 1) % 1;
      const next = (t + 1 / count) % 1;
      curve.getPointAt(t, at);
      curve.getPointAt(next, ahead);
      along.subVectors(ahead, at).normalize();
      at.lerp(ahead, 0.5);
      // Which way is out of the loop. The link is modelled with its centre
      // guide on one side and its shoe on the other, so this is what decides
      // whether the guide rides between the road wheels or sticks out into the
      // air. The client ships no reference for it: its own ribbon is flat.
      outward.set(0, along.z * LINK_FACING, -along.y * LINK_FACING).normalize();
      side.crossVectors(outward, along);
      basis.makeBasis(side, outward, along).setPosition(at);
      mesh.setMatrixAt(i, basis);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  place(0);
  return { mesh, count, place, total };
}

/**
 * The micro-detail every tank material asks for and no client ships.
 *
 * Each material names `Tank_detail/Details_map.dds` and carries the settings
 * that drive it: `g_detailUVTiling` (about eight repeats across the piece),
 * `g_detailPowerAlbedo` (0.10 to 0.14), `g_detailPowerGloss` (0.35) and
 * `g_detailPower` (7 to 8). The file itself is in no package: searched across
 * every shared and sandbox package in all three parts, `Tank_detail` holds only
 * the dirt and snow maps. So the layer is rebuilt rather than mirrored: a fine
 * neutral grain, tiled and weighted by the client's own numbers.
 *
 * **It has to be genuinely fine.** The first version mixed a fine speckle with
 * a slow sine swirl, two thirds of its weight on the swirl. Measured on the
 * texture, that put more energy 48 pixels apart than 1 pixel apart, and at the
 * client's own tiling those became palm-sized blotches drifting across a
 * glacis: not micro-detail, dirt. A cast-metal grain is almost all of its
 * energy at one texel.
 *
 * It matters more than it sounds. Gloss is modulated by 0.35, and on a large,
 * gently curved, fairly smooth shell it is that variation that makes a
 * reflection break up instead of sliding across as one clean sheet. Without it
 * a hull reads as plastic no matter how good the albedo is.
 */
function detailGrain() {
  const side = 256;
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(side, side);

  // White noise, softened by one pixel so it survives mipmapping instead of
  // dissolving into a flat grey the moment the surface tilts away.
  const noise = new Float32Array(side * side);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.random();
  const soft = new Float32Array(side * side);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          sum += noise[((y + dy + side) % side) * side + ((x + dx + side) % side)];
        }
      }
      soft[y * side + x] = sum / 9;
    }
  }

  // Centred on zero and scaled to a fixed spread, so the layer only ever adds
  // texture. The shader reads this as `value - 0.5`, so a mean that drifts off
  // 0.5 quietly lifts or drops the albedo and the roughness of every material
  // it touches.
  let mean = 0;
  for (const v of soft) mean += v;
  mean /= soft.length;
  let spread = 0;
  for (const v of soft) spread += (v - mean) ** 2;
  spread = Math.sqrt(spread / soft.length);
  const scale = 0.12 / (spread || 1);

  for (let i = 0; i < soft.length; i++) {
    const v = Math.round(255 * Math.min(1, Math.max(0, 0.5 + (soft[i] - mean) * scale)));
    image.data[i * 4] = v;
    image.data[i * 4 + 1] = v;
    image.data[i * 4 + 2] = v;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const map = new THREE.CanvasTexture(canvas);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  // Tiled eight times across a panel and read at grazing angles, so it needs
  // the same anisotropy the vehicle's own maps get or it smears to grey exactly
  // where a viewer is closest to the metal.
  map.anisotropy = 16;
  return map;
}

/** One grain for the whole vehicle, the way one file would have been. */
const GRAIN = detailGrain();

/**
 * One black pixel, for a sampler that has nothing to read yet.
 *
 * Leaving a sampler unbound is not harmless: it reads black, and a shader that
 * quietly samples nothing looks exactly like one that works until the thing it
 * was meant to draw goes missing.
 */
/**
 * A one-pixel texture, ready to sample.
 *
 * three filters a texture through its mipmaps by default, and a texture made by
 * hand has none, so a sampler set up that way reads nothing at all. Which looks
 * exactly like a shader that decided not to draw.
 */
function flat(map) {
  map.minFilter = THREE.NearestFilter;
  map.magFilter = THREE.NearestFilter;
  map.generateMipmaps = false;
  map.needsUpdate = true;
  return map;
}

const BLANK = flat(new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1));
// A normal map's own idea of "no relief", which is not black: an unbound
// sampler reads zero and decodes to a normal pointing back into the surface.
const FLAT = flat(new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1));


/**
 * Wait for a texture's picture, since nothing can be sized against it before.
 *
 * `TextureLoader.load` hands back a texture whose image is still null and fills
 * it in later, so a decal built straight away would be sized against nothing.
 */
function whenLoaded(map) {
  if (map.image?.width) return Promise.resolve(map);
  return new Promise((done) => {
    const wait = setInterval(() => {
      if (!map.image?.width) return;
      clearInterval(wait);
      done(map);
    }, 40);
  });
}

/**
 * Lay a decal on a piece, in the piece's own space.
 *
 * `DecalGeometry` reads its target's world matrix, and everything the client
 * places is given relative to the vehicle. Lending it the identity for the
 * length of the call keeps the result in the piece's own space, so the decal
 * can hang off the mesh and follow it as the turret turns and the gun aims.
 */
function project(mesh, at, turn, size, material, facing) {
  const world = mesh.matrixWorld.clone();
  mesh.matrixWorld.identity();
  const geometry = clipToFacing(new DecalGeometry(mesh, at, turn, size), facing);
  mesh.matrixWorld.copy(world);
  // A slot can point at a piece that has nothing where it points, which is
  // normal: the client offers the same slot on a vehicle and on its styles.
  if (geometry.attributes.position.count === 0) {
    geometry.dispose();
    return null;
  }
  const decal = new THREE.Mesh(geometry, material);
  decal.renderOrder = 1;
  mesh.add(decal);
  return decal;
}

/**
 * Keep only the triangles that face the projector.
 *
 * **A decal box does not stop at the horizon.** On a gun barrel that is what
 * bites: the Panhard EBR's barrel is 0.106 across and a mark's box is 0.7 tall,
 * so the box passes right through and takes the far side of the tube with it,
 * and the mark comes out in pieces. The client guards against this with a
 * `clipAngle` on the slot and drops whatever faces away, which is what this
 * does. The IS-7 never showed it because its barrel is half again as thick.
 *
 * **The limit is barely off zero on purpose.** Anything stricter carves an arc
 * out of each flank rather than a hemisphere, and a mark that runs right round
 * a barrel then meets its own other half with a gap between them: at seventy
 * five degrees the two halves cover three hundred and leave sixty of bare tube
 * along the top. Facing the projector at all is the whole of the test.
 */
function clipToFacing(geometry, facing, limit = 0.02) {
  if (!facing) return geometry;
  const normal = geometry.getAttribute("normal");
  const kept = [];
  for (let i = 0; i < normal.count; i += 3) {
    const towards =
      (normal.getX(i) + normal.getX(i + 1) + normal.getX(i + 2)) * facing.x +
      (normal.getY(i) + normal.getY(i + 1) + normal.getY(i + 2)) * facing.y +
      (normal.getZ(i) + normal.getZ(i + 1) + normal.getZ(i + 2)) * facing.z;
    if (towards / 3 > limit) kept.push(i);
  }
  if (kept.length * 3 === normal.count) return geometry;
  const trimmed = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv"]) {
    const from = geometry.getAttribute(name);
    if (!from) continue;
    const width = from.itemSize;
    const out = new Float32Array(kept.length * 3 * width);
    kept.forEach((start, at) => {
      for (let v = 0; v < 3; v++) {
        for (let c = 0; c < width; c++) out[(at * 3 + v) * width + c] = from.array[(start + v) * width + c];
      }
    });
    trimmed.setAttribute(name, new THREE.BufferAttribute(out, width));
  }
  geometry.dispose();
  return trimmed;
}

/**
 * A material for something laid on top of a surface it shares.
 *
 * **The picture goes on the other way up.** Every texture the mirror publishes
 * is loaded `flipY: false`, because the model's own UVs are stored the way glTF
 * reads them. A decal's UVs are not the model's: they are generated here, in
 * three's own convention, so the texture has to be turned back the right way or
 * an inscription comes out reading backwards.
 */
function stuckOn(source, mirrored = false) {
  const map = source.clone();
  map.flipY = true;
  // **Mirrored where the frame is.** A decal box has to be right-handed, so
  // fixing which way is up forces the sideways axis to flip between a
  // vehicle's two flanks. Left alone that puts the same picture at opposite
  // ends of a gun barrel, and a mark that runs right round it, as the French
  // and British ones do, comes out as a staggered zigzag rather than as rings.
  // Turning the picture over on that side puts the ink back at the same place
  // along the barrel and still leaves it the right way up.
  if (mirrored) {
    map.wrapS = THREE.RepeatWrapping;
    map.repeat.x = -1;
    map.offset.x = 1;
  }
  map.needsUpdate = true;
  return new THREE.MeshStandardMaterial({
    map,
    transparent: true,
    depthWrite: false,
    // A decal shares its surface with the plate under it, so it has to be told
    // which of the two is in front.
    polygonOffset: true,
    polygonOffsetFactor: -4,
    roughness: 0.75,
    metalness: 0,
  });
}

/**
 * The frame an emblem or inscription slot projects in.
 *
 * These carry a ray that starts outside the vehicle and ends inside it, so the
 * ray is the direction to project along and whatever surface it crosses is what
 * gets marked. `rayUp` is which way is up on the picture, which has to be
 * squared against the ray rather than taken as given.
 */
function frameOf(slot) {
  const a = new THREE.Vector3().fromArray(slot.rayStart);
  const b = new THREE.Vector3().fromArray(slot.rayEnd);
  const outward = new THREE.Vector3().subVectors(a, b).normalize();
  const up = new THREE.Vector3().fromArray(slot.rayUp);
  const squared = up.clone().addScaledVector(outward, -up.dot(outward));
  if (squared.lengthSq() < 1e-6) squared.set(0, 1, 0).addScaledVector(outward, -outward.y);
  squared.normalize();
  const across = new THREE.Vector3().crossVectors(squared, outward);
  return {
    at: new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5),
    turn: new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, squared, outward)),
    depth: a.distanceTo(b) * 2,
    outward,
  };
}

/** Which of the four parts a style paints a piece belongs to. */
function partOf(name) {
  if (name.startsWith("Turret")) return "turret";
  if (name.startsWith("Gun")) return "gun";
  if (name.startsWith("Hull")) return "hull";
  return "chassis";
}

/**
 * Weave the detail layer into a standard material.
 *
 * three has no slot for this, so it is patched into the compiled shader: the
 * grain is sampled at the client's tiling and used to push roughness and albedo
 * by the amounts the client asks for, and nothing else about the material
 * changes.
 */
function withDetail(material, values) {
  const tiling = values?.g_detailUVTiling;
  if (!Array.isArray(tiling) || !(values?.g_detailPowerGloss > 0 || values?.g_detailPowerAlbedo > 0)) return material;
  material.userData.detail = {
    map: { value: GRAIN },
    tiling: { value: new THREE.Vector2(tiling[0] || 1, tiling[1] || 1) },
    gloss: { value: values.g_detailPowerGloss ?? 0 },
    albedo: { value: values.g_detailPowerAlbedo ?? 0 },
    // How far the layer carries, in metres. The client calls it
    // `g_detailPower` and gives 7 or 8 for a tank.
    reach: { value: values.g_detailPower || 8 },
  };
  return compile(material);
}

/**
 * The one shader patch, covering everything a client material asks for that
 * three does not do out of the box. There is a single slot for it, so both live
 * here rather than fighting over `onBeforeCompile`.
 *
 * **The normal map's third channel is rebuilt here**, because the mirror does
 * not ship one. The client keeps a normal in two channels and works the third
 * out in its own shader, since it is derivable, and the mirror follows: a
 * channel that carries nothing is a third more data and the one an encoder
 * mangles worst. Rebuilding also renormalises after filtering, which three's
 * default does not.
 *
 * **The detail grain** is the micro-relief every tank material names and no
 * client ships, weighted by the client's own `g_detailPower*` numbers.
 */
function compile(material) {
  // **Every branch below has to be named in the cache key.**
  //
  // three compiles one program per material *configuration* and shares it
  // between every material that hashes the same. That hash is built from the
  // properties three knows about, and `onBeforeCompile` is not one of them, so
  // two materials that differ only in what this function injects are handed the
  // same program. The second one then runs the first one's shader against its
  // own uniforms, and any uniform the first added is simply missing: a sampler
  // reads black and a float reads zero.
  //
  // That is what hid a styled turret. The hull's material alpha-tests and got
  // the cut below, the turret's does not and reused the hull's program, so the
  // turret ran `texture2D( cutMask, uv ).b + cutBias <= cutAgainst` with all
  // three unbound, which is `0 + 0 <= 0`, and discarded every one of its
  // fragments. It drew all frame, cast its shadow, and put nothing on screen.
  //
  // `customProgramCacheKey` is the hook for exactly this, so it names each
  // branch here. Anything added to the patch has to be added to the key too.
  material.customProgramCacheKey = () =>
    [
      material.userData.cut ? "cut" : "nocut",
      material.userData.detail ? "grain" : "nograin",
      material.aoMap ? "ao" : "noao",
      material.userData.camo ? "camo" : "nocamo",
    ].join("/");

  material.onBeforeCompile = (shader) => {
    // Rebuilding the normal's third channel, which the mirror does not ship.
    //
    // **Replace the include, not the line inside it.** `onBeforeCompile` hands
    // over three's own source with every `#include <...>` still unresolved, so a
    // patch aimed at a line that only exists after resolution silently matches
    // nothing. That is what happened here: the rebuild never ran, three read the
    // blue channel as z the whole time, and once the mirror started carrying the
    // client's alpha mask in blue a turret whose mask is zero got `z = -1` and
    // rendered as a black hole in the middle of the vehicle. A `.replace` that
    // finds nothing is silent, so anything patched this way has to be checked by
    // looking for the marker afterwards, not by reading the code and believing
    // it.
    //
    // Two readings of the same two channels, and they are not close. The exact
    // one solves for a unit vector, `z = sqrt(1 - x^2 - y^2)`, which is what the
    // encoding means. The soft one takes `(x, y, 1)`, normalises, halves the
    // slope and normalises again, which is how a Blender import at strength 0.5
    // reads it. `?relief=soft` picks that reading.
    const rebuildZ = SOFT_RELIEF
      ? `vec3 mapN = normalize( vec3( texture2D( normalMap, vNormalMapUv ).xy * 2.0 - 1.0, 1.0 ) );
         mapN = normalize( vec3( mapN.xy * 0.5, mapN.z ) );`
      : `vec3 mapN = vec3( texture2D( normalMap, vNormalMapUv ).xy * 2.0 - 1.0, 0.0 );
         mapN.z = sqrt( max( 0.0, 1.0 - dot( mapN.xy, mapN.xy ) ) );`;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <normal_fragment_maps>",
      `#if defined( USE_NORMALMAP_TANGENTSPACE )
         ${rebuildZ}
         mapN.xy *= normalScale;
         normal = normalize( tbn * mapN );
       #else
         #include <normal_fragment_maps>
       #endif`,
    );

    // Nothing on a tank is a mirror.
    //
    // A perfectly smooth surface concentrates the whole environment into a
    // point, which on a vehicle shows up as a hard white speck that crawls over
    // a plate as the camera moves. The client's own floor is 0.04 and it is
    // there for the same reason.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <roughnessmap_fragment>",
      `#include <roughnessmap_fragment>
       roughnessFactor = max( roughnessFactor, 0.04 );`,
    );

    // The cut, made where the client makes it.
    //
    // A BigWorld material that alpha-tests compares the **normal map's own mask
    // channel** plus `g_maskBias` against `alphaReference`, and discards below
    // it. That is what opens the gaps in a track and the holes in a grille. We
    // had been handing three the diffuse map's alpha, which is a different
    // channel of a different file and only ever right by coincidence. The mirror
    // carries the mask in the normal map's blue, so it costs no extra lookup.
    if (material.userData.cut) {
      const cut = material.userData.cut;
      shader.uniforms.cutMask = { value: material.normalMap };
      shader.uniforms.cutBias = { value: cut.bias };
      shader.uniforms.cutAgainst = { value: cut.against };
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
           uniform sampler2D cutMask;
           uniform float cutBias;
           uniform float cutAgainst;`,
        )
        .replace(
          "#include <alphatest_fragment>",
          `if ( texture2D( cutMask, vNormalMapUv ).b + cutBias <= cutAgainst ) discard;`,
        );
    }

    // The occlusion the client bakes is applied to **all** the light, not just
    // the ambient.
    //
    // three's own `aoMap` only attenuates indirect light, which is right for a
    // physically-argued renderer and wrong for this vehicle: the map is not a
    // subtle crease darkener but the shading itself, averaging 0.40 on a hull
    // and 0.25 on a turret, black in the engine grilles and under every fender.
    // Left on the ambient alone it does almost nothing, and the tank comes out
    // as a pale shell with no depth in it. The game leans on it, which is why
    // its running gear and its deck read as recesses rather than as paint.
    if (material.aoMap) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <opaque_fragment>",
        `float bakedOcclusion = texture2D( aoMap, vAoMapUv ).r;
         // Softened, or the deepest parts of the map go to pure black: it was
         // baked to sit under the game's own ambient, not to replace lighting.
         outgoingLight *= mix( 1.0, pow( bakedOcclusion, 0.7 ), 0.85 );
         #include <opaque_fragment>`,
      );
    }
    // The camouflage a player paints on.
    //
    // The pattern is not a picture: its four channels are **weights**, each
    // saying how much of one of the palette's four colours to lay down, and the
    // client authors them to sum to one. A colour's own alpha is its share, so
    // a palette that leaves one at zero means those areas keep the vehicle's own
    // paint rather than being painted a fourth colour. That is how a winter
    // camouflage puts white patches on a green tank instead of repainting it.
    //
    // Where it may go is the mask the client packs beside the occlusion, which
    // is what keeps paint off the tracks, the tools and the rubber.
    //
    // It is compiled in for every material that has a mask, painted or not, and
    // switched with `camoCover`. Making its presence a shader variant instead
    // would recompile the vehicle on every click for no gain.
    const camo = material.userData.camo;
    if (camo) {
      Object.assign(shader.uniforms, camo);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
           uniform sampler2D camoPattern;
           uniform vec4 camoColors[ 4 ];
           uniform vec4 camoRegionA;
           uniform vec4 camoRegionB;
           uniform vec4 camoRegionC;
           uniform vec4 camoRegionD;
           uniform vec4 camoTiling;
           uniform sampler2D camoIdMap;
           uniform float camoCover;
           uniform float camoTurn;
           uniform float camoBias;
           // **A camouflage is a coat of paint, so it has its own finish.** One
           // gloss and one metal per palette colour, blended by the same
           // weights as the colours, and a map that overrides both per pixel
           // where the camouflage ships one.
           // One gloss and one metal per painted region, indexed the same way
           // the colours are.
           uniform vec4 camoPaintGloss;
           uniform vec4 camoPaintMetal;
           uniform vec4 camoGlossSet;
           uniform vec4 camoMetalSet;
           uniform sampler2D camoGlossMetalMap;
           uniform float camoHasGlossMetal;
           uniform sampler2D camoNormalMap;
           uniform float camoNormalStrength;
           uniform sampler2D camoEmissionMap;
           uniform float camoEmissionPower;`,
        )
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
           // Read again below, where three sets the roughness, the metalness and
           // the normal, so they are declared where all of them can see them.
           float camoOpacity = 0.0;
           float camoGloss = 0.0;
           float camoMetal = 0.0;
           float camoPaintOpacity = 0.0;
           float camoPaintGlossHere = 0.0;
           float camoPaintMetalHere = 0.0;
           vec2 camoUv = vec2( 0.0 );
           if ( camoCover > 0.0 ) {
             // Which of the piece's four regions this pixel belongs to. The
             // client's colour-id map holds them as four flat greys, and the
             // material's own bias shifts the read. **Clamped**, because a
             // region rounds to four wherever the map reaches white and a fifth
             // region does not exist: unclamped it fell off the end of the
             // paint and took the camouflage with it.
             float camoRegion = clamp( floor( texture2D( camoIdMap, vMapUv ).r * 4.0 + 0.5 + camoBias ), 0.0, 3.0 );
             vec4 camoPlain = camoRegionA;
             if ( camoRegion > 2.5 ) camoPlain = camoRegionD;
             else if ( camoRegion > 1.5 ) camoPlain = camoRegionC;
             else if ( camoRegion > 0.5 ) camoPlain = camoRegionB;

             // **The coverage is the occlusion map's red**, read at five times
             // its value the way the client scales it. It says how much of a
             // surface takes customization at all, and it is why a tow cable
             // and a set of tools keep their own look under a style that covers
             // the plates around them, and why a chassis, where it is flat
             // zero, never wears one at all.
             // Guarded, because three only declares the sampler and its UVs for
             // a material that has one, and a material without an occlusion map
             // is a material with nothing to hold customization back.
             #ifdef USE_AOMAP
               float camoRoom = min( texture2D( aoMap, vAoMapUv ).g * 5.0, 1.0 );
             #else
               float camoRoom = 1.0;
             #endif

             // **Paint multiplies the surface at twice its value**, so a mid
             // grey is neutral and the weld, the scratch and the streak the
             // texture holds all survive it. It is not held back by the
             // coverage: a paint the player chose covers the piece, and the
             // mask only governs the pattern laid over it.
             diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * camoPlain.rgb * 2.0, camoPlain.a );
             camoPaintOpacity = camoPlain.a;
             camoPaintGlossHere = camoRegion > 2.5 ? camoPaintGloss.w
                                : camoRegion > 1.5 ? camoPaintGloss.z
                                : camoRegion > 0.5 ? camoPaintGloss.y : camoPaintGloss.x;
             camoPaintMetalHere = camoRegion > 2.5 ? camoPaintMetal.w
                                : camoRegion > 1.5 ? camoPaintMetal.z
                                : camoRegion > 0.5 ? camoPaintMetal.y : camoPaintMetal.x;

             // The pattern is turned on the tiled coordinate, so the whole lay
             // turns rather than each tile. It is what runs a camouflage
             // diagonally across a hull instead of square to its UVs, and it is
             // carried by 1902 of the client's 3264 camouflages.
             float camoCos = cos( camoTurn );
             float camoSin = sin( camoTurn );
             camoUv = mat2( camoCos, camoSin, -camoSin, camoCos ) * ( vMapUv * camoTiling.xy + camoTiling.zw );
             vec4 camoWeight = texture2D( camoPattern, camoUv );
             camoWeight *= vec4( camoColors[ 0 ].a, camoColors[ 1 ].a, camoColors[ 2 ].a, camoColors[ 3 ].a );
             vec3 pattern = camoColors[ 0 ].rgb * camoWeight.x + camoColors[ 1 ].rgb * camoWeight.y
                          + camoColors[ 2 ].rgb * camoWeight.z + camoColors[ 3 ].rgb * camoWeight.w;
             float camoTotal = dot( camoWeight, vec4( 1.0 ) );
             // **The sum is the opacity, the average is the colour.** Dividing
             // separates the two: a palette that leaves a slot at zero drops
             // its share of the surface back to the paint underneath rather
             // than darkening the whole piece toward black, which is what a
             // plain weighted sum does to every winter camouflage.
             camoOpacity = min( camoTotal, 1.0 ) * camoRoom * camoCover;
             diffuseColor.rgb = mix( diffuseColor.rgb, pattern / max( camoTotal, 0.0001 ), camoOpacity );

             // The finish blends by the same weights as the colour, so a
             // pattern that puts a lacquered red beside a matt black gets both.
             camoGloss = dot( camoGlossSet, camoWeight ) / max( camoTotal, 0.0001 );
             camoMetal = dot( camoMetalSet, camoWeight ) / max( camoTotal, 0.0001 );
             if ( camoHasGlossMetal > 0.0 ) {
               // The mirror rewrites the client's gloss-metal into the layout
               // three samples, roughness in green and metal in blue, so this
               // reads the same channels a vehicle's own map is read on.
               vec3 camoSurface = texture2D( camoGlossMetalMap, camoUv ).rgb;
               camoGloss = 1.0 - camoSurface.g;
               camoMetal = camoSurface.b;
             }
           }`,
        )
        // Where the coat is laid it brings its own finish, so the vehicle's
        // roughness and metalness give way to it in proportion.
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
           roughnessFactor = mix( roughnessFactor, 1.0 - camoPaintGlossHere, camoPaintOpacity );
           roughnessFactor = mix( roughnessFactor, 1.0 - camoGloss, camoOpacity );`,
        )
        .replace(
          "#include <metalnessmap_fragment>",
          `#include <metalnessmap_fragment>
           metalnessFactor = mix( metalnessFactor, camoPaintMetalHere, camoPaintOpacity );
           metalnessFactor = mix( metalnessFactor, camoMetal, camoOpacity );`,
        )
        // A relief of its own, on the 22 camouflages that carry one. Guarded on
        // the tangent frame, which three only builds for a material that has a
        // normal map of its own to put in it.
        .replace(
          "#include <normal_fragment_maps>",
          `#include <normal_fragment_maps>
           #ifdef USE_NORMALMAP_TANGENTSPACE
             if ( camoNormalStrength > 0.0 && camoOpacity > 0.0 ) {
               vec3 camoRelief = texture2D( camoNormalMap, camoUv ).xyz * 2.0 - 1.0;
               float reliefCos = cos( camoTurn );
               float reliefSin = sin( camoTurn );
               camoRelief.xy = mat2( reliefCos, reliefSin, -reliefSin, reliefCos ) * camoRelief.xy * camoNormalStrength;
               normal = normalize( mix( normal, normalize( tbn * camoRelief ), camoOpacity ) );
             }
           #endif`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
           if ( camoEmissionPower > 0.0 ) {
             totalEmissiveRadiance += texture2D( camoEmissionMap, camoUv ).rgb * camoEmissionPower * camoOpacity;
           }`,
        );
    }

    const detail = material.userData.detail;
    if (!detail) return;
    Object.assign(shader.uniforms, {
      detailMap: detail.map,
      detailTiling: detail.tiling,
      detailGloss: detail.gloss,
      detailAlbedo: detail.albedo,
      detailReach: detail.reach,
    });
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform sampler2D detailMap;
         uniform vec2 detailTiling;
         uniform float detailGloss;
         uniform float detailAlbedo;
         uniform float detailReach;
         // The layer is a surface finish, not a pattern: it belongs at arm's
         // length and nowhere else. Held back by distance it reads as metal up
         // close and disappears before it can turn a hull into sandpaper, which
         // is what a grain tiled eight times across a panel does when a viewer
         // draws it at every range alike.
         float detailFade() {
           float away = length(vViewPosition) / max(detailReach, 0.001);
           return clamp(1.0 - away * away, 0.0, 1.0);
         }`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
         float detail = (texture2D(detailMap, vMapUv * detailTiling).r - 0.5) * detailFade();
         roughnessFactor = clamp(roughnessFactor + detail * detailGloss, 0.04, 1.0);`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
         diffuseColor.rgb *= 1.0 + (texture2D(detailMap, vMapUv * detailTiling).r - 0.5) * detailAlbedo * detailFade();`,
      );
  };
  return material;
}

/**
 * What the paint has to reflect.
 *
 * The game's own shader is `NormalsGGXRough` over an `EnvBRDFLut`: GGX with a
 * split-sum environment, which is what three does too. So the model is not the
 * difference between its look and ours — what is reflected is. A tank's shell
 * is a wide, gently curved, fairly smooth surface, and on that kind of surface
 * almost everything the eye reads as "metal" is a reflection of something
 * bright and shaped. An evenly lit room reflects as a flat sheen and the hull
 * goes dead.
 *
 * So this is a hangar rather than a room: a dark shell, a bright sky above, a
 * dim floor below, and long strip lights overhead whose reflections travel
 * along the hull as it turns.
 */
function hangar() {
  const room = new THREE.Scene();

  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(12, 24, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      // Sky to horizon to floor, the horizon kept bright: it is the band a
      // curved flank actually reflects when the camera sits at eye level.
      fragmentShader: `
        varying vec3 vDir;
        void main() {
          float up = normalize(vDir).y;
          // Cool from above, warm from below. The ground tone is not decoration:
          // the underside of a hull and the whole run of a track see almost
          // nothing but the floor, so its colour is the colour they come out.
          // A near-black floor is what left ours a flat neutral grey where the
          // game has warm, rusted steel.
          // Near neutral, and that is the point. Measured against a capture of
          // the game itself, a warm shell and a warm key push a vehicle well
          // past what the game shows: the game's IS-7 measures 0.177 mean
          // saturation and our warmed rig gave 0.331, nearly double. The colour
          // in the game's tank is in its **paint**, not in its lamps, and the
          // proof is that neutral white light on these textures still comes out
          // at the game's own warmth of R-B 18.
          // **Dark shell, bright lamps.** The gradient is the part of the room
          // that reflects as a flat wash, and the panels are the part that
          // reflects as shape. Once the environment carries the lighting at 2.8
          // rather than 0.6, a shell this bright stops being a room and becomes
          // a fog: the first attempt at the new ratio kept these at 0.50 and
          // the tank came out pale and chalky. Divided by three the ambient
          // lands about where it did before while the lamps reflect nearly five
          // times harder, which is the whole point of the change.
          vec3 sky = vec3(0.17, 0.18, 0.20);
          vec3 horizon = vec3(0.23, 0.21, 0.19);
          vec3 floorTone = vec3(0.14, 0.12, 0.09);
          vec3 tint = up > 0.0 ? mix(horizon, sky, pow(up, 0.55)) : mix(horizon, floorTone, pow(-up, 0.5));
          gl_FragColor = vec4(tint, 1.0);
        }
      `,
    }),
  );
  room.add(shell);

  // What the shell cannot give: shape.
  //
  // A gradient reflects as a gradient, which is why a smooth flank came out as
  // one clean sheet of light however the tones were tuned. Paint reads as paint
  // when the room it stands in has edges in it: banks of light overhead, panels
  // of different brightness down the walls, dark between them. These are what
  // travel across a hull as the camera moves, and they are the difference
  // between a lit object and a photographed one.
  const panel = (colour, width, height, place, turn) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ color: colour, side: THREE.DoubleSide }),
    );
    mesh.position.set(...place);
    if (turn) mesh.rotation.set(...turn);
    room.add(mesh);
    return mesh;
  };

  // Overhead: two banks either side of the vehicle and one across the back, the
  // long thin shape a hangar fitting actually has.
  for (const [x, z, length] of [[-3.6, 0, 14], [3.6, 0, 14], [0, -5.5, 9], [0, 5.5, 9]]) {
    panel(0xffffff, 0.7, length, [x, 7.5, z], [Math.PI / 2, 0, 0]);
  }
  // A second, dimmer tier further out, so a highlight has somewhere to fade to
  // rather than ending at the edge of the first.
  for (const [x, z] of [[-6.5, -3], [6.5, -3], [-6.5, 3], [6.5, 3]]) {
    panel(0x6e747c, 2.4, 6, [x, 7.2, z], [Math.PI / 2, 0, 0]);
  }

  // The walls, unequal on purpose: a room lit the same on both sides gives a
  // vehicle two identical flanks and no sense of where it is standing.
  panel(0xb8a894, 4, 10, [-7.5, 1.9, 2], [0, Math.PI / 2, 0]);
  panel(0x555c66, 4.5, 12, [-7.6, 4.4, -2], [0, Math.PI / 2, 0]);
  panel(0x8f8578, 3.2, 9, [7.5, 2.2, -1], [0, Math.PI / 2, 0]);
  panel(0x3a4048, 5, 11, [7.6, 5, 3], [0, Math.PI / 2, 0]);
  // The far end, dim, so a nose or a tail turned away still has an edge.
  panel(0x4a525c, 12, 5, [0, 3, -9], [0, 0, 0]);

  return room;
}

/**
 * Build the textured vehicle into the groups the armour views already place.
 *
 * `mounts` are those groups: sharing them is what keeps the turret pointing the
 * same way when a player switches view, rather than snapping back to straight
 * ahead as though it were a different tank.
 */
export async function loadVisual({ renderer, scene, root, vehicle, mounts, definition = "hd", fresh = (u) => u }) {
  const model = await (await fetch(fresh(`${root}/vehicles/${vehicle}/model.json`))).json();
  const loader = new GLTFLoader();

  const loaded = new Map();
  const textures = new THREE.TextureLoader();
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  const materials = [];
  // The client ships each texture twice, the second at twice the side. Which of
  // the pair a material samples is the only difference between the two
  // definitions: the mesh, the layout and the UVs are one and the same.
  const choose = (entry) => (definition === "hd" && entry.hd ? entry.hd : entry.path);
  function texture(entry) {
    if (!entry) return null;
    const at = choose(entry);
    if (!loaded.has(at)) {
      const map = textures.load(fresh(`${root}/${at}`));
      // The mirror stores UVs the way glTF reads them, top down.
      map.flipY = false;
      // A track's UVs run to 30 so its texture repeats along the run. three
      // clamps by default, which smears the edge pixel over the whole belt
      // instead of drawing the links.
      map.wrapS = THREE.RepeatWrapping;
      map.wrapT = THREE.RepeatWrapping;
      map.colorSpace = entry.colorSpace === "srgb" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      // As sharp as the card allows at a grazing angle, which is most of a
      // track's run and most of a hull's flank.
      map.anisotropy = maxAnisotropy;
      loaded.set(at, map);
    }
    return loaded.get(at);
  }

  /**
   * Every material that can take paint, with the part it belongs to.
   *
   * A style paints per part: a camouflage usually covers the hull, the turret
   * and the gun while a paint underneath it reaches the running gear too, so
   * knowing only that a material can be painted is not enough.
   */
  const painted = [];
  /** Which piece is being read, so its materials can be filed under it. */
  let part = "hull";
  let owner = "";
  /** The meshes each piece drew with, for anything projected onto them. */
  const surfaces = new Map();
  /** The marks the style being worn brings, if it brings any of its own. */
  let worn = [];
  /** How many marks are on the gun, so a change of style can put them back. */
  let showing = 0;
  /** What is projected onto the vehicle, kept so it can come off again. */
  const marked = [];
  const stuck = [];
  const strip = (list) => {
    for (const decal of list) {
      decal.parent?.remove(decal);
      decal.geometry.dispose();
    }
    list.length = 0;
  };

  // Whether this build of the mirror packs the client's alpha mask in the
  // normal map's blue. An older one leaves that channel at zero, and cutting
  // against it would discard every pixel of every track.
  const masked = (model.features ?? []).includes("normal-mask");

  function material(spec) {
    const maps = spec?.textures ?? {};
    materials.push({ spec, maps });
    // The mirror already rewrites the client's gloss-metal texture into the
    // metal-roughness layout, so it is sampled straight.
    const surface = texture(maps.metallicGlossMap);
    const built = new THREE.MeshStandardMaterial({
      map: texture(maps.diffuseMap),
      normalMap: texture(maps.normalMap),
      aoMap: texture(maps.excludeMaskAndAOMap),
      roughnessMap: surface,
      metalnessMap: surface,
      // Without these a track draws as a solid ribbon: its gaps are cut by an
      // alpha test, and its far side only exists when both are drawn.
      // What the client says, which is single-sided for a hull or a turret and
      // both for a track: a belt's far side only exists when both are drawn.
      side: spec?.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      // Only where the mirror does not carry the client's own mask. Where it
      // does, the cut is made in the shader instead and this must be off, or
      // the two tests fight and the track loses either its gaps or its links.
      alphaTest: masked ? 0 : spec?.alphaTest ?? 0,
      roughness: 1,
      metalness: 1,
      // The client's gloss is perceptual, which is the scale three's roughness
      // map is on too, so the map goes in as it is and the environment carries
      // the rest.
      envMapIntensity: 1.35,
    });
    // What the client says about cutting this material, if it says anything.
    // `alphaReference` arrives as a byte, the way the client writes it.
    // Only a material the client gave a mask takes paint, which is the right
    // answer on its own: a decal sheet or a track has none and so stays as it
    // is, exactly as it does in the game.
    // **The belt is not painted.** The running gear takes a style, the track
    // links do not: they are bare steel that has been dragged through the
    // ground, and the game leaves them that way. They come in as a piece of
    // their own, so this is where they are held back.
    if ((maps.colorIdMap || maps.diffuseMap) && owner !== model.tracks?.segment) {
      built.userData.camo = {
        camoTurn: { value: 0 },
        // Always a real texture. An unbound sampler reads black, and a shader
        // that samples one is not obviously broken until something disappears.
        camoPattern: { value: BLANK },
        camoTiling: { value: new THREE.Vector4(1, 1, 0, 0) },
        camoColors: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 0, 0)) },
        // What each of the piece's four regions is repainted, alpha carrying
        // whether it is repainted at all.
        camoRegionA: { value: new THREE.Vector4(0, 0, 0, 0) },
        camoRegionB: { value: new THREE.Vector4(0, 0, 0, 0) },
        camoRegionC: { value: new THREE.Vector4(0, 0, 0, 0) },
        camoRegionD: { value: new THREE.Vector4(0, 0, 0, 0) },
        // Where the four regions are, as four flat greys. A piece with no map
        // of its own reads black and is region zero throughout.
        camoIdMap: { value: texture(maps.colorIdMap) ?? BLANK },
        // What the material shifts that read by, which a handful of them do.
        camoBias: { value: spec?.values?.g_maskBias ?? 0 },
        // The finish, one value per palette colour. The client's own defaults
        // stand in for the camouflages that name neither, which is most of them.
        camoPaintGloss: { value: new THREE.Vector4(0.509, 0.509, 0.509, 0.509) },
        camoPaintMetal: { value: new THREE.Vector4(0.23, 0.23, 0.23, 0.23) },
        camoGlossSet: { value: new THREE.Vector4(0.509, 0.509, 0.509, 0.509) },
        camoMetalSet: { value: new THREE.Vector4(0.23, 0.23, 0.23, 0.23) },
        camoGlossMetalMap: { value: BLANK },
        camoHasGlossMetal: { value: 0 },
        camoNormalMap: { value: FLAT },
        camoNormalStrength: { value: 0 },
        camoEmissionMap: { value: BLANK },
        camoEmissionPower: { value: 0 },
        camoCover: { value: 0 },
      };
      painted.push({ uniforms: built.userData.camo, part, piece: owner });
    }

    const values = spec?.values ?? {};
    if (masked && values.alphaTestEnable && built.normalMap) {
      const against = values.alphaReference > 1 ? values.alphaReference / 255 : values.alphaReference ?? 0.5;
      built.userData.cut = { bias: values.g_maskBias ?? 0, against };
      built.transparent = false;
    }
    materials[materials.length - 1].built = built;
    return compile(withDetail(built, spec?.values));
  }

  // A vehicle ships several turrets and guns, one per module a player can
  // mount. Only the first of each is shown, the way a stock loadout looks.
  const names = Object.keys(model.pieces).sort();
  const first = (prefix) => names.find((n) => n.startsWith(prefix));
  const pieces = [first("Hull"), first("Chassis"), first("Turret"), first("Gun")].filter(Boolean);

  const parts = [];
  let triangles = 0;
  const parentFor = (name) => {
    if (name.startsWith("Chassis") || name.startsWith("Wheel")) return mounts.scene;
    if (name === first("Turret")) return mounts.turret;
    if (name === first("Gun")) return mounts.gun;
    return mounts.hull;
  };

  for (const name of pieces) {
    const piece = model.pieces[name];
    part = partOf(name);
    owner = name;
    const gltf = await loader.loadAsync(fresh(`${root}/vehicles/${vehicle}/${piece.glb}`));
    // A mesh drawn with several materials arrives as several meshes, so the
    // manifest's per-mesh lists are flattened into the same order.
    const order = piece.meshes.flatMap((m) => m.materials);
    let index = 0;
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.material = material(model.materials[order[index++] ?? -1]);
      o.castShadow = true;
      o.receiveShadow = true;
      // Occlusion samples the second UV set where the client ships one, and
      // falls back to the first where it does not.
      if (!o.geometry.getAttribute("uv1")) o.geometry.setAttribute("uv1", o.geometry.getAttribute("uv"));
      triangles += o.geometry.index.count / 3;
    });
    parentFor(name).add(gltf.scene);
    parts.push(gltf.scene);
    // Kept by piece, because a mark is placed on the piece the client hangs its
    // slot off rather than anywhere on the vehicle.
    const meshes = [];
    gltf.scene.traverse((o) => o.isMesh && meshes.push(o));
    surfaces.set(name, meshes);
  }

  // The real track: one link repeated along the path the client ships.
  const belts = [];
  let links = 0;
  if (model.tracks && model.pieces[model.tracks.segment]) {
    const segment = model.pieces[model.tracks.segment];
    part = "chassis";
    owner = model.tracks.segment;
    const gltf = await loader.loadAsync(fresh(`${root}/vehicles/${vehicle}/${segment.glb}`));
    const source = [];
    gltf.scene.traverse((o) => o.isMesh && source.push(o));
    const order = segment.meshes.flatMap((m) => m.materials);
    source.forEach((o, i) => {
      if (!o.geometry.getAttribute("uv1")) o.geometry.setAttribute("uv1", o.geometry.getAttribute("uv"));
      o.geometry.computeBoundingBox();
      const length = o.geometry.boundingBox.max.z - o.geometry.boundingBox.min.z;
      for (const path of Object.values(model.tracks.paths)) {
        const laid = layTrack(o.geometry, material(model.materials[order[i] ?? -1]), path, length);
        laid.mesh.castShadow = true;
        laid.mesh.receiveShadow = true;
        mounts.scene.add(laid.mesh);
        parts.push(laid.mesh);
        belts.push(laid);
        links += laid.count;
        triangles += (o.geometry.index.count / 3) * laid.count;
      }
    });
    for (const part of parts) part.traverse((o) => { if (o.isMesh && RIBBON.test(o.name)) o.visible = false; });
  }

  // Turning the road wheels is what the skeleton in the .glb is there for.
  //
  // The bone a wheel is skinned to sits at the origin, so turning it on its own
  // spins the wheel around the middle of the tank. The mirror publishes where
  // each axle really is and how wide the wheel is around it, both read from the
  // wheel's own vertices, and the turn is made about that point: move to the
  // axle, rotate, move back.
  const bones = new Map();
  for (const part of parts) part.traverse((o) => { if (o.isBone) bones.set(o.name, o); });
  const wheels = [];
  for (const wheel of model.wheels ?? []) {
    const bone = bones.get(wheel.bone);
    if (!bone) continue;
    wheels.push({
      bone,
      axle: new THREE.Vector3().fromArray(wheel.axle),
      // The client's bones carry a flip of Z, and the bind undoes it, so the
      // rest transform is not the identity. The turn has to be applied in the
      // piece's space, which means in front of it rather than after it.
      rest: bone.matrix.clone(),
      // The rim travels with the belt, so a metre of belt is a metre of rim and
      // the angle that buys is the metre over the radius.
      radius: Math.max(0.05, wheel.radius ?? 0.05),
    });
  }

  // Lit like a hangar, and only while this view is the one on screen: the
  // armour views draw their own answers and an environment map would wash them.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(hangar(), 0.02).texture;
  const lights = new THREE.Group();
  // **The environment carries the light, and the lamps only shape it.**
  //
  // We had it the other way round: a key at 8, an environment at 0.6 and an
  // exposure of 2.1. That is a lot of white light thrown at a tank, and it
  // reads exactly as it sounds, flat and cold and too bright. Inverting the
  // ratio is what fixes it, and the whole difference is in four numbers: the
  // environment does 2.8 against the old 0.6, the lamps are a third of the
  // strength, and the exposure is 1.42 rather than 2.1. What brightness costs
  // there it buys back in reflection, which is what a painted steel surface
  // actually does with light.
  //
  // The colours matter as much. Their key is a warm peach and their fill a warm
  // cream, with a single cool rim to separate the silhouette. Ours were all
  // within a hair of white, and white light on grey-green paint is the look of
  // a render rather than of a tank in a hangar.
  //
  // Sky and ground, with the ground the warm brown a hangar floor is.
  lights.add(new THREE.HemisphereLight(0xd9ecff, 0x9b8065, 1.45));
  const key = new THREE.DirectionalLight(0xffd39f, 2.6);
  key.position.set(5.5, 3.6, 4.5);
  // Shadows are what stops a tank floating over the grid, and they do as much
  // for the shape as the textures do: without them a gun casts nothing on the
  // hull, a fender casts nothing on the track, and every recess reads as paint
  // rather than as a recess.
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -8;
  key.shadow.camera.right = 8;
  key.shadow.camera.top = 8;
  key.shadow.camera.bottom = -8;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  // A shallow bias, since the surfaces casting on each other are millimetres
  // apart in places: too much and a gun stops shadowing its own mantlet.
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.02;
  lights.add(key);

  // The ground takes the shadow without being drawn itself, so the grid still
  // shows through and nothing is added to the scene that the tank is not.
  const shadowCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.ShadowMaterial({ opacity: 0.45 }),
  );
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.receiveShadow = true;
  lights.add(shadowCatcher);
  // Warm, and opposite the key. Both lamps on the warm side and one cool rim
  // is what gives the paint its temperature: a fill that is merely white flattens
  // the shadowed side into grey.
  const fill = new THREE.DirectionalLight(0xffe0b8, 1.85);
  fill.position.set(-4.8, 2.8, -4.2);
  lights.add(fill);

  // A rim, from behind and above, opposite the key.
  //
  // The one light in a studio rig that is not there to reveal a surface: it
  // catches the edge where the vehicle turns away, and that bright line is what
  // separates a dark hull from a dark background. Without it an object sits on
  // a backdrop; with it, it stands in front of one. It is the light the rig was
  // missing.
  const rim = new THREE.DirectionalLight(0x9fc7ff, 1.75);
  rim.position.set(-4.6, 3.4, 4.6);
  lights.add(rim);

  // One lamp hung over the tank, close enough for its falloff to show.
  //
  // The only light in the rig that is not at infinity, so it is the only one
  // whose brightness changes along the hull. That gradient is what stops a long
  // flat deck reading as one painted sheet.
  const overhead = new THREE.PointLight(0xcfe4ff, 48, 8);
  overhead.position.set(0, 5.8, 0.7);
  lights.add(overhead);
  // High, and the exposure brought down to pay for it.
  //
  // Raising this on its own does wash a surface out, which is what an earlier
  // pass here concluded and why it sat at 0.6. The conclusion was half of one:
  // the environment can carry the light as long as the exposure comes down with
  // it, and then it stops being a wash and starts being reflection. Held
  // together the two numbers are what a painted steel plate looks like.
  scene.environmentIntensity = 2.8;
  scene.add(lights);

  /**
   * How big a camouflage is laid on one piece, and where its pattern starts.
   *
   * **The client has two paths and they are not variants of one formula.** A
   * camouflage that carries a tiling tuned by hand for this vehicle uses it,
   * multiplied by the piece's own coefficient. One that does not is computed
   * from its factor, the pattern's own pixel size, the vehicle's length and the
   * piece's density, and the hand-tuned coefficient plays no part.
   *
   * Reading the second kind's factor as if it were the first kind's tiling is
   * what put "Come Get Some!" at the wrong size, and no amount of arguing about
   * whether the piece coefficient multiplies or divides could have fixed it:
   * that coefficient was not in the formula at all.
   */
  function layOut(camouflage, piece) {
    const own = model.camouflage?.[piece];
    if (camouflage.tiling) {
      const [u, v, du, dv] = camouflage.tiling;
      const coefficient = own?.tiling;
      return new THREE.Vector4(
        u * (coefficient?.[0] ?? 1),
        v * (coefficient?.[1] ?? 1),
        du + (coefficient?.[2] ?? 0),
        dv + (coefficient?.[3] ?? 0),
      );
    }
    const [width, height] = camouflage.size ?? [512, 512];
    const [factorU, factorV] = camouflage.factor ?? [1, 1];
    const [densityU, densityV] = own?.density ?? [1, 1];
    const [aoU, aoV] = own?.aoTextureSize ?? [width, height];
    const [stretchU, stretchV] = model.camouflageDensity ?? [1, 1];
    const absolute = camouflage.tilingType === "absolute";
    // `relativeWithFactor` also takes the vehicle's own stretch; plain
    // `relative` does not.
    const withFactor = camouflage.tilingType === "relativewithfactor";
    const length = vehicleLength();
    const along = absolute ? factorU : ((width * factorU) / length) * (withFactor ? stretchU : 1);
    const around = absolute ? factorV : ((height * factorV) / length) * (withFactor ? stretchV : 1);
    const scale = camouflage.scale ?? 1;
    return new THREE.Vector4(
      ((aoU / width) * along * scale) / (densityU || 1),
      ((aoV / height) * around * scale) / (densityV || 1),
      camouflage.offset?.[0] ?? 0,
      camouflage.offset?.[1] ?? 0,
    );
  }

  /**
   * How long the vehicle is, which the computed tiling divides by so a pattern
   * reads at the same size on a scout and on a heavy. Measured off the body
   * rather than the gun: a barrel is not what a camouflage is scaled against.
   */
  let measured = 0;
  function vehicleLength() {
    if (measured > 0) return measured;
    const box = new THREE.Box3();
    for (const name of [first("Hull"), first("Chassis")]) {
      for (const mesh of surfaces.get(name) ?? []) box.expandByObject(mesh);
    }
    measured = Math.max(1, box.max.z - box.min.z);
    return measured;
  }

  /**
   * The decals a style projects into the vehicle's own projection slots.
   *
   * These are not placed by casting a ray like an emblem: the slot carries a
   * box, a position, a turn and a size, and the item says which slots it may go
   * in by naming their tags. `safe left formfactor_square` picks out one place
   * on a vehicle and no other, so matching is a subset test and nothing more.
   */
  async function projected(outfit) {
    // The slot is in the vehicle's space and has to be brought into the mesh's,
    // which means the mesh has to know where it is. A style can go on before
    // anything has been drawn, and an un-updated world matrix reads as the
    // identity: the decal then lands at the vehicle's origin, inside the hull,
    // and clips against nothing.
    scene.updateMatrixWorld(true);
    for (const decal of outfit?.projected ?? []) {
      const map = await whenLoaded(texture({ path: decal.texture, colorSpace: "srgb" }));
      const material = stuckOn(map);
      for (const [piece, slots] of Object.entries(model.slots ?? {})) {
        for (const slot of slots) {
          if (slot.kind !== "projectionDecal" || !slot.position || !slot.scale) continue;
          if (slot.model || !decal.tags.every((tag) => slot.tags?.includes(tag))) continue;
          // **A projection slot is given in the vehicle's space, not the
          // piece's.** An emblem slot is piece-local, and reading these the same
          // way put the turret's decals in the air above its roof: their heights
          // are measured from the ground, so a turret slot at 1.91 is low on its
          // flank rather than up at its cupola.
          //
          // **Its rotation names two axes rather than orienting a box**, and it
          // is read in YXZ: the normal is its own -Y and the up is its own -Z.
          // Each is mirrored on its own afterwards, which is not the same as
          // mirroring the three angles and then rotating.
          const frame = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(...(slot.rotation ?? [0, 0, 0]), "YXZ"),
          );
          const outward = new THREE.Vector3(0, -1, 0).applyQuaternion(frame);
          const upright = new THREE.Vector3(0, 0, -1).applyQuaternion(frame);
          outward.x *= -1;
          upright.x *= -1;
          // **The picture is X by Z and the thickness is Y**, and the size the
          // style asks for scales the picture alone. `scaleFactorId` counts from
          // one, which is why the client's own default is 3 for a list of three:
          // taking it as an index left every decal a quarter too big.
          const [wide, thick, tall] = slot.scale;
          const size = new THREE.Vector3(wide * decal.scale, tall * decal.scale, thick);
          for (const mesh of surfaces.get(piece) ?? []) {
            const toMesh = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
            const at = new THREE.Vector3().fromArray(slot.position).applyMatrix4(toMesh);
            const normal = outward.clone().transformDirection(toMesh).normalize();
            const up = upright.clone().transformDirection(toMesh).normalize();
            const right = new THREE.Vector3().crossVectors(up, normal);
            const turn = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, normal));
            const laid = project(mesh, at, turn, size, material, normal);
            if (laid) stuck.push(laid);
          }
        }
      }
    }
  }

  /**
   * The stickers and the lettering a style carries.
   *
   * These are not painted on: the vehicle carries slots for them, and which one
   * a decal lands in comes from what it is rather than from where it is
   * pointed. The client keeps emblem slots and inscription slots apart on every
   * piece, so an emblem goes in an emblem slot and a line of lettering goes in
   * an inscription slot, on whichever pieces the style names.
   */
  async function sticker(outfit) {
    strip(stuck);
    await projected(outfit);
    for (const decal of outfit?.decals ?? []) {
      const map = await whenLoaded(texture({ path: decal.texture, colorSpace: "srgb" }));
      const material = stuckOn(map);
      const wanted = decal.kind === "inscription" ? ["inscription"] : ["player", "clan"];
      for (const [piece, slots] of Object.entries(model.slots ?? {})) {
        // A decal lands in a slot rather than on a region, so what matters is
        // only whether the style names this piece at all.
        if (!decal.regions[partOf(piece)]) continue;
        for (const slot of slots) {
          if (!wanted.includes(slot.kind) || !slot.rayStart || !slot.rayEnd || !slot.rayUp) continue;
          // A slot that belongs to one 3D style is not a slot on the vehicle.
          if (slot.model) continue;
          const { at, turn, depth, outward } = frameOf(slot);
          const tall = (slot.size * map.image.height) / map.image.width;
          const size = new THREE.Vector3(slot.size, tall, Math.max(depth, slot.size));
          for (const mesh of surfaces.get(piece) ?? []) {
            const laid = project(mesh, at, turn, size, material, outward);
            if (laid) stuck.push(laid);
          }
        }
      }
    }
  }

  const turn = new THREE.Matrix4();
  const toAxle = new THREE.Matrix4();
  const fromAxle = new THREE.Matrix4();

  return {
    triangles,
    links,
    pieces,
    /** The 3D styles this vehicle ships, by the name the client gives each. */
    skins: model.skins ?? [],
    /** How many marks of excellence the client has a texture for here. */
    marksAvailable: (model.marks ?? []).length,
    /**
     * Put marks of excellence on the gun, or take them off with 0.
     *
     * The client does not draw these into a texture: it hangs an
     * `insigniaOnGun` slot off the gun and projects the mark onto whatever
     * surface is there, which is how one mark fits every barrel it is offered
     * on. So this projects too, onto the gun's own mesh, one on each side.
     */
    async mark(count) {
      strip(marked);
      showing = count;
      // A style can bring its own marks. The slot on the gun is the vehicle's
      // either way, so only the picture changes.
      const set = worn.length > 0 ? worn : (model.marks ?? []);
      const at = set[Math.min(count, set.length) - 1];
      if (!count || !at) return;
      const gun = first("Gun");
      const slot = (model.slots?.[gun] ?? []).find((s) => s.kind === "insigniaOnGun");
      if (!slot?.rayStart || !slot.rayEnd || !slot.rayUp) return;

      const map = await whenLoaded(texture({ path: at, colorSpace: "srgb" }));
      // **The height comes from the barrel, not from the slot's length.**
      //
      // A mark wraps the same arc of every gun it goes on, so its height has to
      // follow the tube's radius. Taking it from the slot's own length instead
      // holds on the IS-7 by luck, its barrel being thick, and turns the mark
      // into a band right round a thin one: the Panhard EBR's is 0.106 across
      // against a 0.7 box. Four radii is what the IS-7 already reads at, so it
      // keeps that and fixes the rest.
      // One per flank: the frame is mirrored on one of them, so the picture is
      // turned over there to land at the same place along the barrel.
      const painted = { 1: stuckOn(map), "-1": stuckOn(map, true) };

      // **A gun slot is not an emblem slot.** It carries no projection ray:
      // its ray runs along the barrel and says where the mark sits and how long
      // it is, and `rayUp` is the offset out to the barrel's own surface.
      const a = new THREE.Vector3().fromArray(slot.rayStart);
      const b = new THREE.Vector3().fromArray(slot.rayEnd);
      const up = new THREE.Vector3().fromArray(slot.rayUp);
      // **`rayStart` is the anchor, not one end of a span.**
      //
      // The ray's own length is 0.683 on this vehicle and so is `size`, and a
      // slot that carried both would be saying the same thing twice. Reading
      // the segment as the mark's extent put it half a size too far towards the
      // muzzle against the game. So the ray gives a point and a direction, the
      // size gives the length, and the mark is centred on the point.
      const middle = a.clone();
      const along = new THREE.Vector3().subVectors(b, a).normalize();
      const reach = up.length();
      // **The height comes from the barrel, not from the slot's length.**
      //
      // A mark wraps the same arc of every gun it goes on, so its height has to
      // follow the tube's radius. Taking it from the slot's own length instead
      // holds on the IS-7 by luck, its barrel being thick, and turns the mark
      // into a band right round a thin one: the Panhard EBR's is 0.106 across
      // against a 0.7 box. Four radii is what the IS-7 already reads at, so it
      // keeps that and fixes the rest.
      const tall = reach * 4;
      // Both flanks. The client carries one slot and puts the mark on either
      // side of the barrel, which is how it reads from wherever you stand.
      for (const side of [1, -1]) {
        const facing = up.clone().normalize().multiplyScalar(side);
        const on = middle.clone().add(facing.clone().multiplyScalar(reach));
        // **Up is up on both flanks.** Taking the barrel's own axis as the
        // decal's sideways and letting the third vector fall out of the other
        // two gives a frame that is upright on one flank and upside down on the
        // other, which on a star reads as a mark printed backwards. So up is
        // fixed and it is sideways that follows, which flips with the side and
        // is exactly what makes the mark read the same way round from either
        // side of the tank.
        const upright = new THREE.Vector3(0, 1, 0).addScaledVector(facing, -facing.y);
        if (upright.lengthSq() < 1e-6) upright.copy(along);
        upright.normalize();
        const across = new THREE.Vector3().crossVectors(upright, facing);
        const turn = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, upright, facing));
        // Sideways is along the barrel now, so the mark's own width is the
        // slot's size and its height is what its picture asks for.
        const size = new THREE.Vector3(slot.size, tall, reach * 2.2);
        for (const mesh of surfaces.get(gun) ?? []) {
          const decal = project(mesh, on, turn, size, painted[side], facing);
          if (decal) marked.push(decal);
        }
      }
    },
    /** Where the vehicle's 2D styles are listed, when it has any. */
    styles: model.styles ?? null,
    /**
     * Put a 2D style on, or take it off with `null`.
     *
     * A style is a recipe rather than a picture: a camouflage on some parts, a
     * paint on others, each with its own colours. So it is read part by part,
     * the camouflage first where it reaches and the paint under it everywhere
     * else. Nothing recompiles: every material that can take paint was built
     * able to, so a click is a handful of uniforms.
     */
    async wear(style, season) {
      const outfit = style
        ? style.outfits.find((o) => o.season === season) ?? style.outfits[0]
        : null;
      const linear = (c) =>
        // The client writes paint as sRGB bytes and the shader works in linear,
        // so the conversion happens here rather than in a texture's colour space.
        new THREE.Color().setRGB(c.r / 255, c.g / 255, c.b / 255, THREE.SRGBColorSpace);

      for (const { uniforms, part, piece } of painted) {
        const regions = outfit?.regionColors?.[part];
        if (!regions) {
          uniforms.camoCover.value = 0;
          continue;
        }
        // Every region takes a colour, whether or not the style named it.
        [uniforms.camoRegionA, uniforms.camoRegionB, uniforms.camoRegionC, uniforms.camoRegionD].forEach((slot, i) => {
          const colour = regions[i];
          if (!colour) return slot.value.set(0, 0, 0, 0);
          const { r, g, b } = linear(colour);
          slot.value.set(r, g, b, colour.a / 255);
        });
        // And its finish, which is what separates a lacquered coat from a matt
        // one under the same colour.
        const finish = outfit?.regionFinish?.[part] ?? [];
        uniforms.camoPaintGloss.value.fromArray([0, 1, 2, 3].map((i) => finish[i]?.gloss ?? 0.509));
        uniforms.camoPaintMetal.value.fromArray([0, 1, 2, 3].map((i) => finish[i]?.metallic ?? 0.23));

        // A style can wear a different pattern on each part, so the one this
        // piece takes is the one that names it.
        //
        // **A camouflage covers the whole piece, not one of its regions.** The
        // client's `GUN_CAMOUFLAGE_REGIONS = (GUN,)` and its siblings read like
        // a rendering mask and are not one: they say a player has exactly one
        // camouflage slot per part, against three paint slots, which is why a
        // camouflage's `appliedTo` only ever names each part's first region.
        // The regions are how the paints are told apart.
        const camouflage = (outfit.camouflages ?? []).find((c) => c.regions[part]) ?? null;
        uniforms.camoColors.value.forEach((slot) => slot.set(0, 0, 0, 0));
        uniforms.camoPattern.value = BLANK;
        uniforms.camoGlossSet.value.set(0.509, 0.509, 0.509, 0.509);
        uniforms.camoMetalSet.value.set(0.23, 0.23, 0.23, 0.23);
        uniforms.camoGlossMetalMap.value = BLANK;
        uniforms.camoHasGlossMetal.value = 0;
        uniforms.camoNormalMap.value = FLAT;
        uniforms.camoNormalStrength.value = 0;
        uniforms.camoEmissionMap.value = BLANK;
        uniforms.camoEmissionPower.value = 0;
        if (camouflage) {
          uniforms.camoPattern.value = texture({ path: camouflage.texture, colorSpace: "linear" });
          uniforms.camoTiling.value.copy(layOut(camouflage, piece));
          uniforms.camoTurn.value = camouflage.rotation?.[part] ?? 0;
          // **A pattern with a padded alpha has three weights, not four.**
          // Where the client ships one in a three-channel block format the
          // alpha decodes to a flat 255, and laying the palette's fourth colour
          // through it covers the whole surface at full weight: it both tints
          // the piece and, because the weights are what the colour is divided
          // by, halves everything else. 277 of 400 of the client's patterns are
          // padded that way, so the conversion counts the real ones and the
          // fourth slot is simply not laid where there is nothing to lay it by.
          const carried = camouflage.weights ?? 4;
          uniforms.camoColors.value.forEach((slot, i) => {
            const c = camouflage.colors[i];
            if (!c || i >= carried) return;
            const { r, g, b } = linear(c);
            slot.set(r, g, b, c.a / 255);
          });
          // The coat's own finish. Gloss and metal are linear numbers rather
          // than colours, so they go in as they are written.
          if (camouflage.gloss) uniforms.camoGlossSet.value.fromArray(camouflage.gloss);
          if (camouflage.metallic) uniforms.camoMetalSet.value.fromArray(camouflage.metallic);
          if (camouflage.glossMetallicMap) {
            uniforms.camoGlossMetalMap.value = texture({ path: camouflage.glossMetallicMap, colorSpace: "linear" });
            uniforms.camoHasGlossMetal.value = 1;
          }
          if (camouflage.normal) {
            uniforms.camoNormalMap.value = texture({ path: camouflage.normal.texture, colorSpace: "linear" });
            uniforms.camoNormalStrength.value = camouflage.normal.strength ?? 1;
          }
          if (camouflage.emission) {
            uniforms.camoEmissionMap.value = texture({ path: camouflage.emission.texture, colorSpace: "srgb" });
            uniforms.camoEmissionPower.value = camouflage.emission.power ?? 1;
          }
        }
        uniforms.camoCover.value = 1;
      }
      await sticker(outfit);
      // The marks may be this style's own, so whatever is on the gun is put
      // back with the style's own picture.
      const before = worn;
      worn = outfit?.marks ?? [];
      if (before.join() !== worn.join() && showing > 0) await this.mark(showing);
    },
    /**
     * Take the vehicle off the scene.
     *
     * Everything this loader adds hangs off the mount groups the armour views
     * share, so a rebuild that skipped this would leave the previous style
     * inside the next one.
     */
    dispose() {
      for (const part of parts) part.parent?.remove(part);
      lights.parent?.remove(lights);
      scene.environment = null;
    },
    /** Show or hide the whole thing, lighting included. */
    show(on) {
      for (const part of parts) part.visible = on;
      lights.visible = on;
      scene.environment = on ? environment : null;
      // Khronos PBR Neutral, not ACES. ACES is a film curve: it desaturates as
      // it rolls off, which on a vehicle lit from every side turns paint to
      // grey. Measured on the IS-7 at the same exposure it costs a third of the
      // saturation the Neutral curve keeps (0.139 against 0.189), and the
      // Neutral one exists precisely for showing an object as it is.
      renderer.toneMapping = on ? THREE.NeutralToneMapping : THREE.NoToneMapping;
      // Low, because the environment is doing the lighting.
      //
      // This was 2.1, which was itself a step down from a 2.8 chosen to make the
      // average brightness match a capture of the game, and both were the same
      // mistake made twice: turning the exposure up to make up for an
      // environment that was turned down. What the texture holds, the rust on
      // the fender, the weld beads, the panel lines, flattens into pale cream
      // either way. The pair is what matters, and the pair is a bright
      // environment read at a low exposure.
      renderer.toneMappingExposure = 1.42;
      // The armour views draw flat answers and must not be shadowed.
      renderer.shadowMap.enabled = on;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    },
    /** Whether this vehicle published axles for its wheels. */
    turns: wheels.length > 0,
    /** Whether the mirror has a high-definition set for this vehicle. */
    hasHd: Object.values(model.materials ?? {}).some((m) =>
      Object.values(m.textures ?? {}).some((t) => t.hd),
    ),
    /** Swap every material between the two definitions, in place. */
    define(next) {
      if (next === definition) return;
      definition = next;
      for (const { maps, built } of materials) {
        if (!built) continue;
        const surface = texture(maps.metallicGlossMap);
        built.map = texture(maps.diffuseMap);
        built.normalMap = texture(maps.normalMap);
        built.aoMap = texture(maps.excludeMaskAndAOMap);
        built.roughnessMap = surface;
        built.metalnessMap = surface;
        built.needsUpdate = true;
      }
    },
    /**
     * Run the belt as though the tank had moved.
     *
     * The belt is laid along the client's own path and owes nothing to the
     * skeleton. The wheels do, and they turn with it: a metre travelled is a
     * metre of rim, so each wheel turns that metre over its own radius and the
     * small ones spin faster than the road wheels, as they should.
     */
    roll(distance) {
      for (const belt of belts) belt.place(((distance % belt.total) + belt.total) % belt.total);
      for (const wheel of TURN_WHEELS ? wheels : []) {
        // Skinning applies `bone.matrixWorld * boneInverse` to a vertex, and at
        // rest those two cancel exactly. To turn the wheel about its axle the
        // product has to become `T(axle) · R · T(-axle)`, so the bone's own
        // matrix is that, followed by its rest transform to undo the inverse.
        toAxle.makeTranslation(wheel.axle.x, wheel.axle.y, wheel.axle.z);
        fromAxle.makeTranslation(-wheel.axle.x, -wheel.axle.y, -wheel.axle.z);
        turn.makeRotationX(distance / wheel.radius);
        wheel.bone.matrix
          .copy(toAxle)
          .multiply(turn)
          .multiply(fromAxle)
          .multiply(wheel.rest);
        wheel.bone.matrix.decompose(wheel.bone.position, wheel.bone.quaternion, wheel.bone.scale);
      }
    },
  };
}
