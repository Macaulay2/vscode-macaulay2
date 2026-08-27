"use strict";

import * as vscode from "vscode";

import { spacedOperators } from "./operators";

type FormatterState =
  | "code"
  | "blockComment"
  | "deprecatedBlockComment"
  | "documentation";

export interface Macaulay2FormattingOptions {
  tabSize?: number;
  insertSpaces?: boolean;
}

interface FormattedLine {
  text: string;
  state: FormatterState;
  bracketDelta: number;
  leadingClosers: number;
}

// Generated from Macaulay2 itself; see generate-grammar.m2.  Already sorted
// longest first, which is what makes the greedy match below correct.
const operatorTokens = spacedOperators;

function getIndentText(
  indentLevel: number,
  options: Macaulay2FormattingOptions | vscode.FormattingOptions,
) {
  const tabSize = Math.max(1, Number(options.tabSize) || 8);
  const indentSize = options.insertSpaces === false ? 4 : tabSize;
  const columns = indentLevel * indentSize;

  if (options.insertSpaces !== false) {
    return " ".repeat(columns);
  }

  return (
    "\t".repeat(Math.floor(columns / tabSize)) + " ".repeat(columns % tabSize)
  );
}

function trimOperatorSpacing(output: string) {
  return output.replace(/[ \t]+$/u, "");
}

function appendSpacedOperator(output: string, token: string) {
  const trimmed = trimOperatorSpacing(output);
  return `${trimmed}${trimmed.length > 0 ? " " : ""}${token} `;
}

function formatCodeSegment(segment: string) {
  let output = "";
  let index = 0;

  while (index < segment.length) {
    const token = operatorTokens.find((candidate) =>
      segment.startsWith(candidate, index),
    );

    if (token) {
      output = appendSpacedOperator(output, token);
      index += token.length;
      while (index < segment.length && /[ \t]/u.test(segment[index])) {
        index++;
      }
      continue;
    }

    output += segment[index];
    index++;
  }

  output = output.replace(/[ \t]+([,;])/gu, "$1");
  output = output.replace(/,([^\s\]\)\}])/gu, ", $1");
  output = output.replace(/;([^\s\]\)\}])/gu, "; $1");
  output = output.replace(/([,;])$/u, "$1 ");

  return output;
}

function startsWithSpacedOperator(text: string) {
  return operatorTokens.some(
    (token) => text === token || text.startsWith(`${token} `),
  );
}

function countLeadingClosers(line: string) {
  const match = line.match(/^[\s\)\]\}]*/u);
  if (!match) return 0;
  return (match[0].match(/[\)\]\}]/gu) || []).length;
}

function formatLineCommentPrefix(output: string, comment: string) {
  if (comment.startsWith("---")) {
    return `${output}${comment}`;
  }

  const prefix = output.length > 0 && !/[ \t]$/u.test(output) ? " " : "";
  const body = comment.substring(2);
  if (body.length === 0 || /^\s/u.test(body)) {
    return `${output}${prefix}${comment}`;
  }

  return `${output}${prefix}-- ${body}`;
}

function scanNonCodeLine(line: string, state: FormatterState): FormattedLine {
  let index = 0;
  let currentState = state;

  while (index < line.length) {
    if (currentState === "documentation") {
      const close = line.indexOf("///", index);
      if (close < 0) break;
      index = close + 3;
      currentState = "code";
      continue;
    }

    const closeToken = currentState === "blockComment" ? "*-" : "*}";
    const close = line.indexOf(closeToken, index);
    if (close < 0) break;
    index = close + closeToken.length;
    currentState = "code";

    if (line.startsWith("///", index)) {
      currentState = "documentation";
      index += 3;
    } else if (line.startsWith("-*", index)) {
      currentState = "blockComment";
      index += 2;
    } else if (line.startsWith("{*", index)) {
      currentState = "deprecatedBlockComment";
      index += 2;
    } else {
      index++;
    }
  }

  return {
    text: line.replace(/[ \t]+$/u, ""),
    state: currentState,
    bracketDelta: 0,
    leadingClosers: 0,
  };
}

