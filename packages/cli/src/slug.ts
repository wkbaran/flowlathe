/** Filename-safe slug for a flow's display name, with the same numeric-suffix-on-collision
 *  convention `PLAN-FLOW-DSL.md` §3.4 specifies for node names (`extract`, `extract-2`). */
export function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "flow";
}

export function uniqueSlug(name: string, taken: Set<string>): string {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
