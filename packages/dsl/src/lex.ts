import { dedentBlockString } from "./dedent.js";
import { DslError } from "./errors.js";

export type TokenType = "ident" | "string" | "number" | "punct" | "eof";

export interface Token {
  type: TokenType;
  /** ident: the identifier text. string: the decoded/dedented content. number: the raw digits
   *  (parse with Number(...) at the parser). punct: the punctuation text ("{", "->", ...). */
  value: string;
  line: number;
  column: number;
  /** string tokens only: was this a `"""..."""` block string. */
  isTriple?: boolean;
  /** Comment line(s) immediately above this token with no blank line in between — see
   *  PLAN-FLOW-DSL.md §3.5. Undefined when there is none. */
  leadingComment?: string | undefined;
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}
function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}
function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const len = source.length;
  let pos = 0;
  let line = 1;
  let column = 1;

  let pendingComment: string[] = [];
  let pendingCommentLastLine = -1;

  const peekChar = (offset = 0): string => source[pos + offset] ?? "";

  const advance = (): string => {
    const ch = source[pos]!;
    pos++;
    if (ch === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
    return ch;
  };

  const fail = (message: string, atLine = line, atColumn = column): never => {
    throw new DslError(message, atLine, atColumn, source);
  };

  const takeLeadingComment = (tokenLine: number): string | undefined => {
    const comment =
      pendingComment.length > 0 && tokenLine === pendingCommentLastLine + 1
        ? pendingComment.join("\n")
        : undefined;
    pendingComment = [];
    pendingCommentLastLine = -1;
    return comment;
  };

  while (pos < len) {
    const ch = peekChar();

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      advance();
      continue;
    }

    if (ch === "#") {
      const commentLine = line;
      let text = "";
      advance(); // consume '#'
      while (pos < len && peekChar() !== "\n") text += advance();
      const trimmed = text.startsWith(" ") ? text.slice(1) : text;
      if (pendingComment.length > 0 && commentLine !== pendingCommentLastLine + 1) {
        pendingComment = [];
      }
      pendingComment.push(trimmed);
      pendingCommentLastLine = commentLine;
      continue;
    }

    const startLine = line;
    const startColumn = column;

    if (ch === '"') {
      const isTriple = peekChar(1) === '"' && peekChar(2) === '"';
      if (isTriple) {
        advance();
        advance();
        advance();
        let raw = "";
        while (true) {
          if (pos >= len) fail("unterminated triple-quoted string", startLine, startColumn);
          if (peekChar() === '"' && peekChar(1) === '"' && peekChar(2) === '"') {
            advance();
            advance();
            advance();
            break;
          }
          raw += advance();
        }
        tokens.push({
          type: "string",
          value: dedentBlockString(raw),
          line: startLine,
          column: startColumn,
          isTriple: true,
          leadingComment: takeLeadingComment(startLine),
        });
        continue;
      }

      advance(); // opening '"'
      let value = "";
      while (true) {
        if (pos >= len) fail("unterminated string", startLine, startColumn);
        const c = peekChar();
        if (c === "\n") fail("unterminated string (newline in a non-triple-quoted string)", startLine, startColumn);
        if (c === '"') {
          advance();
          break;
        }
        if (c === "\\") {
          advance();
          const esc = peekChar();
          switch (esc) {
            case '"':
              value += '"';
              advance();
              break;
            case "\\":
              value += "\\";
              advance();
              break;
            case "n":
              value += "\n";
              advance();
              break;
            case "t":
              value += "\t";
              advance();
              break;
            case "r":
              value += "\r";
              advance();
              break;
            case "u": {
              advance();
              let hex = "";
              for (let i = 0; i < 4; i++) {
                if (!/[0-9a-fA-F]/.test(peekChar())) fail("invalid \\u escape", line, column);
                hex += advance();
              }
              value += String.fromCharCode(parseInt(hex, 16));
              break;
            }
            default:
              fail(`unknown escape sequence "\\${esc}"`, line, column);
          }
          continue;
        }
        value += advance();
      }
      tokens.push({
        type: "string",
        value,
        line: startLine,
        column: startColumn,
        leadingComment: takeLeadingComment(startLine),
      });
      continue;
    }

    if (isDigit(ch) || (ch === "-" && isDigit(peekChar(1)))) {
      let text = "";
      if (ch === "-") text += advance();
      while (isDigit(peekChar())) text += advance();
      if (peekChar() === "." && isDigit(peekChar(1))) {
        text += advance();
        while (isDigit(peekChar())) text += advance();
      }
      if (peekChar() === "e" || peekChar() === "E") {
        let lookahead = 1;
        if (peekChar(lookahead) === "+" || peekChar(lookahead) === "-") lookahead++;
        if (isDigit(peekChar(lookahead))) {
          text += advance();
          if (peekChar() === "+" || peekChar() === "-") text += advance();
          while (isDigit(peekChar())) text += advance();
        }
      }
      tokens.push({
        type: "number",
        value: text,
        line: startLine,
        column: startColumn,
        leadingComment: takeLeadingComment(startLine),
      });
      continue;
    }

    if (isIdentStart(ch)) {
      let text = advance();
      while (true) {
        if (isIdentPart(peekChar())) {
          text += advance();
          continue;
        }
        if (peekChar() === "-" && isIdentPart(peekChar(1))) {
          text += advance();
          continue;
        }
        break;
      }
      tokens.push({
        type: "ident",
        value: text,
        line: startLine,
        column: startColumn,
        leadingComment: takeLeadingComment(startLine),
      });
      continue;
    }

    if (ch === "-" && peekChar(1) === ">") {
      advance();
      advance();
      tokens.push({
        type: "punct",
        value: "->",
        line: startLine,
        column: startColumn,
        leadingComment: takeLeadingComment(startLine),
      });
      continue;
    }

    if ("{}()[]:,=.@".includes(ch)) {
      advance();
      tokens.push({
        type: "punct",
        value: ch,
        line: startLine,
        column: startColumn,
        leadingComment: takeLeadingComment(startLine),
      });
      continue;
    }

    fail(`unexpected character "${ch}"`, startLine, startColumn);
  }

  tokens.push({ type: "eof", value: "", line, column });
  return tokens;
}
