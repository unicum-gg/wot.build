// The 2D styles, published once for the whole mirror instead of once per vehicle.
//
// **A style is the same recipe on every vehicle that can wear it.** Measured
// across 131 published vehicles, 91928 of 92002 styles were identical byte for
// byte, and exactly one field ever differed: the tiling, which the client hand
// tunes per vehicle for a few of them. Writing the whole catalogue beside every
// vehicle cost 1.59 MB each, 208 MB over those 131 and around 1.6 GB over the
// catalogue, for a list that changes by about a kilobyte from one tank to the
// next. It also made a tank page on the site download 1.59 MB of paint shop it
// already had.
//
// So the styles are written once at the root and each vehicle keeps a patch:
// which of them it is offered, and the handful whose tiling is its own.
import type { Style2D } from "../style.js";

/** What one vehicle keeps of the shared catalogue. */
export type StylePatch = {
  /** The style ids this vehicle is offered, in the order it offers them. */
  offers: number[];
  /**
   * The camouflages whose tiling the client tuned for this vehicle, as
   * `[style, outfit, camouflage, tiling]`. A median of eleven per vehicle.
   */
  tiling: [number, number, number, [number, number, number, number]][];
};

/**
 * Fold one vehicle's resolved styles into the shared catalogue.
 *
 * The first vehicle to offer a style writes it, with its tiling stripped, and
 * every later one only records where it disagrees. **A disagreement anywhere
 * else is logged rather than silently resolved in favour of whoever got there
 * first**, since that is the failure this whole arrangement risks.
 */
export function fold(
  catalogue: Map<number, Style2D>,
  styles: Style2D[],
  onConflict: (message: string) => void,
): StylePatch {
  const patch: StylePatch = { offers: [], tiling: [] };
  for (const style of styles) {
    patch.offers.push(style.id);
    const bare: Style2D = {
      ...style,
      outfits: style.outfits.map((outfit) => ({
        ...outfit,
        camouflages: outfit.camouflages.map((c) => ({ ...c, tiling: null })),
      })),
    };
    const known = catalogue.get(style.id);
    if (!known) catalogue.set(style.id, bare);
    else if (JSON.stringify(known) !== JSON.stringify(bare)) {
      onConflict(`style ${style.id} (${style.name}) differs beyond its tiling`);
    }
    style.outfits.forEach((outfit, o) =>
      outfit.camouflages.forEach((c, k) => {
        if (c.tiling) patch.tiling.push([style.id, o, k, c.tiling]);
      }),
    );
  }
  return patch;
}
