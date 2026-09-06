import { extractTemplateVars, type NodeEmitter } from "@flowlathe/core";
import type { ContextTransformSpec } from "./schema.js";

function templatePorts(spec: ContextTransformSpec): string[] {
  if (spec.transformKind === "append") return extractTemplateVars(spec.appendTemplate ?? "");
  return [];
}

export const contextTransformEmitter: NodeEmitter<ContextTransformSpec> = {
  runtimeMethod: "contextTransform",
  inputPorts: (spec) => (spec.startsNewContext ? templatePorts(spec) : ["context", ...templatePorts(spec)]),
  outputPorts: () => ["output", "context"],
};
