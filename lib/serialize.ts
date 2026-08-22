// Writes a decoded packed section back out as the text XML the mirror publishes.
// Every rule here was derived by diffing against IzeBerg/wot-src, byte for byte.
import { PackedNode, PackedType } from "./packed.js";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&apos;",
  '"': "&quot;",
};
const escape = (s: string) => s.replace(/[&<>'"]/g, (c) => ESCAPES[c]);

// Floats print like C's "%f": six decimals, ties to even. `toFixed` rounds ties
// up instead, which is wrong once in a while (449.4140625 must give 449.414062).
const FLOAT_FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 6,
  maximumFractionDigits: 6,
  roundingMode: "halfEven",
  useGrouping: false,
});
const float = (n: number) => (Object.is(n, -0) ? "-0.000000" : FLOAT_FORMAT.format(n));

const CANONICAL_INT = /^-?(0|[1-9]\d*)$/;
const NUMBER_PREFIX = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/;

// A token reads back as a number when it starts with digits and carries at most
// a symbolic unit: "112.5%" qualifies, "01_karelia" and "+Z" do not.
function numericLike(token: string): boolean {
  const m = NUMBER_PREFIX.exec(token);
  return m !== null && !/[A-Za-z_]/.test(token.slice(m[0].length));
}

// The client marks a packed STRING whose text would be retyped on the way back
// in, so the conversion stays reversible.
function needsMarker(node: PackedNode): boolean {
  if (node.type !== PackedType.String) return false;
  const value = String(node.value).trim();
  if (value === "") return false;
  // Case-sensitive: "False" is plain text, only the lowercase literals retype.
  if (value === "true" || value === "false") return true;
  const tokens = value.split(/\s+/);
  if (!tokens.every(numericLike)) return false;
  // Up to four components (scalar, Vector2/3/4) only canonical integers survive
  // the round trip: "05" would come back as 5, "-500.0" as "-500.000000".
  if (tokens.length <= 4) return !tokens.every((t) => CANONICAL_INT.test(t));
  // Beyond that only a list holding a real changes; a long integer list is
  // reproduced verbatim.
  return tokens.some((t) => /[.eE]/.test(t));
}

function renderValue(node: PackedNode): string {
  switch (node.type) {
    case PackedType.String:
      return String(node.value);
    case PackedType.Int:
      return String(node.value);
    case PackedType.Float:
      return Array.isArray(node.value) ? node.value.map(float).join(" ") : float(node.value as number);
    case PackedType.Bool:
      return node.value ? "true" : "false";
    default:
      return String(node.value ?? "");
  }
}

// Twelve floats are a Matrix34, which the client writes as four rows of three.
const MATRIX_COMPONENTS = 12;
const isMatrix = (n: PackedNode) =>
  n.type === PackedType.Float && Array.isArray(n.value) && n.value.length === MATRIX_COMPONENTS;

function renderNode(node: PackedNode, depth: number, out: string[]): void {
  const pad = "\t".repeat(depth);

  if (isMatrix(node) && node.children.length === 0) {
    const values = node.value as number[];
    out.push(`${pad}<${node.name}>`);
    for (let row = 0; row < 4; row++) {
      const cells = values.slice(row * 3, row * 3 + 3).map(float).join(" ");
      out.push(`${pad}\t<row${row}>${cells}</row${row}>`);
    }
    out.push(`${pad}</${node.name}>`);
    return;
  }

  const text = renderValue(node);
  const marker = needsMarker(node);

  if (node.children.length === 0 && !marker) {
    out.push(text === "" ? `${pad}<${node.name}/>` : `${pad}<${node.name}>${escape(text)}</${node.name}>`);
    return;
  }

  out.push(`${pad}<${node.name}>`);
  if (marker) {
    out.push(`${pad}\t${escape(text)}`);
    out.push(`${pad}\t<!--BW_String-->`);
  } else if (text !== "") {
    out.push(`${pad}\t${escape(text)}`);
  }
  for (const child of node.children) renderNode(child, depth + 1, out);
  out.push(`${pad}</${node.name}>`);
}

export function toXml(root: PackedNode): string {
  const header = '<?xml version="1.0" encoding="utf-8"?>';
  // An empty document collapses to a self-closing root, like any other element.
  if (root.children.length === 0) return `${header}\n<root/>\n`;
  const out = [header, "<root>"];
  for (const child of root.children) renderNode(child, 1, out);
  out.push("</root>");
  return `${out.join("\n")}\n`;
}
