//
// Expands the .in templates using syntaxes/m2-tokens.json, which
// generate-grammar.m2 produces from a running Macaulay2.
//
// This half is deliberately plain JavaScript with no Macaulay2 dependency:
// m2-tokens.json is checked in, so the tests can re-run this without starting
// M2 and verify the committed grammars really match their templates.
//
// Run via "npm run update", or directly: node scripts/generate-syntax.js
//

const fs = require("fs");
const path = require("path");
const prettier = require("prettier");

const root = path.resolve(__dirname, "..");

//
// Generated files are written already formatted, so that "npm run format" is a
// no-op on them.  Otherwise formatting them by hand would make them differ
// from what the generator produces, which the up-to-date check in CI reads as
// drift.
//
function format(outfile, contents) {
  return prettier.format(contents, { filepath: path.join(root, outfile) });
}

//
// Which body form each SimpleDoc section takes.
//
// This cannot come from Macaulay2.  NodeFunctions and friends map a keyword to
// a handler function; the body form is a decision made inside that function,
// not something recorded in the table.  So it is hard-coded here -- but
// checked against the keyword names M2 reports, so that a keyword added
// upstream fails the build instead of silently going unhighlighted.
//
const simpleDocBodyForms = {
  // Sections whose bodies are further sections.
  container: ["Node", "Description", "Synopsis", "Consequences"],
  // Bodies that are Macaulay2 code, evaluated or run.
  code: ["Key", "SeeAlso", "SourceCode", "BaseFunction", "Code", "Example"],
  // Bodies taken as raw text with a common indent removed.
  verbatim: ["Pre", "CannedExample", "Citation"],
  // Bodies that are TeX prose with @...@ escapes to Macaulay2.
  prose: [
    "Text",
    "Caveat",
    "Acknowledgement",
    "Contributors",
    "References",
    "Item",
  ],
  // Bodies that are "name:Type -- abbreviation" item heads.
  items: ["Inputs", "Outputs"],
  // Bodies that are menu entries.
  menu: ["Subnodes", "Tree"],
  // Bodies taken as plain strings, with no inline layer.
  plain: ["Headline", "Heading", "Usage", "ExampleFiles"],
};

function checkSimpleDocCoverage(simpledoc) {
  const fromM2 = new Set(
    [].concat(...Object.values(simpledoc)).map((name) => name),
  );
  const assigned = new Set(
    [].concat(...Object.values(simpleDocBodyForms)).map((name) => name),
  );

  const unassigned = [...fromM2].filter((name) => !assigned.has(name)).sort();
  if (unassigned.length > 0) {
    throw new Error(
      `SimpleDoc keywords with no body form assigned in ` +
        `scripts/generate-syntax.js: ${unassigned.join(", ")}. ` +
        `Add each to simpleDocBodyForms.`,
    );
  }

  const stale = [...assigned].filter((name) => !fromM2.has(name)).sort();
  if (stale.length > 0) {
    throw new Error(
      `simpleDocBodyForms lists keywords Macaulay2 no longer defines: ` +
        `${stale.join(", ")}.`,
    );
  }
}

/** Escape a literal for use inside a regex alternation. */
function escapeRegex(literal) {
  return literal.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

/** Escape a literal for use inside a [...] character class. */
function escapeCharClass(literal) {
  return literal.replace(/[\\\]^-]/g, "\\$&");
}

const byLengthDescending = (a, b) => b.length - a.length || (a < b ? -1 : 1);

//
// Alternation order matters: Oniguruma (and JavaScript) try branches left to
// right and take the first that matches, not the longest.  Without this, "="
// would shadow "==" and "/" would shadow "//".
//
function alternation(literals) {
  return [...literals].sort(byLengthDescending).map(escapeRegex).join("|");
}

//
// Sorting by length only fixes shadowing *within* one alternation.  The
// assignment and non-assignment operators are separate patterns so they can
// carry separate scopes, and TextMate tries patterns in order -- so the
// assignment "=" would still shadow the comparison "==" that lives in the
// later pattern, splitting it into two assignments.
//
// Guard each operator that is a strict prefix of an operator in the other
// group with a negative lookahead, so it declines to match and the longer
// operator's pattern gets its turn.  Today this affects exactly one operator
// ("=", ahead of "==", "===", "=!=" and friends), but deriving it keeps that
// true as Macaulay2 changes.
//
function guardedAlternation(literals, otherGroup) {
  return [...literals]
    .sort(byLengthDescending)
    .map((literal) => {
      const followers = [
        ...new Set(
          [...otherGroup]
            .filter((o) => o.length > literal.length && o.startsWith(literal))
            .map((o) => o[literal.length]),
        ),
      ].sort();

      const escaped = escapeRegex(literal);
      if (followers.length === 0) return escaped;
      return `${escaped}(?![${followers.map(escapeCharClass).join("")}])`;
    })
    .join("|");
}

