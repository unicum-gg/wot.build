// Turning the client's space into glTF's.
//
// BigWorld works in a **left-handed** space, the DirectX convention it grew up
// with, and glTF is right-handed. Read straight across, a vehicle therefore
// comes out mirrored: its aerial and its anti-aircraft gun end up on the wrong
// side of the turret, which is exactly what a player who knows the tank sees
// first.
//
// The fix is to negate one axis and reverse triangle winding, since mirroring
// turns a front face into a back one. X is the axis to pick: it is the one the
// client's own left-and-right lives on, so every left/right name in the data
// (`leftTrack`, `W_L0`, the two track paths) keeps meaning what it says once
// the sign is flipped with it.
//
// This was already being done for skinned pieces, where the client's bones
// carry the flip themselves and `unskin` reverses winding to match. Everything
// unskinned — hulls, turrets, the collision shells, the track paths — went
// through untouched, which is where the mirror came from.

/** Flip one point across the vehicle's centreline, in place. */
export function mirrorPoint(p: number[]): number[] {
  return [-p[0], p[1], p[2]];
}

/** Flip a flat array of xyz triples across the centreline, in place. */
export function mirrorPositions(values: number[]): void {
  for (let i = 0; i < values.length; i += 3) values[i] = -values[i];
}

/**
 * Reverse the winding of every triangle in an index list, in place.
 *
 * A mirror turns a front face into a back one, so without this a hull renders
 * inside out: its far side draws over its near side.
 */
export function reverseWinding(indices: number[]): void {
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const swap = indices[i];
    indices[i] = indices[i + 2];
    indices[i + 2] = swap;
  }
}

// There is deliberately no swapping of `left` and `right` here.
//
// It was done for a while, on the reasoning that mirroring moves the geometry
// but not the names, so `leftTrack` would end up on the right. That misses that
// the mirror changes the handedness of the space as well. The client is
// left-handed with the vehicle facing +Z, so its +X is the vehicle's right and
// its `W_L0` sits at -X. Flipping X lands that same wheel at +X in a
// right-handed space where the vehicle still faces +Z, and +X there is the
// vehicle's left. The side a part is on never moved, so neither should its name.
//
// Swapping them broke the one thing that has to hold: the client's own labels
// agreeing with each other. `leftTrack` was published on the far side of the
// tank from `W_L0`, which come out of the same file in the same space.
