export type WebviewOutputMode = "webapp" | "standard";

export function isProtocolNewline(text: string): boolean {
  return /^\n+$/.test(text);
}

// WebApp puts its record-separator newline between tagged HTML fragments. Keep
// that newline in the container that owns those fragments so DOM order matches
// the byte stream and preformatted whitespace can render it exactly.
export function shouldAppendProtocolNewlineToPreviousOutput(
  text: string,
  previousIsOutputContainer: boolean,
  previousIsStandardOutput: boolean,
  outputMode: WebviewOutputMode,
): boolean {
  return (
    isProtocolNewline(text) &&
    previousIsOutputContainer &&
    previousIsStandardOutput === (outputMode === "standard")
  );
}

export function shouldPromoteWebappOutputToBlock(text: string): boolean {
  return text.includes("\n") && !isProtocolNewline(text);
}

export function splitTrailingProtocolNewline(
  text: string,
): { content: string; newline: string } | null {
  const match = /\n+$/.exec(text);
  if (!match) return null;
  return {
    content: text.substring(0, match.index),
    newline: match[0],
  };
}
