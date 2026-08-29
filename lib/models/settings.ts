// What one run of the models generator was asked for.
//
// The flags were module-level constants read from anywhere, which is fine in a
// single file and stops being fine the moment the generator is more than one.
// Resolved once here and passed down, so a function says in its signature what
// it depends on.
import fs from "node:fs";
import path from "node:path";

export type Settings = {
  host: string;
  guid: string;
  /** Where the mirror is written. */
  out: string;
  /** One vehicle by code, which is the development path. */
  only?: string;
  /** Substrings narrowing which packages are read at all. */
  packages?: string[];
  /**
   * Both sets are published at the size the client ships them.
   *
   * There is no reason to resize what is already the source. The client has 2048
   * on a tier ten hull where we were publishing 1024, and halving it threw away
   * exactly the relief a player looks for when they switch to HD. The standard
   * set had the same problem a size down: the client's own SD hull is 1024 and we
   * were capping it at 512, so our SD was half the game's SD rather than being it.
   *
   * Set either to cap it if a build ever has to trade the fidelity for the bytes.
   */
  textureSize?: number;
  hdTextureSize?: number;
  skipHd: boolean;
  collisionOnly: boolean;
  withSkins: boolean;
  force: boolean;
  /**
   * Drop a source once it has been converted.
   *
   * The scratch tree is fed 25 GB of packages, so anything consumed goes as it
   * is consumed or the disk fills. A single-vehicle run is the exception and the
   * whole point of one: its sources are what makes the next iteration seconds
   * instead of ten minutes of network, so nothing is thrown away there.
   */
  consume(at: string): void;
};

export const log = (msg: string) => console.log(`[wot.models] ${msg}`);

/** Read the command line, consuming the flags it recognises. */
export function readSettings(args: string[]): Settings {
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const value = args[i + 1];
    args.splice(i, 2);
    return value;
  };
  const only = flag("--vehicle");
  const textureSize = flag("--texture-size");
  const hdTextureSize = flag("--hd-texture-size");
  return {
    host: flag("--host") ?? "wgus-woteu.wargaming.net",
    guid: flag("--guid") ?? "WOT.EU.PRODUCTION",
    out: path.resolve(flag("--out") ?? "models-out"),
    only,
    packages: flag("--package")?.split(",").filter(Boolean),
    textureSize: textureSize ? Number(textureSize) : undefined,
    hdTextureSize: hdTextureSize ? Number(hdTextureSize) : undefined,
    skipHd: args.includes("--no-hd"),
    collisionOnly: args.includes("--collision-only"),
    withSkins: args.includes("--skins"),
    force: args.includes("--force"),
    consume: (at: string) => {
      if (!only) fs.rmSync(at);
    },
  };
}
