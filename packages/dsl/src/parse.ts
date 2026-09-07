import {
  isNodeKind,
  MergeRuleSchema,
  NODE_KINDS,
  StateValueTypeSchema,
  type FlowEdge,
  type FlowNode,
  type MergeRule,
  type StateDecl,
  type StateValueType,
} from "@flowlathe/core";
import { canonicalEdgeId, dedupeEdgeIds } from "./edge-id.js";
import { DslError } from "./errors.js";
import { tokenize, type Token } from "./lex.js";
import type { FlowFile } from "./types.js";

interface PendingEdge {
  edge: FlowEdge;
  sourceTok: Token;
  targetTok: Token;
}

const MERGE_RULES = MergeRuleSchema.options;
const STATE_TYPES = StateValueTypeSchema.options;

export function parse(source: string): FlowFile {
  const tokens = tokenize(source);
  let pos = 0;

  const peek = (offset = 0): Token => tokens[Math.min(pos + offset, tokens.length - 1)]!;
  const next = (): Token => tokens[pos++]!;

  const error = (message: string, tok: Token = peek()): never => {
    throw new DslError(message, tok.line, tok.column, source);
  };

  const expectPunct = (value: string): Token => {
    const tok = peek();
    if (tok.type !== "punct" || tok.value !== value) {
      error(`expected "${value}" but found ${describeToken(tok)}`);
    }
    return next();
  };

  const expectIdent = (word?: string): Token => {
    const tok = peek();
    if (tok.type !== "ident" || (word !== undefined && tok.value !== word)) {
      error(`expected ${word ? `"${word}"` : "an identifier"} but found ${describeToken(tok)}`);
    }
    return next();
  };

  const expectString = (): Token => {
    const tok = peek();
    if (tok.type !== "string") error(`expected a string but found ${describeToken(tok)}`);
    return next();
  };

  const isPunct = (value: string): boolean => {
    const tok = peek();
    return tok.type === "punct" && tok.value === value;
  };

  const isIdent = (word?: string): boolean => {
    const tok = peek();
    return tok.type === "ident" && (word === undefined || tok.value === word);
  };

  const usedNodeIds = new Map<string, Token>();
  const pendingEdges: PendingEdge[] = [];
  const comments: Record<string, string> = {};

  function parseValue(): unknown {
    const tok = peek();
    if (tok.type === "string") {
      next();
      return tok.value;
    }
    if (tok.type === "number") {
      next();
      return Number(tok.value);
    }
    if (tok.type === "ident" && tok.value === "true") {
      next();
      return true;
    }
    if (tok.type === "ident" && tok.value === "false") {
      next();
      return false;
    }
    if (tok.type === "ident" && tok.value === "null") {
      next();
      return null;
    }
    if (tok.type === "punct" && tok.value === "[") {
      next();
      const items: unknown[] = [];
      while (!isPunct("]")) {
        items.push(parseValue());
        if (isPunct(",")) {
          next();
          continue;
        }
        break;
      }
      expectPunct("]");
      return items;
    }
    if (tok.type === "punct" && tok.value === "{") {
      next();
      const obj: Record<string, unknown> = {};
      while (!isPunct("}")) {
        const keyTok = peek();
        const key: string =
          keyTok.type === "ident" || keyTok.type === "string"
            ? next().value
            : error(`expected an object key but found ${describeToken(keyTok)}`);
        expectPunct(":");
        obj[key] = parseValue();
        if (isPunct(",")) {
          next();
          continue;
        }
        break;
      }
      expectPunct("}");
      return obj;
    }
    error(`expected a value (string, number, boolean, null, array, or object) but found ${describeToken(tok)}`);
  }

  function parseStateDecl(): StateDecl {
    const startTok = next(); // 'state'
    const nameTok = expectIdent();
    const name = nameTok.value;

    let type: StateValueType = "string";
    if (isPunct(":")) {
      next();
      const typeTok = expectIdent();
      if (!STATE_TYPES.includes(typeTok.value as StateValueType)) {
        error(
          `unknown state type "${typeTok.value}" — expected one of: ${STATE_TYPES.join(", ")}`,
          typeTok,
        );
      }
      type = typeTok.value as StateValueType;
    }

    let merge: MergeRule | undefined;
    let initial: unknown;
    while (isIdent("merge") || isIdent("initial")) {
      const keyTok = next();
      expectPunct("=");
      if (keyTok.value === "merge") {
        const valueTok = expectIdent();
        if (!MERGE_RULES.includes(valueTok.value as MergeRule)) {
          error(`unknown merge rule "${valueTok.value}" — expected one of: ${MERGE_RULES.join(", ")}`, valueTok);
        }
        merge = valueTok.value as MergeRule;
      } else {
        initial = parseValue();
      }
    }

    if (merge === undefined) {
      return error(`state "${name}" is missing its required "merge" attribute`, startTok);
    }

    if (startTok.leadingComment) comments["state:" + name] = startTok.leadingComment;

    return initial === undefined ? { name, type, merge } : { name, type, merge, initial };
  }

  function parseEdgeDecl(): void {
    const sourceTok = expectIdent();
    expectPunct(".");
    const sourceHandleTok = expectIdent();
    expectPunct("->");
    const targetTok = expectIdent();
    expectPunct(".");
    const targetHandleTok = expectIdent();

    const edge: FlowEdge = {
      id: canonicalEdgeId(sourceTok.value, sourceHandleTok.value, targetTok.value, targetHandleTok.value),
      source: sourceTok.value,
      target: targetTok.value,
      sourceHandle: sourceHandleTok.value,
      targetHandle: targetHandleTok.value,
    };
    if (sourceTok.leadingComment) comments["edge:" + edge.id] = sourceTok.leadingComment;
    pendingEdges.push({ edge, sourceTok, targetTok });
  }

  function parseNodeDecl(parentId: string | undefined): FlowNode[] {
    const nodeTok = next(); // 'node'
    const nameTok = expectIdent();
    const name = nameTok.value;
    if (usedNodeIds.has(name)) {
      error(`duplicate node name "${name}" (already declared at line ${usedNodeIds.get(name)!.line})`, nameTok);
    }
    usedNodeIds.set(name, nameTok);

    expectPunct(":");
    const kindTok = expectIdent();
    const kindValue = kindTok.value;
    const kind = isNodeKind(kindValue)
      ? kindValue
      : error(`unknown node kind "${kindValue}" — expected one of: ${NODE_KINDS.join(", ")}`, kindTok);

    let x = 0;
    let y = 0;
    if (isPunct("@")) {
      next();
      expectPunct("(");
      const xTok = peek();
      if (xTok.type !== "number") error(`expected a number for the x position but found ${describeToken(xTok)}`);
      x = Number(next().value);
      expectPunct(",");
      const yTok = peek();
      if (yTok.type !== "number") error(`expected a number for the y position but found ${describeToken(yTok)}`);
      y = Number(next().value);
      expectPunct(")");
    }

    expectPunct("{");
    const data: Record<string, unknown> = {};
    let bodyNodes: FlowNode[] = [];
    let sawBody = false;
    while (!isPunct("}")) {
      if (isIdent("body") && peek(1).type === "punct" && peek(1).value === "{") {
        if (sawBody) error(`a node can have at most one "body" block`, peek());
        sawBody = true;
        next(); // 'body'
        expectPunct("{");
        while (!isPunct("}")) {
          if (isIdent("node")) {
            bodyNodes.push(...parseNodeDecl(name));
          } else if (isIdent()) {
            parseEdgeDecl();
          } else {
            error(`expected a "node" declaration or an edge inside a body block, found ${describeToken(peek())}`);
          }
        }
        expectPunct("}");
        continue;
      }

      const keyTok = peek();
      if (keyTok.type !== "ident") {
        error(`expected a property (name = value) or a "body" block, found ${describeToken(keyTok)}`);
      }
      next();
      expectPunct("=");
      data[keyTok.value] = parseValue();
    }
    expectPunct("}");

    if (nodeTok.leadingComment) comments["node:" + name] = nodeTok.leadingComment;

    const node: FlowNode =
      parentId === undefined
        ? { id: name, type: kind, position: { x, y }, data }
        : { id: name, type: kind, position: { x, y }, data, parentId };
    return [node, ...bodyNodes];
  }

  expectIdent("flow");
  const nameTok = expectString();
  const flowName = nameTok.value;
  expectPunct("{");

  const nodes: FlowNode[] = [];
  const state: StateDecl[] = [];

  while (!isPunct("}")) {
    if (isIdent("state")) {
      state.push(parseStateDecl());
    } else if (isIdent("node")) {
      nodes.push(...parseNodeDecl(undefined));
    } else if (isIdent()) {
      parseEdgeDecl();
    } else {
      error(
        `expected "state", "node", or an edge declaration, found ${describeToken(peek())}`,
      );
    }
  }
  expectPunct("}");

  const eofTok = peek();
  if (eofTok.type !== "eof") {
    error(`unexpected content after the flow's closing "}": ${describeToken(eofTok)}`);
  }

  for (const { edge, sourceTok, targetTok } of pendingEdges) {
    if (!usedNodeIds.has(edge.source)) {
      error(
        `edge references node "${edge.source}", which is not declared anywhere in this flow`,
        sourceTok,
      );
    }
    if (!usedNodeIds.has(edge.target)) {
      error(
        `edge references node "${edge.target}", which is not declared anywhere in this flow`,
        targetTok,
      );
    }
  }

  const edges = dedupeEdgeIds(pendingEdges.map((p) => p.edge));

  return {
    name: flowName,
    graph: { nodes, edges, state },
    comments,
  };
}

function describeToken(tok: Token): string {
  if (tok.type === "eof") return "end of file";
  if (tok.type === "string") return `a string`;
  if (tok.type === "number") return `a number`;
  return `"${tok.value}"`;
}
