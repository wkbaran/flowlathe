import { parse } from "./parse.js";
import { print } from "./print.js";

/** `format(format(s)) === format(s)` for any parseable `s` — the property `flowlathe fmt --check`
 *  relies on. */
export function format(source: string): string {
  return print(parse(source));
}
