import { NODE_KINDS, type FlowGraph, type FlowNode, type MergeRule, type StateDecl, type StateValueType } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { canonicalEdgeId, dedupeEdgeIds } from "./edge-id.js";
import { format } from "./format.js";
import { normalizeForRoundTrip } from "./normalize.js";
import { parse } from "./parse.js";
import { print } from "./print.js";

/** Small seeded PRNG (mulberry32) so a failing seed is reproducible from the printed seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MERGE_RULES: MergeRule[] = ["replace", "append", "numeric-add", "set-union", "error-on-conflict"];
const FILE_MERGE_RULES: MergeRule[] = ["replace", "append"];
const STATE_TYPES: StateValueType[] = ["file", "string", "number", "boolean", "array", "object"];

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function randomIdent(rand: () => number, prefix: string): string {
  return `${prefix}${Math.floor(rand() * 1_000_000)}`;
}

/** A string with no leading/trailing blank line and no interior all-whitespace line — the shape
 *  `dedentBlockString` round-trips exactly (see dedent.ts's doc comment on the lossy edges). */
function randomMultilineString(rand: () => number): string {
  const lineCount = 2 + Math.floor(rand() * 3);
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push(rand() < 0.3 && i > 0 && i < lineCount - 1 ? "" : `text ${Math.floor(rand() * 1000)} {{var}}`);
  }
  return lines.join("\n");
}

function randomScalar(rand: () => number): unknown {
  const roll = rand();
  if (roll < 0.15) return null;
  if (roll < 0.3) return rand() < 0.5;
  if (roll < 0.5) return Math.round((rand() - 0.5) * 2000) / 10;
  if (roll < 0.65) return rand() < 0.5 ? randomMultilineString(rand) : `plain-${Math.floor(rand() * 1000)}`;
  if (roll < 0.85) return Array.from({ length: 1 + Math.floor(rand() * 3) }, () => `item${Math.floor(rand() * 100)}`);
  return { a: Math.floor(rand() * 10), b: `s${Math.floor(rand() * 10)}` };
}

function randomData(rand: () => number): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const propCount = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < propCount; i++) {
    data[`prop_${i}`] = randomScalar(rand);
  }
  return data;
}

/** A flat (no Loop/Map nesting — that shape is covered by @flowlathe/testing's golden fixtures
 *  and their dedicated round-trip test) random DAG: forward-only edges guarantee acyclicity. */
function randomGraph(seed: number): FlowGraph {
  const rand = mulberry32(seed);
  const nodeCount = 3 + Math.floor(rand() * 5);
  const nodes: FlowNode[] = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      id: `n${i}`,
      type: pick(rand, NODE_KINDS),
      position: { x: Math.floor(rand() * 500), y: Math.floor(rand() * 500) },
      data: randomData(rand),
    });
  }

  const edgesRaw: { source: string; sourceHandle: string; target: string; targetHandle: string }[] = [];
  for (let i = 1; i < nodeCount; i++) {
    const from = Math.floor(rand() * i);
    edgesRaw.push({
      source: `n${from}`,
      sourceHandle: randomIdent(rand, "out"),
      target: `n${i}`,
      targetHandle: randomIdent(rand, "in"),
    });
  }

  const edges = dedupeEdgeIds(
    edgesRaw.map((e) => ({ id: canonicalEdgeId(e.source, e.sourceHandle, e.target, e.targetHandle), ...e })),
  );

  const state: StateDecl[] = [];
  const stateCount = Math.floor(rand() * 3);
  for (let i = 0; i < stateCount; i++) {
    const type = pick(rand, STATE_TYPES);
    if (type === "file") {
      const decl: StateDecl = {
        name: `s${i}`,
        type,
        merge: pick(rand, FILE_MERGE_RULES),
        filePath: `dir${Math.floor(rand() * 10)}/file${Math.floor(rand() * 10)}.md`,
        fileMode: pick(rand, ["read-only", "read-write"] as const),
      };
      if (decl.fileMode === "read-write" && rand() < 0.5) decl.versioned = rand() < 0.5;
      state.push(decl);
      continue;
    }
    const decl: StateDecl = { name: `s${i}`, type, merge: pick(rand, MERGE_RULES) };
    if (rand() < 0.6) decl.initial = randomScalar(rand);
    state.push(decl);
  }

  return { nodes, edges, state };
}

describe("round trip (fuzz)", () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`parse(print(g)) deep-equals g for seed ${seed}`, () => {
      const graph = randomGraph(seed);
      const file = { name: `flow-${seed}`, graph, comments: {} };
      const text = print(file);
      const reparsed = parse(text);
      expect(reparsed.name).toBe(file.name);
      expect(normalizeForRoundTrip(reparsed.graph)).toEqual(normalizeForRoundTrip(graph));
    });

    it(`format is idempotent for seed ${seed}`, () => {
      const graph = randomGraph(seed);
      const text = print({ name: `flow-${seed}`, graph, comments: {} });
      expect(format(format(text))).toBe(format(text));
    });
  }
});
