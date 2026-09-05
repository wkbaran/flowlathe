export const NODE_KINDS = ["prompt"] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export function isNodeKind(value: string): value is NodeKind {
  return (NODE_KINDS as readonly string[]).includes(value);
}
