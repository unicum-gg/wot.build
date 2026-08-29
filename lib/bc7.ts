// Decoder for BC7, the block format the client uses for its newest vehicles.
//
// Ported from bcdec by iOrange (MIT), which is itself a direct reading of the
// BPTC specification. Kept apart from `dds.ts` because it is a different
// compression family: where DXT interpolates one pair of endpoints per block,
// BC7 picks between eight modes, each splitting the block into up to three
// regions with their own endpoints and its own bit budget for colour, alpha and
// indices. That is why the tables below exist rather than a formula.
//
// A block is sixteen bytes for a four-by-four tile. Its mode is written in
// unary, and everything after it is a bit field whose layout the mode decides.

// Bits per colour and per alpha component, indexed by mode. A mode with no
// alpha bits is fully opaque.
const COLOR_BITS = [4, 6, 5, 7, 5, 7, 7, 5];
const ALPHA_BITS = [0, 0, 0, 0, 6, 8, 7, 5];

// Modes 0, 1, 3, 6 and 7 carry an extra low bit per endpoint.
const MODES_WITH_P_BITS = 0b11001011;

// Interpolation weights over 64, by index width.
const WEIGHTS_2 = [0, 21, 43, 64];
const WEIGHTS_3 = [0, 9, 18, 27, 37, 46, 55, 64];
const WEIGHTS_4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

// Which region each of a block's sixteen texels belongs to, for every partition
// the two-region and three-region modes can choose. One hex digit per texel:
// the low two bits are the region, and bit 3 marks the texel whose index is
// stored with one bit less, because its high bit is implied.
const PARTITIONS_2 =
  "8011001100110019800100010001000981110111011101198001001100110119" +
  "8000000100010019801101110111111980010011011111198000000100110119" +
  "8000000000010019801101111111111980000001011111198000000000010119" +
  "8001011111111119800000001111111980001111111111198000000000001119" +
  "8000100011101119819100010000000080000000900011108191001100010000" +
  "8091000100000000800010009100111080000000900011008111001100110009" +
  "8091000100010000800010009000110081900110011001108091011001101100" +
  "8001011191101000800011119111000081910001100011108091100110011100" +
  "8101010101010109800011110000111981011090010110108011001191001100" +
  "8091110000111100810101019010101081101001011010098101101010100109" +
  "8191001111001110800100119100100080910010010011008091101111011100" +
  "8190100110010110801111001100001981100110100110098000019001100000" +
  "8100119001000000809001110010000080000090011100108000010091100100" +
  "8110110010010019801101101100100981900011100111008091100111000110" +
  "8110110011001009811000110011100981111110100000098001100011100119" +
  "8000111100110019809100111111000080900010111011108100010001110119";

const PARTITIONS_3 =
  "801900110221222a80090011a211222180002001a2112219822a002200110119" +
  "800000009122112a801900110022002a802a00221111111980110011a2112219" +
  "800000009111222a800011119111222a800011912222222a801200920012001a" +
  "811201920112011a812209220122012a801901121122122a80192001a2002220" +
  "800900110112112a81190011a0012200800011229122112a802a002200221119" +
  "811901110222022a80090001a2212221800000910122012a80001100a2902210" +
  "812a092200110000801200129122222a811012a1922101108000019012a11221" +
  "802211029102002a811009102002222a8011012201a2001980002000a2112229" +
  "800000029122122a822a002200120019801900120022022a8120092001a00120" +
  "8000119122a2000081201201a0920120812020129a0101208011220011a20019" +
  "801111a222000019810901012222222a80000000a1212129802219220022112a" +
  "802a001100220019822012a102201229810122a22222010980002121a1212129" +
  "810901010101222a822a011102220119800219120002111a800029122112211a" +
  "822209110111022a800211129112000a811009100110222a800000002192211a" +
  "811009102222222a802200110091002a802211229122002a800000000000291a" +
  "800a000100020009822212220222922a810922222222222a81192011a2012220";

/** The region of texel `(x, y)` under `partition`, with bit 3 set on the anchor. */
function region(table: string, partition: number, x: number, y: number): number {
  return Number.parseInt(table[partition * 16 + y * 4 + x], 16);
}

/**
 * The block's bits, least significant first.
 *
 * A block is two 64-bit halves and fields cross the boundary freely, so reads
 * consume from the low half and refill it from the high one.
 */
class BitStream {
  private low: bigint;
  private high: bigint;

  constructor(buf: Buffer, offset: number) {
    this.low = buf.readBigUInt64LE(offset);
    this.high = buf.readBigUInt64LE(offset + 8);
  }

  read(count: number): number {
    if (count <= 0) return 0;
    const width = BigInt(count);
    const mask = (1n << width) - 1n;
    const bits = Number(this.low & mask);
    this.low = (this.low >> width) | ((this.high & mask) << (64n - width));
    this.high >>= width;
    return bits;
  }
}

function interpolate(a: number, b: number, weights: number[], index: number): number {
  return (a * (64 - weights[index]) + b * weights[index] + 32) >> 6;
}

/** Spread a component of `bits` width across a full byte. */
function expand(value: number, bits: number): number {
  const shifted = (value << (8 - bits)) & 0xff;
  return shifted | (shifted >> bits);
}

/**
 * Decode one block into `out`, which holds RGBA rows of `pitch` bytes.
 *
 * An unknown mode leaves the tile transparent black, which is what the
 * specification asks for and what a hardware decoder does.
 */
