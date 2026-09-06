export type ScopePath = ReadonlyArray<{ loop: string; index: number }>;

export type PortSlot =
  | { kind: "empty" }
  | { kind: "value"; value: string }
  | { kind: "never"; reason: "branch_not_taken" | "upstream_skipped" | "upstream_failed" };

export function activationKey(nodeId: string, scope: ScopePath): string {
  if (scope.length === 0) return nodeId;
  return `${nodeId}@${scope.map((s) => `${s.loop}:${s.index}`).join("/")}`;
}

export function valueSlot(value: string): PortSlot {
  return { kind: "value", value };
}

export function neverSlot(reason: Extract<PortSlot, { kind: "never" }>["reason"]): PortSlot {
  return { kind: "never", reason };
}

export function isNever(slot: PortSlot): slot is Extract<PortSlot, { kind: "never" }> {
  return slot.kind === "never";
}

export function isValue(slot: PortSlot): slot is Extract<PortSlot, { kind: "value" }> {
  return slot.kind === "value";
}

export type SuspendReason = { type: "user_input"; prompt: string } | { type: "pause"; message?: string | undefined };
