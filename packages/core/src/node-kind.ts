export const NODE_KINDS = [
  "prompt",
  "router",
  "merge",
  "loop",
  "map",
  "pause",
  "userInput",
  "gate",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export function isNodeKind(value: string): value is NodeKind {
  return (NODE_KINDS as readonly string[]).includes(value);
}
