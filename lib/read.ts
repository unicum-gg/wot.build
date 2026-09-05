// Reading values out of a decoded packed section.
//
// The client's XML is a tree of nodes whose values are text, so every reader
// needs the same handful of accessors. They were copied into each one, which is
// how the four copies of `numbers` came to disagree with each other: two filter
// out what does not parse, one keeps the NaN, and only one handles a value the
// decoder already turned into a number. The one that does is here, since it is
// the only one that reads every shape a value arrives in and the others are its
// behaviour minus a case. The rest are left where they are until each caller's
// behaviour can be checked against it. So is `visual.ts`'s `rawText`, which does
// not trim where this one does. What is here is what was identical wherever it
// appeared.
import type { PackedNode } from "./packed.js";

export function child(node: PackedNode | undefined, name: string): PackedNode | undefined {
  return node?.children.find((c) => c.name === name);
}

export function children(node: PackedNode | undefined, name: string): PackedNode[] {
  return node?.children.filter((c) => c.name === name) ?? [];
}

export function text(node: PackedNode | undefined): string {
  return typeof node?.value === "string" ? node.value.trim() : "";
}

export function words(node: PackedNode | undefined): string[] {
  return text(node).split(/\s+/).filter(Boolean);
}

/**
 * Every number in a value, whatever shape it arrived in.
 *
 * The decoder gives back a number for a lone value, an array where the section
 * held one, and the raw text otherwise, so a reader that handles only the last
 * of those silently loses whichever it was not written against.
 */
export function numbers(node: PackedNode | undefined): number[] {
  if (!node) return [];
  if (Array.isArray(node.value)) return node.value.map(Number);
  if (typeof node.value === "number") return [node.value];
  if (typeof node.value === "string") {
    return node.value.trim().split(/\s+/).map(Number);
  }
  return [];
}
