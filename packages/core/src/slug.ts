/** Filename/id-safe slug for a display name, with a numeric-suffix-on-collision convention used
 *  consistently across the codebase: a node name (`extract`, `extract-2`, `Canvas.tsx`'s
 *  `addNode`), a `.flow` filename (PLAN-FLOW-DSL.md §3.4/§4.1), and — once flows are file-backed
 *  — a flow's own id (§4.1: "the file's basename is the flow's stable identifier"). */
export function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "flow";
}

export function uniqueSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
