// Auto-generated for Macaulay2-1.26.06. Do not modify this file manually.
// Regenerate with "npm run update".

/**
 * Operators the formatter puts spaces around: everything containing "=",
 * plus the arrows and "++".
 *
 * This is deliberately not the full operator list.  The formatter spaces every
 * token it is given, so including "^" or "_" would rewrite `a^2` as `a ^ 2`
 * and `x_1` as `x _ 1`.
 *
 * Sorted longest first, which is what lets the formatter match greedily.
 */
export const spacedOperators: string[] = [
  "<==>=",
  "===>=",
  "..<=",
  "<===",
  "<==>",
  "===>",
  "==>=",
  "@@?=",
  "^**=",
  "**=",
  "++=",
  "..=",
  "//=",
  "<<=",
  "<==",
  "=!=",
  "===",
  "==>",
  ">>=",
  "??=",
  "@@=",
  "\\\\=",
  "^<=",
  "^>=",
  "^^=",
  "_<=",
  "_>=",
  "|-=",
  "|_=",
  "||=",
  "!=",
  "%=",
  "&=",
  "*=",
  "++",
  "+=",
  "-=",
  "->",
  "/=",
  ":=",
  "<-",
  "<=",
  "==",
  "=>",
  ">=",
  "@=",
  "\\=",
  "^=",
  "_=",
  "|=",
  "~=",
  "·=",
  "⊠=",
  "⧢=",
  "=",
];
