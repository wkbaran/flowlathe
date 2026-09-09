/** Thrown when a model-supplied value fails validation before it reaches an argv element or a
 *  URL path segment. Distinct from `PluginArgError` (./args.js) in the same way that error is
 *  distinct from a network/vendor failure — a caller turns this into `toolFail(err.message)`. */
export class SlotError extends Error {}

const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

/** Characters `git check-ref-format` itself rejects in a ref, beyond what the shared rules below
 *  already cover. `.` alone is fine ("v1.2.3"); only the listed characters and a trailing
 *  ".lock" are ref-specific. */
const FORBIDDEN_REF_CHARS = /[\s~^:?*[\\]/;

/** A git ref: branch, tag, or sha. Reaches a URL path segment (`github_get_checks`) and an argv
 *  element (the git toolset), so it carries the union of both rule sets:
 *  - reject empty, > 255 chars, NUL, any control character
 *  - reject a leading "-" (argument injection — git-history.ts's `SHA_PATTERN` lesson: `execFile`
 *    blocks shell injection but not argument injection, and a `-`-prefixed value is parsed by git
 *    as an option)
 *  - reject any ".." path component, any leading/trailing "/", any "//" (path-segment injection —
 *    `DiscordClient.react`'s lesson: URL parsing normalizes ".." the same way a browser would)
 *  - reject whitespace, "~", "^", ":", "?", "*", "[", "\", and a trailing ".lock" (git's own
 *    check-ref-format rules — a ref containing these is invalid anyway)
 *  - allow interior "/" — "feature/thing" is an ordinary branch name */
export function gitRefSlot(value: string, label: string): string {
  if (value === "") {
    throw new SlotError(`invalid ${label}: must not be empty`);
  }
  if (value.length > 255) {
    throw new SlotError(`invalid ${label}: exceeds 255 characters`);
  }
  if (CONTROL_CHAR_PATTERN.test(value)) {
    throw new SlotError(`invalid ${label}: contains a control character`);
  }
  if (value.startsWith("-")) {
    throw new SlotError(`invalid ${label}: must not start with "-": ${JSON.stringify(value)}`);
  }
  if (value.startsWith("/") || value.endsWith("/")) {
    throw new SlotError(`invalid ${label}: must not start or end with "/": ${JSON.stringify(value)}`);
  }
  if (value.includes("//")) {
    throw new SlotError(`invalid ${label}: must not contain "//": ${JSON.stringify(value)}`);
  }
  if (value.split("/").includes("..")) {
    throw new SlotError(`invalid ${label}: must not contain a ".." path component: ${JSON.stringify(value)}`);
  }
  if (FORBIDDEN_REF_CHARS.test(value)) {
    throw new SlotError(`invalid ${label}: contains a disallowed character: ${JSON.stringify(value)}`);
  }
  if (value.endsWith(".lock")) {
    throw new SlotError(`invalid ${label}: must not end with ".lock": ${JSON.stringify(value)}`);
  }
  return value;
}

const SEGMENT_MAX_LENGTH = 100;

/** One half of an `owner/name` slug: a bare path segment, not "." or "..", no interior "/", no
 *  leading "-" (the same argument-injection concern `gitRefSlot` has), no control characters. */
function repoSegment(value: string, label: string): string {
  if (value === "") {
    throw new SlotError(`invalid ${label}: must not be empty`);
  }
  if (value.length > SEGMENT_MAX_LENGTH) {
    throw new SlotError(`invalid ${label}: exceeds ${SEGMENT_MAX_LENGTH} characters`);
  }
  if (value === "." || value === "..") {
    throw new SlotError(`invalid ${label}: must not be "." or "..": ${JSON.stringify(value)}`);
  }
  if (value.startsWith("-")) {
    throw new SlotError(`invalid ${label}: must not start with "-": ${JSON.stringify(value)}`);
  }
  if (/[\x00-\x1f\x7f/]/.test(value)) {
    throw new SlotError(`invalid ${label}: contains a disallowed character: ${JSON.stringify(value)}`);
  }
  return value;
}

/** `owner/name`. Exactly one separator; each half is a bare segment validated by `repoSegment`. */
export function repoSlugSlot(value: string, label: string): { owner: string; name: string; slug: string } {
  const parts = value.split("/");
  if (parts.length !== 2) {
    throw new SlotError(`invalid ${label}: expected "owner/name": ${JSON.stringify(value)}`);
  }
  const owner = repoSegment(parts[0]!, `${label} owner`);
  const name = repoSegment(parts[1]!, `${label} name`);
  return { owner, name, slug: `${owner}/${name}` };
}

/** An integer clamped into [min, max]. Distinct from `clampLimit` (./args.js), which silently
 *  falls back to a default — that is right for a "how many results" argument and wrong for a
 *  slot, where an unvalidatable value must not quietly become a default. This one throws. */
export function intSlot(value: unknown, label: string, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new SlotError(`invalid ${label}: must be an integer`);
  }
  if (n < min || n > max) {
    throw new SlotError(`invalid ${label}: must be between ${min} and ${max}`);
  }
  return n;
}

/** Control characters other than \n and \t (0x00-0x08, 0x0b-0x1f, 0x7f). Free text destined for
 *  a commit message / issue body / comment keeps newlines and tabs but rejects everything else,
 *  including \r. */
const TEXT_CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b-\x1f\x7f]/;

/** Free text destined for a commit message / issue body / comment: rejects NUL and control
 *  characters other than \n and \t, bounds length, and rejects a leading "-" so it can never be
 *  mistaken for an option if it ever reaches an argv position. */
export function textSlot(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new SlotError(`invalid ${label}: must be a string`);
  }
  if (value.length > maxLength) {
    throw new SlotError(`invalid ${label}: exceeds ${maxLength} characters`);
  }
  if (TEXT_CONTROL_CHAR_PATTERN.test(value)) {
    throw new SlotError(`invalid ${label}: contains a disallowed control character`);
  }
  if (value.startsWith("-")) {
    throw new SlotError(`invalid ${label}: must not start with "-"`);
  }
  return value;
}
