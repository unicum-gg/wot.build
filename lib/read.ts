// Reading values out of a decoded packed section.
//
// The client's XML is a tree of nodes whose values are text, so every reader
// needs the same handful of accessors. They were copied into each one, which is
// how the four copies of `numbers` came to disagree with each other: two filter
// out what does not parse, one keeps the NaN, and only one handles a value the
// decoder already turned into a number. Those are left where they are until each
// caller's behaviour can be checked; these four are identical everywhere and are
// shared.
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
