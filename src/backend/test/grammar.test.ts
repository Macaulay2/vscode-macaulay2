//
// Validation for the TextMate grammars in syntaxes/.
//
// These grammars are generated (see generate-grammar.m2), and they are also
// re-parsed at runtime by getWebviewSyntax() in repl.ts to build the webview
// REPL highlighter.  That second consumer compiles the patterns with the
// browser's own RegExp engine, so every regex here has to be valid JavaScript
// as well as valid Oniguruma -- which rules out POSIX classes such as
// [[:alpha:]], \h, and inline (?x) flags.  Nothing else checks that.
//

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import * as oniguruma from "vscode-oniguruma";
import * as textmate from "vscode-textmate";

import {
  extractWordsFromTextMateMatch,
  WEBVIEW_SYNTAX_REPOSITORY_KEYS,
} from "../repl";

const projectRoot = path.resolve(__dirname, "..", "..");
const syntaxesDir = path.join(projectRoot, "syntaxes");

interface TextMatePattern {
  name?: string;
  match?: string;
  begin?: string;
  end?: string;
  while?: string;
  patterns?: TextMatePattern[];
  repository?: { [key: string]: TextMatePattern };
  [key: string]: unknown;
}

const regexKeys = ["match", "begin", "end", "while"] as const;

function readGrammar(file: string): TextMatePattern {
  return JSON.parse(fs.readFileSync(path.join(syntaxesDir, file), "utf8"));
}

/** Every regex in the grammar, paired with a path describing where it lives. */
function collectRegexes(node: unknown, where: string): [string, string][] {
  const found: [string, string][] = [];

  if (Array.isArray(node)) {
    node.forEach((child, index) =>
      found.push(...collectRegexes(child, `${where}[${index}]`)),
    );
    return found;
  }

  if (node === null || typeof node !== "object") return found;

  for (const [key, value] of Object.entries(node)) {
    if (
      (regexKeys as readonly string[]).includes(key) &&
      typeof value === "string"
    ) {
      found.push([value, `${where}.${key}`]);
    } else {
      found.push(...collectRegexes(value, `${where}.${key}`));
    }
  }

  return found;
}

const grammarFiles = fs
  .readdirSync(syntaxesDir)
  .filter((file) => file.endsWith(".json") && file.endsWith("tmLanguage.json"));

//
// Tokenizing for real is the only way to test a TextMate grammar: the scopes
// that come out depend on rule ordering, on the rule stack, and on Oniguruma's
// leftmost-first alternation, none of which are visible by reading the JSON.
//
const scopeNames: { [scope: string]: string } = {
  "source.macaulay2": "macaulay2.tmLanguage.json",
  "text.macaulay2.simpledoc": "simpledoc.tmLanguage.json",
};

let registry: textmate.Registry | undefined;

async function tokenize(source: string): Promise<[string, string][]> {
  if (!registry) {
    const wasm = fs.readFileSync(
      path.join(
        projectRoot,
        "node_modules",
        "vscode-oniguruma",
        "release",
        "onig.wasm",
      ),
    );
    await oniguruma.loadWASM(wasm.buffer as ArrayBuffer);
    registry = new textmate.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
        createOnigString: (str) => new oniguruma.OnigString(str),
      }),
      loadGrammar: async (scope) =>
        scope in scopeNames
          ? (readGrammar(scopeNames[scope]) as unknown as textmate.IRawGrammar)
          : null,
    });
  }

  const grammar = await registry.loadGrammar("source.macaulay2");
  if (!grammar) throw new Error("could not load source.macaulay2");

  const tokens: [string, string][] = [];
  let ruleStack = textmate.INITIAL;

  for (const line of source.split("\n")) {
    const result = grammar.tokenizeLine(line, ruleStack);
    ruleStack = result.ruleStack;
    for (const token of result.tokens) {
      const text = line.slice(token.startIndex, token.endIndex);
      if (text.trim() === "") continue;
      tokens.push([text, token.scopes[token.scopes.length - 1]]);
    }
  }

  return tokens;
}