function formatCodeLine(line: string): FormattedLine {
  const content = line.trim();
  if (content.length === 0) {
    return {
      text: "",
      state: "code",
      bracketDelta: 0,
      leadingClosers: 0,
    };
  }

  const leadingClosers = countLeadingClosers(line);
  let output = "";
  let codeSegment = "";
  let bracketDelta = 0;
  let index = 0;
  let state: FormatterState = "code";

  const flushCodeSegment = () => {
    if (codeSegment.length > 0) {
      const formattedSegment = formatCodeSegment(codeSegment);
      if (
        output.length > 0 &&
        !/[ \t]$/u.test(output) &&
        startsWithSpacedOperator(formattedSegment)
      ) {
        output += " ";
      }
      output += formattedSegment;
      codeSegment = "";
    }
  };

  while (index < content.length) {
    if (content.startsWith("///", index)) {
      flushCodeSegment();
      output += content.substring(index).replace(/[ \t]+$/u, "");
      state = "documentation";
      break;
    }

    if (content.startsWith("--", index)) {
      flushCodeSegment();
      output = formatLineCommentPrefix(output, content.substring(index));
      break;
    }

    if (content.startsWith("-*", index) || content.startsWith("{*", index)) {
      flushCodeSegment();
      const closeToken = content.startsWith("-*", index) ? "*-" : "*}";
      const close = content.indexOf(closeToken, index + 2);
      if (close < 0) {
        output += content.substring(index).replace(/[ \t]+$/u, "");
        state = closeToken === "*-" ? "blockComment" : "deprecatedBlockComment";
        break;
      }

      output += content.substring(index, close + 2);
      index = close + 2;
      continue;
    }

    const char = content[index];
    if (char === '"') {
      flushCodeSegment();
      const start = index;
      index++;
      while (index < content.length) {
        if (content[index] === "\\") {
          index += 2;
        } else if (content[index] === '"') {
          index++;
          break;
        } else {
          index++;
        }
      }
      output += content.substring(start, index);
      continue;
    }

    if (char === "(" || char === "[" || char === "{") {
      bracketDelta++;
    } else if (char === ")" || char === "]" || char === "}") {
      bracketDelta--;
    }

    codeSegment += char;
    index++;
  }

  flushCodeSegment();

  return {
    text: output.replace(/[ \t]+$/u, ""),
    state,
    bracketDelta,
    leadingClosers,
  };
}

function normalizeNewlines(text: string) {
  return text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

export function formatMacaulay2Text(
  text: string,
  options: Macaulay2FormattingOptions = {},
) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const normalized = normalizeNewlines(text);
  const lines = normalized.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  const formattedLines: string[] = [];
  let state: FormatterState = "code";
  let indentLevel = 0;

  for (const line of lines) {
    const formatted =
      state === "code" ? formatCodeLine(line) : scanNonCodeLine(line, state);

    if (state === "code") {
      const lineIndentLevel = Math.max(
        0,
        indentLevel - formatted.leadingClosers,
      );
      formattedLines.push(
        formatted.text.length > 0
          ? `${getIndentText(lineIndentLevel, options)}${formatted.text}`
          : "",
      );
      indentLevel = Math.max(0, indentLevel + formatted.bracketDelta);
    } else {
      formattedLines.push(formatted.text);
    }

    state = formatted.state;
  }

  return formattedLines.length > 0
    ? `${formattedLines.join(newline)}${newline}`
    : "";
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider("macaulay2", {
      provideDocumentFormattingEdits(document, options) {
        const formatted = formatMacaulay2Text(document.getText(), options);
        if (formatted === document.getText()) {
          return [];
        }

        const lastLine = document.lineAt(document.lineCount - 1);
        const fullRange = new vscode.Range(
          new vscode.Position(0, 0),
          lastLine.rangeIncludingLineBreak.end,
        );
        return [vscode.TextEdit.replace(fullRange, formatted)];
      },
    }),
  );
}