function decodeBlock(buf: Buffer, offset: number, out: Buffer, at: number, pitch: number): void {
  const stream = new BitStream(buf, offset);
  let mode = 0;
  while (mode < 8 && stream.read(1) === 0) mode++;
  if (mode >= 8) {
    for (let y = 0; y < 4; y++) out.fill(0, at + y * pitch, at + y * pitch + 16);
    return;
  }

  const regions = mode === 0 || mode === 2 ? 3 : mode === 1 || mode === 3 || mode === 7 ? 2 : 1;
  const partition = regions > 1 ? stream.read(mode === 0 ? 4 : 6) : 0;
  const rotation = mode === 4 || mode === 5 ? stream.read(2) : 0;
  const indexSelection = mode === 4 ? stream.read(1) : 0;

  const endpointCount = regions * 2;
  const endpoints: number[][] = Array.from({ length: endpointCount }, () => [0, 0, 0, 0]);
  for (let channel = 0; channel < 3; channel++) {
    for (let e = 0; e < endpointCount; e++) endpoints[e][channel] = stream.read(COLOR_BITS[mode]);
  }
  if (ALPHA_BITS[mode] > 0) {
    for (let e = 0; e < endpointCount; e++) endpoints[e][3] = stream.read(ALPHA_BITS[mode]);
  }

  const hasPBits = (MODES_WITH_P_BITS >> mode) & 1;
  if (hasPBits) {
    for (const endpoint of endpoints) {
      for (let c = 0; c < 4; c++) endpoint[c] <<= 1;
    }
    if (mode === 1) {
      // Mode 1 shares one low bit between the two endpoints of each region.
      const first = stream.read(1);
      const second = stream.read(1);
      for (let c = 0; c < 3; c++) {
        endpoints[0][c] |= first;
        endpoints[1][c] |= first;
        endpoints[2][c] |= second;
        endpoints[3][c] |= second;
      }
    } else {
      for (const endpoint of endpoints) {
        const bit = stream.read(1);
        for (let c = 0; c < 4; c++) endpoint[c] |= bit;
      }
    }
  }

  const colorPrecision = COLOR_BITS[mode] + hasPBits;
  const alphaPrecision = ALPHA_BITS[mode] + hasPBits;
  for (const endpoint of endpoints) {
    for (let c = 0; c < 3; c++) endpoint[c] = expand(endpoint[c], colorPrecision);
    endpoint[3] = ALPHA_BITS[mode] ? expand(endpoint[3], alphaPrecision) : 0xff;
  }

  const indexBits = mode === 0 || mode === 1 ? 3 : mode === 6 ? 4 : 2;
  const alphaIndexBits = mode === 4 ? 3 : mode === 5 ? 2 : 0;
  const weights = indexBits === 2 ? WEIGHTS_2 : indexBits === 3 ? WEIGHTS_3 : WEIGHTS_4;
  const alphaWeights = alphaIndexBits === 2 ? WEIGHTS_2 : WEIGHTS_3;
  const table = regions === 3 ? PARTITIONS_3 : PARTITIONS_2;

  // Colour indices come first for the whole block, alpha indices after, so the
  // block has to be walked twice.
  const indices: number[] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const cell = regions === 1 ? (x | y ? 0 : 0x8) : region(table, partition, x, y);
      indices.push(stream.read(cell & 0x8 ? indexBits - 1 : indexBits));
    }
  }

  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const cell = (regions === 1 ? (x | y ? 0 : 0x8) : region(table, partition, x, y)) & 0x03;
      const index = indices[y * 4 + x];
      const low = endpoints[cell * 2];
      const high = endpoints[cell * 2 + 1];

      let channels: number[];
      if (!alphaIndexBits) {
        channels = [0, 1, 2, 3].map((c) => interpolate(low[c], high[c], weights, index));
      } else {
        const alphaIndex = stream.read(x | y ? alphaIndexBits : alphaIndexBits - 1);
        // A mode with two index sets says which one colour reads; alpha reads
        // the other.
        const colorSet = indexSelection ? { w: alphaWeights, i: alphaIndex } : { w: weights, i: index };
        const alphaSet = indexSelection ? { w: weights, i: index } : { w: alphaWeights, i: alphaIndex };
        channels = [
          interpolate(low[0], high[0], colorSet.w, colorSet.i),
          interpolate(low[1], high[1], colorSet.w, colorSet.i),
          interpolate(low[2], high[2], colorSet.w, colorSet.i),
          interpolate(low[3], high[3], alphaSet.w, alphaSet.i),
        ];
      }

      // Rotation moves alpha into one of the colour channels, so that a block
      // whose detail lives in alpha can spend its wider budget on it.
      if (rotation > 0) {
        const swap = rotation - 1;
        [channels[3], channels[swap]] = [channels[swap], channels[3]];
      }

      const target = at + y * pitch + x * 4;
      out[target] = channels[0];
      out[target + 1] = channels[1];
      out[target + 2] = channels[2];
      out[target + 3] = channels[3];
    }
  }
}

/** Decode a BC7 surface to RGBA. */
export function decodeBc7(buf: Buffer, offset: number, width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height * 4);
  const pitch = width * 4;
  let at = offset;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      if (x + 4 <= width && y + 4 <= height) {
        decodeBlock(buf, at, out, y * pitch + x * 4, pitch);
      } else {
        // Edge tile: decode into scratch and copy the part that fits.
        const tile = Buffer.alloc(64);
        decodeBlock(buf, at, tile, 0, 16);
        for (let ty = 0; ty < Math.min(4, height - y); ty++) {
          const row = Math.min(4, width - x) * 4;
          tile.copy(out, (y + ty) * pitch + x * 4, ty * 16, ty * 16 + row);
        }
      }
      at += 16;
    }
  }
  return out;
}