/** The innermost scope covering the first occurrence of `text`. */
async function scopeOf(source: string, text: string): Promise<string> {
  const tokens = await tokenize(source);
  const hit = tokens.find(([tokenText]) => tokenText.trim() === text);
  assert.ok(
    hit,
    `no token exactly matching ${JSON.stringify(text)} in:\n` +
      tokens.map(([t, s]) => `  ${JSON.stringify(t)} ${s}`).join("\n"),
  );
  return hit[1];
}

suite("TextMate Grammars", () => {
  test("syntaxes/ contains the grammars the extension contributes", () => {
    assert.ok(
      grammarFiles.includes("macaulay2.tmLanguage.json"),
      `expected macaulay2.tmLanguage.json in ${syntaxesDir}`,
    );
  });

  grammarFiles.forEach((file) => {
    suite(file, () => {
      test("is valid JSON with a scopeName", () => {
        const grammar = readGrammar(file);
        assert.strictEqual(typeof grammar.scopeName, "string");
      });

      test("every pattern compiles as a JavaScript RegExp", () => {
        const grammar = readGrammar(file);
        const failures: string[] = [];

        collectRegexes(grammar, file).forEach(([source, where]) => {
          try {
            new RegExp(source);
          } catch (err) {
            failures.push(`${where}: ${source} -- ${(err as Error).message}`);
          }
        });

        assert.deepStrictEqual(
          failures,
          [],
          `patterns that do not compile:\n${failures.join("\n")}`,
        );
      });

      test("has no unsubstituted generator placeholders", () => {
        const raw = fs.readFileSync(path.join(syntaxesDir, file), "utf8");
        const leftover = raw.match(/@[A-Z0-9_]+@/g);
        assert.strictEqual(
          leftover,
          null,
          `run "npm run update"; leftover placeholders: ${leftover?.join(", ")}`,
        );
      });

      test("every pattern is reachable from the root or an include", () => {
        const grammar = readGrammar(file);
        const repository = grammar.repository ?? {};
        const raw = fs.readFileSync(path.join(syntaxesDir, file), "utf8");

        const unreferenced = Object.keys(repository).filter(
          (key) => !raw.includes(`"#${key}"`),
        );

        assert.deepStrictEqual(
          unreferenced,
          [],
          `repository entries nothing includes: ${unreferenced.join(", ")}`,
        );
      });
    });
  });

  //
  // getWebviewSyntax() in repl.ts only understands two shapes: a word list
  // whose match ends in \b(a|b|c)\b with no inner parentheses, or a raw regex
  // it hands to the browser.  Word patterns that lose that tail shape silently
  // degrade the webview from per-word highlighting to one giant alternation,
  // so pin the shape here rather than discovering it in the REPL.
  //
  suite("webview highlighter contract", () => {
    const grammar = readGrammar("macaulay2.tmLanguage.json");

    test("every repository entry the webview reads still exists", () => {
      // getWebviewSyntax looks these up by name at runtime and silently
      // returns nothing if one is renamed.
      WEBVIEW_SYNTAX_REPOSITORY_KEYS.forEach((key) =>
        assert.ok(
          grammar.repository?.[key]?.patterns,
          `repository.${key}.patterns is missing`,
        ),
      );
    });

    test("operator and number patterns compile in the browser", () => {
      // These do not have the \\b(a|b|c)\\b word shape, so the webview hands
      // them to the browser's RegExp as raw source.
      const raw: string[] = [];

      WEBVIEW_SYNTAX_REPOSITORY_KEYS.forEach((key) => {
        (grammar.repository?.[key]?.patterns ?? []).forEach((pattern) => {
          if (!pattern.match) return;
          if (extractWordsFromTextMateMatch(pattern.match)) return;
          raw.push(pattern.match);
          new RegExp(pattern.match);
        });
      });

      assert.ok(raw.length > 0, "expected some raw operator/number patterns");
    });

    test("the four word lists are still extractable", () => {
      const wordListSizes: { [name: string]: number } = {};

      [
        grammar.repository?.keywords?.patterns,
        grammar.repository?.support?.patterns,
      ].forEach((group) => {
        (group ?? []).forEach((pattern) => {
          if (!pattern.name || !pattern.match) return;
          const words = extractWordsFromTextMateMatch(pattern.match);
          if (words) wordListSizes[pattern.name] = words.length;
        });
      });

      const names = Object.keys(wordListSizes).sort();
      assert.deepStrictEqual(names, [
        "constant.language.macaulay2",
        "entity.name.type.macaulay2",
        "keyword.control.macaulay2",
        "support.function.macaulay2",
      ]);

      // Style.m2 refuses to generate fewer than 1500 symbols overall, so these
      // lists should be large; a collapsed one means the generator misfired.
      names.forEach((name) =>
        assert.ok(
          wordListSizes[name] > 20,
          `${name} only produced ${wordListSizes[name]} words`,
        ),
      );
    });
  });

  suite("generated files are in sync with their templates", () => {
    test("re-rendering the templates reproduces what is committed", async () => {
      // Pure JavaScript over the checked-in m2-tokens.json, so this runs
      // without Macaulay2 and catches a grammar edited in the .json instead of
      // the .in, or a generator that was never re-run.
      // Loaded through a computed path so esbuild leaves it as a runtime
      // require: bundling it would rebase its __dirname into out/.
      const generatorPath = path.join(
        projectRoot,
        "scripts",
        "generate-syntax.js",
      );
      const { render, readTokens, format, generatedElsewhere } =
        require(generatorPath);

      const rendered: { [file: string]: string } = await render(readTokens());

      for (const [outfile, contents] of Object.entries(rendered)) {
        const committed = fs.readFileSync(
          path.join(projectRoot, outfile),
          "utf8",
        );
        assert.strictEqual(
          contents,
          committed,
          `${outfile} does not match its template; run "npm run update"`,
        );
      }

      // The files Macaulay2 writes directly are not re-rendered here, but they
      // should still be formatted, or "npm run format" would change them and
      // the up-to-date check in CI would see drift.
      for (const outfile of generatedElsewhere as string[]) {
        const committed = fs.readFileSync(
          path.join(projectRoot, outfile),
          "utf8",
        );
        assert.strictEqual(
          await format(outfile, committed),
          committed,
          `${outfile} is not formatted; run "npm run update"`,
        );
      }
    });
  });

  suite("tokenization", () => {
    test("numbers are highlighted", async () => {
      assert.strictEqual(
        await scopeOf("n = 0x1f", "0x1f"),
        "constant.numeric.integer.macaulay2",
      );
      assert.strictEqual(
        await scopeOf("n = 0b1011", "0b1011"),
        "constant.numeric.integer.macaulay2",
      );
      assert.strictEqual(
        await scopeOf("n = 1.5e3", "1.5e3"),
        "constant.numeric.macaulay2",
      );
    });

    test("a range is not swallowed by the float pattern", async () => {
      // Without the (?!\.) guard, "1..5" lexes as the float "1." then ".5".
      const tokens = await tokenize("for i in 1..5 do print i");
      const shapes = tokens
        .filter(([text]) => ["1", "..", "5"].includes(text))
        .map(([text, scope]) => `${text}:${scope}`);

      assert.deepStrictEqual(shapes, [
        "1:constant.numeric.macaulay2",
        "..:keyword.operator.macaulay2",
        "5:constant.numeric.macaulay2",
      ]);
    });

    test("operators are scoped, longest match first", async () => {
      // "==" must not be split into two assignment "=" tokens by the
      // assignment pattern, which is tried first.
      assert.strictEqual(
        await scopeOf("if a == b then c", "=="),
        "keyword.operator.macaulay2",
      );
      assert.strictEqual(
        await scopeOf("n := 1", ":="),
        "keyword.operator.assignment.macaulay2",
      );
      assert.strictEqual(
        await scopeOf("R = QQ", "="),
        "keyword.operator.assignment.macaulay2",
      );
      assert.strictEqual(
        await scopeOf("m = a // b", "//"),
        "keyword.operator.macaulay2",
      );
    });

    test("control keywords are distinguished from functions and types", async () => {
      assert.strictEqual(
        await scopeOf("if x then y", "if"),
        "keyword.control.macaulay2",
      );
      assert.strictEqual(
        await scopeOf("m = matrix {{1}}", "matrix"),
        "support.function.macaulay2",
      );
      assert.strictEqual(
        await scopeOf("R = QQ", "QQ"),
        "entity.name.type.macaulay2",
      );
    });

    test("a double dash inside a string is not a comment", async () => {
      assert.strictEqual(
        await scopeOf('s = "a -- b"', "a -- b"),
        "string.quoted.double.macaulay2",
      );
    });

    test("a bare /// string gets no inner Macaulay2 scopes", async () => {
      const tokens = await tokenize("s = /// matrix -- text ///");
      const inner = tokens.find(([text]) => text.includes("matrix"));
      assert.ok(inner, "expected the raw text to be tokenized");
      assert.strictEqual(inner[1], "string.quoted.other.tripleslash.macaulay2");
    });

    test("TEST /// holds real Macaulay2 code", async () => {
      assert.strictEqual(
        await scopeOf("TEST /// assert(1 == 1) ///", "assert"),
        "support.function.macaulay2",
      );
    });
  });

  suite("SimpleDoc tokenization", () => {
    const docstring = [
      "doc ///",
      "  Key",
      "    myFunction",
      "  Inputs",
      "    n:ZZ -- number of rows",
      "  Description",
      "    Text",
      '      Use @TO "matrix"@ -- this dash is prose.',
      "      -- but this whole line is a comment",
      "    Example",
      "      R = QQ[x]",
      "    Pre",
      "      raw @not code@ here",
      "  Subnodes",
      "    * someNode",
      "///",
    ].join("\n");

    test("section keywords are scoped", async () => {
      for (const keyword of ["Key", "Inputs", "Description", "Text", "Pre"]) {
        assert.strictEqual(
          await scopeOf(docstring, keyword),
          "keyword.other.simpledoc.macaulay2",
          `${keyword} should be a SimpleDoc keyword`,
        );
      }
    });

    test("an @...@ span embeds Macaulay2", async () => {
      assert.strictEqual(
        await scopeOf(docstring, "TO"),
        "entity.name.type.macaulay2",
      );
    });

    test("Example bodies are Macaulay2 code", async () => {
      assert.strictEqual(
        await scopeOf(docstring, "QQ"),
        "entity.name.type.macaulay2",
      );
    });

    test("only a whole-line double dash is a comment", async () => {
      // SimpleDoc deletes lines matching ^[[:space:]]*-- and only those, so a
      // trailing "-- ..." in prose is literal text.
      assert.strictEqual(
        await scopeOf(docstring, "-- but this whole line is a comment"),
        "comment.line.double-dash.macaulay2",
      );

      const tokens = await tokenize(docstring);
      const prose = tokens.find(([text]) =>
        text.includes("this dash is prose"),
      );
      assert.ok(prose, "expected the prose tail to be tokenized");
      assert.strictEqual(prose[1], "meta.documentation.simpledoc.macaulay2");
    });

    test("item heads split into name, separator and type", async () => {
      assert.strictEqual(
        await scopeOf(docstring, "n"),
        "variable.parameter.simpledoc.macaulay2",
      );
      assert.strictEqual(
        await scopeOf(docstring, "ZZ"),
        "entity.name.type.macaulay2",
      );
      assert.strictEqual(
        await scopeOf(docstring, "-- number of rows"),
        "comment.line.double-dash.macaulay2",
      );
    });

    test("verbatim sections do not treat @...@ as code", async () => {
      const tokens = await tokenize(docstring);
      const verbatim = tokens.find(([text]) => text.includes("raw @not code@"));
      assert.ok(verbatim, "expected the Pre body to be one raw token");
      assert.strictEqual(verbatim[1], "meta.documentation.simpledoc.macaulay2");
    });

    test("menu entry prefixes are scoped", async () => {
      assert.strictEqual(
        await scopeOf(docstring, "*"),
        "punctuation.definition.list.simpledoc.macaulay2",
      );
    });
  });
});
