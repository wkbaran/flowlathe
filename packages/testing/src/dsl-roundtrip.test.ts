import { readFileSync } from "node:fs";
import { normalizeForRoundTrip, parse, print, type FlowFile } from "@flowlathe/dsl";
import type { FlowGraph } from "@flowlathe/core";
import { describe, expect, it } from "vitest";

import { failingFanOutGraph } from "./golden/failing-fan-out.js";
import { fanOutGraph } from "./golden/fan-out.js";
import { fileStateNodeGraph } from "./golden/file-state-node.js";
import { loopRouterBodyGraph } from "./golden/loop-router-body.js";
import { mapFanoutGraph } from "./golden/map-fanout.js";
import { mapMultinodeBodyGraph } from "./golden/map-multinode-body.js";
import { nestedMapInLoopGraph } from "./golden/nested-map-in-loop.js";
import { routerDeepBranchGraph } from "./golden/router-deep-branch.js";
import { routerMergeGraph } from "./golden/router-merge.js";
import { routerNestedGraph } from "./golden/router-nested.js";
import { routerUntakenLoopGraph } from "./golden/router-untaken-loop.js";
import { routerUntakenMapGraph } from "./golden/router-untaken-map.js";
import { searchNodeGraph } from "./golden/search-node.js";
import { stateToolsGraph } from "./golden/state-tools.js";
import { twoNodeChainGraph } from "./golden/two-node-chain.js";

/** One `.flow` sibling per `packages/testing/src/golden/*.ts` graph (PLAN-FLOW-DSL.md §6/§9) —
 *  committed, so a printer change shows up as a readable diff in review. Regenerate via:
 *    pnpm --filter @flowlathe/testing exec tsx -e '...' (see PLAN-FLOW-DSL.md history, or just
 *    print(golden) and paste it over the .flow file when a deliberate format change lands). */
const GOLDEN: { slug: string; graph: FlowGraph }[] = [
  { slug: "failing-fan-out", graph: failingFanOutGraph },
  { slug: "fan-out", graph: fanOutGraph },
  { slug: "file-state-node", graph: fileStateNodeGraph },
  { slug: "loop-router-body", graph: loopRouterBodyGraph },
  { slug: "map-fanout", graph: mapFanoutGraph },
  { slug: "map-multinode-body", graph: mapMultinodeBodyGraph },
  { slug: "nested-map-in-loop", graph: nestedMapInLoopGraph },
  { slug: "router-deep-branch", graph: routerDeepBranchGraph },
  { slug: "router-merge", graph: routerMergeGraph },
  { slug: "router-nested", graph: routerNestedGraph },
  { slug: "router-untaken-loop", graph: routerUntakenLoopGraph },
  { slug: "router-untaken-map", graph: routerUntakenMapGraph },
  { slug: "search-node", graph: searchNodeGraph },
  { slug: "state-tools", graph: stateToolsGraph },
  { slug: "two-node-chain", graph: twoNodeChainGraph },
];

describe("DSL round trip over the golden corpus", () => {
  for (const { slug, graph } of GOLDEN) {
    describe(slug, () => {
      const file: FlowFile = { name: slug, graph, comments: {} };
      const committedPath = new URL(`./golden/${slug}.flow`, import.meta.url);
      const committedText = readFileSync(committedPath, "utf8");

      it("matches the committed .flow fixture (printer drift shows up here)", () => {
        expect(print(file)).toBe(committedText);
      });

      it("parse(print(g)) round-trips to g (modulo edge-id/handle normalization, §3.5)", () => {
        const reparsed = parse(print(file));
        expect(reparsed.name).toBe(slug);
        expect(normalizeForRoundTrip(reparsed.graph)).toEqual(normalizeForRoundTrip(graph));
      });

      it("parsing the committed file itself round-trips the same way", () => {
        const reparsed = parse(committedText);
        expect(normalizeForRoundTrip(reparsed.graph)).toEqual(normalizeForRoundTrip(graph));
      });

      it("format(format(committed)) === format(committed)", () => {
        const once = print(parse(committedText));
        const twice = print(parse(once));
        expect(twice).toBe(once);
      });
    });
  }
});