/** Build the replacement table for the templates. */
function buildSubstitutions(tokens) {
  checkSimpleDocCoverage(tokens.simpledoc);

  const substitutions = {
    "@M2VERSION@": tokens.version,
    "@M2KEYWORDS@": tokens.symbols.keywords.join("|"),
    "@M2DATATYPES@": tokens.symbols.types.join("|"),
    "@M2FUNCTIONS@": tokens.symbols.functions.join("|"),
    "@M2CONSTANTS@": tokens.symbols.constants.join("|"),
    "@M2ASSIGNOPS@": guardedAlternation(
      tokens.operators.assignment,
      tokens.operators.other,
    ),
    "@M2OPERATORS@": alternation(tokens.operators.other),
    "@M2SPACEDOPS@": JSON.stringify(
      [...tokens.operators.spaced].sort(
        (a, b) => b.length - a.length || (a < b ? -1 : 1),
      ),
      null,
      2,
    ),
  };

  // SimpleDoc section keywords are matched as whole lines, so they need no
  // escaping -- every one of them is alphanumeric.
  for (const [form, names] of Object.entries(simpleDocBodyForms)) {
    substitutions[`@SIMPLEDOC_${form.toUpperCase()}@`] = [...names]
      .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
      .join("|");
  }

  return substitutions;
}

function substitute(text, substitutions) {
  return text.replace(/@[A-Z0-9_]+@/g, (placeholder) => {
    if (!(placeholder in substitutions)) {
      throw new Error(`unknown placeholder ${placeholder}`);
    }
    return substitutions[placeholder];
  });
}

/** Rewrite every string in a parsed JSON document. */
function substituteDeep(node, substitutions) {
  if (typeof node === "string") return substitute(node, substitutions);
  if (Array.isArray(node)) {
    return node.map((child) => substituteDeep(child, substitutions));
  }
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        key,
        substituteDeep(value, substitutions),
      ]),
    );
  }
  return node;
}

//
// A JSON template is expanded structurally rather than as text: parse it,
// substitute into the string *values*, and let JSON.stringify re-encode.
//
// Doing it textually is a trap.  A placeholder sits inside a JSON string
// literal, so an operator alternation's backslashes need escaping for JSON on
// top of the escaping they already carry for the regex engine -- a bare \. is
// not a legal JSON escape, and gets you a grammar that will not parse at all.
// This way the encoding is correct by construction.
//
function expand(outfile, template, substitutions) {
  if (!outfile.endsWith(".json")) return substitute(template, substitutions);
  const document = substituteDeep(JSON.parse(template), substitutions);
  return JSON.stringify(document, null, 2) + "\n";
}

const outputs = [
  [
    "syntaxes/macaulay2.tmLanguage.json",
    "syntaxes/macaulay2.tmLanguage.json.in",
  ],
  [
    "syntaxes/simpledoc.tmLanguage.json",
    "syntaxes/simpledoc.tmLanguage.json.in",
  ],
  ["src/backend/operators.ts", "src/backend/operators.ts.in"],
];

/**
 * Render every generated file.  Returns a { path: contents } map without
 * touching the disk, so tests can compare against what is committed.
 */
async function render(tokens) {
  const substitutions = buildSubstitutions(tokens);
  const rendered = {};

  for (const [outfile, template] of outputs) {
    rendered[outfile] = await format(
      outfile,
      expand(
        outfile,
        fs.readFileSync(path.join(root, template), "utf8"),
        substitutions,
      ),
    );
  }

  return rendered;
}

function readTokens() {
  return JSON.parse(
    fs.readFileSync(path.join(root, "syntaxes", "m2-tokens.json"), "utf8"),
  );
}

//
// generate-grammar.m2 writes these two through Macaulay2's Style package and
// its JSON package, neither of which knows about prettier, so tidy them up
// here rather than leaving them as the only unformatted files in the tree.
//
const generatedElsewhere = [
  "src/backend/completionProviders.ts",
  "syntaxes/m2-tokens.json",
];

async function main() {
  const rendered = await render(readTokens());
  for (const [outfile, contents] of Object.entries(rendered)) {
    console.error(`generating ${outfile}`);
    fs.writeFileSync(path.join(root, outfile), contents);
  }

  for (const outfile of generatedElsewhere) {
    const file = path.join(root, outfile);
    console.error(`formatting ${outfile}`);
    fs.writeFileSync(file, await format(outfile, fs.readFileSync(file, "utf8")));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = {
  render,
  readTokens,
  escapeRegex,
  alternation,
  outputs,
  generatedElsewhere,
  format,
};
