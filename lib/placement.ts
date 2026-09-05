// The affine algebra a piece's node tree is built out of.
//
// The client stores a transform as a three-by-three basis followed by a
// translation, and applies it to a **row** vector: a point goes `v * B + t`, the
// DirectX convention BigWorld grew up with. So `compose(parent, child)` reads
// "child, then parent", and every function here follows that order rather than
// the column-vector one a matrix library would use.
//
// Split out of the visual reader because an animation needs more of it than
// reading a mesh does: composing a chain is enough to place a node, but moving
// one means inverting a placement, building one from the angles the client
// keyframes, and pulling one back apart into the translation, rotation and
// scale glTF wants.

/** A node's placement: a three-by-three basis followed by a translation. */
export type Placement = { basis: number[]; offset: number[] };

export const IDENTITY: Placement = { basis: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] };

/**
 * The vehicle's centreline, as a placement.
 *
 * BigWorld is left-handed and glTF is right-handed, so everything published is
 * flipped across X. Kept here as a transform rather than a special case because
 * an animation has to carry the flip through a chain of them.
 */
export const MIRROR: Placement = { basis: [-1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] };

/** Apply a placement to a point. The client stores its basis as row vectors. */
export function place(p: Placement, x: number, y: number, z: number): [number, number, number] {
  const b = p.basis;
  return [
    x * b[0] + y * b[3] + z * b[6] + p.offset[0],
    x * b[1] + y * b[4] + z * b[7] + p.offset[1],
    x * b[2] + y * b[5] + z * b[8] + p.offset[2],
  ];
}

/** `child` expressed in the space `parent` lives in. */
export function compose(parent: Placement, child: Placement): Placement {
  const basis: number[] = [];
  for (let row = 0; row < 3; row++) {
    const v = place(
      { basis: parent.basis, offset: [0, 0, 0] },
      child.basis[row * 3],
      child.basis[row * 3 + 1],
      child.basis[row * 3 + 2],
    );
    basis.push(...v);
  }
  return { basis, offset: place(parent, child.offset[0], child.offset[1], child.offset[2]) };
}

/**
 * The placement that undoes this one.
 *
 * A general inverse rather than a transpose: a client basis is usually a
 * rotation, but not always, and a piece whose artist scaled a node would come
 * back wrong from the shortcut.
 */
export function invert(p: Placement): Placement {
  const b = p.basis;
  const cofactor = [
    b[4] * b[8] - b[5] * b[7],
    b[2] * b[7] - b[1] * b[8],
    b[1] * b[5] - b[2] * b[4],
    b[5] * b[6] - b[3] * b[8],
    b[0] * b[8] - b[2] * b[6],
    b[2] * b[3] - b[0] * b[5],
    b[3] * b[7] - b[4] * b[6],
    b[1] * b[6] - b[0] * b[7],
    b[0] * b[4] - b[1] * b[3],
  ];
  const determinant = b[0] * cofactor[0] + b[1] * cofactor[3] + b[2] * cofactor[6];
  if (Math.abs(determinant) < 1e-12) return IDENTITY;
  const basis = cofactor.map((v) => v / determinant);
  const t = p.offset;
  return { basis, offset: place({ basis, offset: [0, 0, 0] }, -t[0], -t[1], -t[2]) };
}

/**
 * A rotation from the three angles the client keyframes, in degrees.
 *
 * **Yaw, then pitch, then roll**, which is BigWorld's own order: its matrices
 * are built by `setRotateYPR` throughout the client, so Y turns first, X
 * second and Z last. The order only shows on a track that moves more than one
 * axis at once, which across every vehicle prefab in the client is three of
 * them.
 */
export function fromEuler(x: number, y: number, z: number): Placement {
  const rad = Math.PI / 180;
  const [sy, cy] = [Math.sin(y * rad), Math.cos(y * rad)];
  const [sx, cx] = [Math.sin(x * rad), Math.cos(x * rad)];
  const [sz, cz] = [Math.sin(z * rad), Math.cos(z * rad)];
  const yaw: Placement = { basis: [cy, 0, -sy, 0, 1, 0, sy, 0, cy], offset: [0, 0, 0] };
  const pitch: Placement = { basis: [1, 0, 0, 0, cx, sx, 0, -sx, cx], offset: [0, 0, 0] };
  const roll: Placement = { basis: [cz, sz, 0, -sz, cz, 0, 0, 0, 1], offset: [0, 0, 0] };
  return compose(roll, compose(pitch, yaw));
}

/** A placement pulled apart into what glTF animates: translation, rotation, scale. */
export type Trs = { translation: number[]; rotation: number[]; scale: number[] };

/**
 * Pull a placement apart into a translation, a quaternion and a scale.
 *
 * The basis is read back as **columns** here, not rows: the client's row-vector
 * convention makes its stored basis the transpose of the column-vector matrix
 * glTF and every renderer use, so a quaternion read off the rows directly comes
 * out turning the other way.
 */
export function decompose(p: Placement): Trs {
  const b = p.basis;
  // Columns of the column-vector matrix, which are the rows as stored.
  const axes = [
    [b[0], b[1], b[2]],
    [b[3], b[4], b[5]],
    [b[6], b[7], b[8]],
  ];
  const scale = axes.map((a) => Math.hypot(a[0], a[1], a[2]));
  // A mirroring basis has to give one negative scale, or the rotation it leaves
  // behind is not a rotation and the quaternion below is meaningless.
  const determinant =
    b[0] * (b[4] * b[8] - b[5] * b[7]) -
    b[1] * (b[3] * b[8] - b[5] * b[6]) +
    b[2] * (b[3] * b[7] - b[4] * b[6]);
  if (determinant < 0) scale[0] = -scale[0];
  const m = [0, 1, 2].map((i) => axes[i].map((v) => (scale[i] === 0 ? 0 : v / scale[i])));
  // `m[i][j]` is the stored basis normalised, so column i of the renderer's
  // matrix. The quaternion is read from it in that reading.
  const [m00, m10, m20] = m[0];
  const [m01, m11, m21] = m[1];
  const [m02, m12, m22] = m[2];
  const trace = m00 + m11 + m22;
  let q: number[];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return {
    translation: [...p.offset],
    rotation: q.map((v) => v / length),
    scale,
  };
}
