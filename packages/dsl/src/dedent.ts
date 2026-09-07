function leadingWhitespaceCount(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  return i;
}

function isBlank(line: string): boolean {
  return leadingWhitespaceCount(line) === line.length;
}

/**
 * Block-string dedent, the same algorithm GraphQL uses for its triple-quoted strings: strip the
 * common leading indentation of every line but the first, then drop leading/trailing blank
 * lines. This is what makes a triple-quoted prompt template readable inside an indented `node`
 * block without every rendered prompt gaining stray leading whitespace (see PLAN-FLOW-DSL.md
 * design trap #2) — `reindent` is its exact inverse for a given target indent.
 *
 * Lossy at the edges by construction: a leading/trailing blank line, or a mid-content line that
 * is pure whitespace, is not distinguishable from "no line here" once dedented, so it does not
 * survive a print/parse round trip. Golden fixtures and the fuzz generator avoid that shape.
 */
export function dedentBlockString(raw: string): string {
  const lines = raw.split(/\r\n|\r|\n/);

  let commonIndent: number | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (isBlank(line)) continue;
    const indent = leadingWhitespaceCount(line);
    if (commonIndent === undefined || indent < commonIndent) commonIndent = indent;
  }

  if (commonIndent) {
    for (let i = 1; i < lines.length; i++) {
      lines[i] = lines[i]!.slice(commonIndent);
    }
  }

  while (lines.length > 0 && isBlank(lines[0]!)) lines.shift();
  while (lines.length > 0 && isBlank(lines[lines.length - 1]!)) lines.pop();

  return lines.join("\n");
}

/** Inverse of `dedentBlockString` for printing: re-indent every line of `content` by `indent`,
 *  except blank lines, which are printed fully empty (no trailing whitespace in generated files). */
export function reindentBlockString(content: string, indent: string): string {
  return content
    .split("\n")
    .map((line) => (line.length === 0 ? "" : indent + line))
    .join("\n");
}
