export class DslError extends Error {
  readonly line: number;
  readonly column: number;
  readonly sourceExcerpt: string;

  constructor(message: string, line: number, column: number, source: string) {
    const excerpt = buildExcerpt(source, line, column);
    super(`${message} (line ${line}, column ${column})\n${excerpt}`);
    this.name = "DslError";
    this.line = line;
    this.column = column;
    this.sourceExcerpt = excerpt;
  }
}

function buildExcerpt(source: string, line: number, column: number): string {
  const lines = source.split("\n");
  const lineText = lines[line - 1] ?? "";
  const pointer = `${" ".repeat(Math.max(0, column - 1))}^`;
  return `${lineText}\n${pointer}`;
}
