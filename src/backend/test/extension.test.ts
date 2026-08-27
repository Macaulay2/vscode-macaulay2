//
// Note: This example test is leveraging the Mocha test framework.
// Please refer to their documentation on https://mochajs.org/ for help.
//

// The module 'assert' provides assertion methods from node
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { spawnSync } from "child_process";

import {
  formatM2ExecutablePathForStatusBar,
  getM2ExecutablePathOptions,
  getM2ExecutableStatusText,
} from "../executableSwitcher";
import {
  getM2ExecutableResolutionDetail,
  getM2LaunchConfiguration,
  M2ExecutableResolution,
  normalizeM2LaunchArgs,
  resolveM2Executable,
  windowsPathToWslPath,
  wslPathToWindowsPath,
} from "../executablePath";
import {
  getM2OutputFileLocationLinks,
  getM2ProcessExitMessage,
  getM2StartupPatch,
  getM2TerminalProcessArgs,
  getM2WebviewProcessArgs,
  getParagraphLineRange,
  shouldCloseWebviewOnM2Input,
} from "../repl";
import { formatMacaulay2Text } from "../formatter";
import { spacedOperators } from "../operators";

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
// import * as vscode from 'vscode';
// import * as myExtension from '../extension';

const M2_PATCH_COMPATIBILITY_SENTINEL = "PATCH_CONTRACT_OK";

function getM2StartupPatchCompatibilityScript(): string {
  return [
    getM2StartupPatch(),
    'fetchAny = value ((Core#"private dictionary")#"fetchAnyRawDocumentation")',
    "rawdoc = fetchAny makeDocumentTag hilbertFunction",
    "assert(rawdoc =!= null)",
    "rawtag = rawdoc.DocumentTag",
    'rawTable = (package rawtag)#"raw documentation"',
    "fkey = format rawtag",
    "had = rawTable#?fkey",
    "if had then oldRawDoc = rawTable#fkey",
    'oldDocumentTag = value ((Core#"private dictionary")#"currentDocumentTag")',
    "renderedTopHelp = vscodeM2ExtensionTopHelp makeDocumentTag hilbertFunction",
    'assert(value ((Core#"private dictionary")#"currentDocumentTag") === oldDocumentTag)',
    "if had then assert(rawTable#fkey === oldRawDoc) else assert(not rawTable#?fkey)",
    'filePositionHtml = html new FilePosition from ("stdio", 1, 1)',
    'assert(filePositionHtml === "<samp><a href=\\"stdio#L1:C1\\">stdio:1:1</a></samp>")',
    'assert(texMath Type === "\\\\texttt{Type}")',
    "oldTopLevelMode = topLevelMode",
    "topLevelMode = WebApp",
    '(captureErr, captureOutput) = capture "5+5"',
    "assert(topLevelMode === WebApp)",
    "topLevelMode = oldTopLevelMode",
    "assert(captureErr === false)",
    'assert(match("i1 : 5[+]5", captureOutput))',
    'assert(match("o1 = 10", captureOutput))',
    "assert(all({14, 17, 18, 19, 20, 21, 28, 29, 30}, tag -> not match(ascii tag, captureOutput)))",
    "vscodeM2ExtensionMatrixKatexMaxEntries = 4",
    "smallMatrix = random(ZZ^2, ZZ^2)",
    "largeMatrix = random(ZZ^2, ZZ^3)",
    'assert(match("array", html smallMatrix))',
    'assert(match("<pre class=\\"token net\\"", html largeMatrix))',
    'assert(match("<pre class=\\"token net\\"", html mutableMatrix largeMatrix))',
    'assert(match("-- code for method:", toString code hilbertFunction))',
    `print "${M2_PATCH_COMPATIBILITY_SENTINEL}"`,
  ].join("\n");
}

function writeTemporaryM2Script(contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-macaulay2-"));
  const scriptPath = path.join(directory, "startup-patch-compatibility.m2");
  fs.writeFileSync(scriptPath, contents, "utf8");
  return scriptPath;
}

function removeTemporaryM2Script(scriptPath: string) {
  try {
    fs.unlinkSync(scriptPath);
    fs.rmdirSync(path.dirname(scriptPath));
  } catch {
    // Best effort cleanup only.
  }
}

function getM2ScriptInvocation(
  resolution: M2ExecutableResolution,
  scriptPath: string,
): { executablePath: string; args: string[] } {
  if (resolution.wslExecutablePath) {
    return {
      executablePath: resolution.executablePath,
      args: [
        "--exec",
        resolution.wslExecutablePath,
        "--script",
        windowsPathToWslPath(scriptPath),
      ],
    };
  }

  return {
    executablePath: resolution.executablePath,
    args: ["--script", scriptPath],
  };
}

function runM2Script(
  resolution: M2ExecutableResolution,
  script: string,
): { stdout: string; stderr: string; status: number | null } {
  const scriptPath = writeTemporaryM2Script(script);
  try {
    const invocation = getM2ScriptInvocation(resolution, scriptPath);
    const result = spawnSync(invocation.executablePath, invocation.args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });

    if (result.error) {
      throw result.error;
    }

    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      status: result.status,
    };
  } finally {
    removeTemporaryM2Script(scriptPath);
  }
}

// Defines a Mocha test suite to group tests of similar kind together
suite("Extension Tests", function () {
  // Defines a Mocha unit test
  test("Something 1", function () {
    assert.equal(-1, [1, 2, 3].indexOf(5));
    assert.equal(-1, [1, 2, 3].indexOf(0));
  });

  test("sets Macaulay2 indentation defaults", function () {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
    );
    const macaulay2Language = manifest.contributes.languages.find(
      (language: { id: string }) => language.id === "macaulay2",
    );

    assert.deepEqual(macaulay2Language.extensions, [".m2", ".d", ".dd"]);
    assert.deepEqual(
      manifest.contributes.configurationDefaults["[macaulay2]"],
      {
        "editor.detectIndentation": false,
        "editor.insertSpaces": true,
        "editor.tabSize": 8,
        "editor.indentSize": 4,
      },
    );
  });

  test("matches Macaulay2 identifiers and numeric literals as editor words", function () {
    const configurationSource = fs.readFileSync(
      path.join(__dirname, "../../language-configuration.json"),
      "utf8",
    );
    const configuration = JSON.parse(
      configurationSource.replace(/^\s*\/\/.*$/gm, ""),
    );
    const wordPattern = new RegExp(
      configuration.wordPattern.pattern,
      configuration.wordPattern.flags,
    );
    const words = [
      "foo'bar$2",
      "αβ3$",
      "foo_bar",
      "1..5",
      "1.5p53e+2",
      ".5",
      "0x1f",
    ].map((source) =>
      [...source.matchAll(wordPattern)].map((match) => match[0]),
    );

    assert.deepEqual(words, [
      ["foo'bar$2"],
      ["αβ3$"],
      ["foo", "bar"],
      ["1", "5"],
      ["1.5p53e+2"],
      [".5"],
      ["0x1f"],
    ]);
  });
});

suite("Macaulay2 Formatter", function () {
  test("formats indentation and lightweight whitespace conventions", function () {
    const input = [
      "C=apply(F,C,(f,c)->Polygon{apply(f,j->V#j),   ",
      "\tAnimMatrix=>apply(steps,j->rotation(j,c,c)),",
      '\t"fill"=>concatenate("rgb(",toString(1),",",toString(2),")")});--press',
      "",
    ].join("\n");

    assert.equal(
      formatMacaulay2Text(input, { tabSize: 4 }),
      [
        "C = apply(F, C, (f, c) -> Polygon{apply(f, j -> V#j),",
        "        AnimMatrix => apply(steps, j -> rotation(j, c, c)),",
        '        "fill" => concatenate("rgb(", toString(1), ",", toString(2), ")")}); -- press',
        "",
      ].join("\n"),
    );
  });

  test("uses four-column Macaulay2 indentation with eight-column tab stops", function () {
    const input = [
      "normalToricVariety = method (",
      "TypicalValue=>NormalToricVariety,",
      "Options=>{",
      "CoefficientRing=>KK",
      "}",
      ")",
    ].join("\n");

    assert.equal(
      formatMacaulay2Text(input, { tabSize: 8, insertSpaces: false }),
      [
        "normalToricVariety = method (",
        "    TypicalValue => NormalToricVariety,",
        "    Options => {",
        "\tCoefficientRing => KK",
        "    }",
        ")",
        "",
      ].join("\n"),
    );
  });

  test("preserves strings and block comments", function () {
    const input = [
      'x="a,b;c=>d--e"',
      "-*raw,block=>comment*-",
      "y=1--comment",
    ].join("\n");

    assert.equal(
      formatMacaulay2Text(input, { tabSize: 2 }),
      ['x = "a,b;c=>d--e"', "-*raw,block=>comment*-", "y = 1 -- comment"].join(
        "\n",
      ) + "\n",
    );
  });

  test("keeps Macaulay2 operators containing equals intact", function () {
    // Driven by the generated list rather than a hand-typed copy, which had
    // drifted: it carried a bogus U+2298 and was missing the real U+22A0.
    const operators = spacedOperators.filter((operator) =>
      operator.includes("="),
    );
    const input = operators
      .map((operator) => `left${operator}right`)
      .join("\n");
    const expected = operators
      .map((operator) => `left ${operator} right`)
      .concat("")
      .join("\n");

    assert.equal(formatMacaulay2Text(input, { tabSize: 2 }), expected);
  });

  test("keeps formatted Macaulay2 operators without equals intact", function () {
    const input = ["f=(x,y)->x++y", "g(a,b;c)"].join("\n");

    assert.equal(
      formatMacaulay2Text(input, { tabSize: 2 }),
      ["f = (x, y) -> x ++ y", "g(a, b; c)", ""].join("\n"),
    );
  });

  test("does not rewrite documentation blocks", function () {
    const input = ["///", "x=1--not code", "///", "z=1"].join("\n");

    assert.equal(
      formatMacaulay2Text(input, { tabSize: 2 }),
      ["///", "x=1--not code", "///", "z = 1", ""].join("\n"),
    );
  });

  test("dedents leading closing delimiters", function () {
    const input = ["x={", "{1,2},", "{3,4}", "}"].join("\n");

    assert.equal(
      formatMacaulay2Text(input, { tabSize: 2 }),
      ["x = {", "  {1, 2},", "  {3, 4}", "}", ""].join("\n"),
    );
  });

  test("trims trailing empty lines at end of file", function () {
    assert.equal(formatMacaulay2Text("x=1\n\n  \n"), "x = 1\n");
    assert.equal(formatMacaulay2Text("\n\n"), "");
  });
});

suite("Executable Switcher", function () {
  test("keeps the current executable first and removes duplicates", function () {
    assert.deepEqual(
      getM2ExecutablePathOptions("/opt/m2/bin/M2", [
        "/usr/local/bin/M2",
        "/opt/m2/bin/M2",
        "  ",
      ]),
      ["/opt/m2/bin/M2", "/usr/local/bin/M2"],
    );
  });

  test("formats compact labels for bin directories", function () {
    assert.equal(
      formatM2ExecutablePathForStatusBar("/Applications/Macaulay2-1.26/bin/M2"),
      "Macaulay2-1.26/bin/M2",
    );
  });

  test("shows when auto-detection cannot find M2", function () {
    assert.equal(
      getM2ExecutableStatusText(undefined, undefined),
      "$(terminal) M2: not found",
    );
  });

  test("shows WSL auto-detection compactly", function () {
    assert.equal(
      getM2ExecutableStatusText(undefined, {
        executablePath: "C:\\Windows\\System32\\wsl.exe",
        source: "WSL",
        wslExecutablePath: "/usr/bin/M2",
      }),
      "$(terminal) M2 auto: WSL:/usr/bin/M2",
    );
  });

  test("shows WSL manual executable compactly", function () {
    assert.equal(
      getM2ExecutableStatusText("/usr/bin/M2", {
        executablePath: "C:\\Windows\\System32\\wsl.exe",
        source: "setting via WSL",
        wslExecutablePath: "/usr/bin/M2",
      }),
      "$(terminal) M2: WSL:/usr/bin/M2",
    );
  });
});

suite("Executable Launch", function () {
  test("finds Macaulay2 source locations in output", function () {
    const links = getM2OutputFileLocationLinks(
      "The source of this document is in Macaulay2Doc/functions/det-doc.m2:25:0.",
    );

    assert.deepEqual(links, [
      {
        index: "The source of this document is in ".length,
        text: "Macaulay2Doc/functions/det-doc.m2:25:0",
        target: "Macaulay2Doc/functions/det-doc.m2#25:0",
      },
    ]);
  });

  test("finds Macaulay2 source ranges in output", function () {
    const links = getM2OutputFileLocationLinks(
      "/opt/homebrew/share/Macaulay2/Core/files.m2:189:15-189:31: --source code",
    );

    assert.deepEqual(links, [
      {
        index: 0,
        text: "/opt/homebrew/share/Macaulay2/Core/files.m2:189:15-189:31",
        target: "/opt/homebrew/share/Macaulay2/Core/files.m2#189:15-189:31",
      },
    ]);
  });

  test("patches method function code output for WebApp mode", function () {
    const patch = getM2StartupPatch(4);

    assert.notEqual(patch.indexOf("html FilePosition := p ->"), -1);
    assert.notEqual(
      patch.indexOf("code MethodFunctionWithOptions := f ->"),
      -1,
    );
    assert.notEqual(patch.indexOf("if #m > 0 then code m"), -1);
    assert.notEqual(
      patch.indexOf("vscodeM2ExtensionMatrixKatexMaxEntries = 4;"),
      -1,
    );
    assert.notEqual(
      patch.indexOf(
        "html Matrix := m -> if numRows m * numColumns m > vscodeM2ExtensionMatrixKatexMaxEntries then html net m",
      ),
      -1,
    );
  });

  test("startup patch works against the installed Macaulay2 runtime", function () {
    this.timeout(20000);

    const resolution = resolveM2Executable();
    if (!resolution) {
      this.skip();
      return;
    }

    const result = runM2Script(
      resolution,
      getM2StartupPatchCompatibilityScript(),
    );
    const invocationDetail = getM2ExecutableResolutionDetail(resolution);

    assert.equal(
      result.status,
      0,
      `M2 startup patch compatibility check failed for ${invocationDetail}.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
    assert.equal(
      result.stderr.indexOf("warning: VS Code"),
      -1,
      `M2 startup patch emitted a VS Code compatibility warning for ${invocationDetail}.\nSTDERR:\n${result.stderr}`,
    );
    assert.notEqual(
      result.stdout.indexOf(M2_PATCH_COMPATIBILITY_SENTINEL),
      -1,
      `M2 startup patch did not complete its compatibility assertions for ${invocationDetail}.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  });

  test("builds webview process args for WebApp output", function () {
    assert.deepEqual(getM2WebviewProcessArgs("startupPatch"), [
      "--webapp",
      "-e",
      "startupPatch",
    ]);
  });

  test("builds webview process args for Standard top-level output", function () {
    assert.deepEqual(getM2WebviewProcessArgs("startupPatch", "standard"), [
      "--webapp",
      "-e",
      "startupPatch",
      "--print-width",
      "120",
      "-e",
      "topLevelMode = Standard",
    ]);
  });

  test("builds terminal process args with extension startup patch", function () {
    assert.deepEqual(getM2TerminalProcessArgs("startupPatch"), [
      "-e",
      "startupPatch",
    ]);
  });

  test("closes the output webview only for explicit exit input", function () {
    assert.equal(shouldCloseWebviewOnM2Input("exit\n"), true);
    assert.equal(shouldCloseWebviewOnM2Input(" quit; \n"), true);
    assert.equal(shouldCloseWebviewOnM2Input("exit(0)\n"), true);
    assert.equal(shouldCloseWebviewOnM2Input("exit()\n"), true);
    assert.equal(shouldCloseWebviewOnM2Input("quit( -1 )\n"), true);

    assert.equal(shouldCloseWebviewOnM2Input("2+2\n"), false);
    assert.equal(shouldCloseWebviewOnM2Input("2+2\nexit\n"), false);
    assert.equal(shouldCloseWebviewOnM2Input("-- exit\n"), false);
    assert.equal(shouldCloseWebviewOnM2Input("exitStatus\n"), false);
    assert.equal(shouldCloseWebviewOnM2Input("exit(-)\n"), false);
  });

  test("describes unexpected Macaulay2 process exits", function () {
    assert.equal(
      getM2ProcessExitMessage(0, null),
      "\n[Macaulay2 process exited with exit code 0. Submit input to start a new session.]\n",
    );
    assert.equal(
      getM2ProcessExitMessage(null, "SIGTERM"),
      "\n[Macaulay2 process exited with signal SIGTERM. Submit input to start a new session.]\n",
    );
  });

  test("normalizes configured M2 launch arguments", function () {
    assert.deepEqual(normalizeM2LaunchArgs(" --silent   --print-width 120 "), [
      "--silent",
      "--print-width",
      "120",
    ]);
    assert.deepEqual(normalizeM2LaunchArgs(""), []);
    assert.deepEqual(normalizeM2LaunchArgs("--print-width 50"), [
      "--print-width",
      "50",
    ]);
    assert.deepEqual(
      normalizeM2LaunchArgs("--prefix '/tmp/Macaulay2 Prefix'"),
      ["--prefix", "/tmp/Macaulay2 Prefix"],
    );
  });

  test("converts Windows drive paths to WSL mount paths", function () {
    assert.equal(
      windowsPathToWslPath("C:\\Users\\Admin\\m2-project"),
      "/mnt/c/Users/Admin/m2-project",
    );
    assert.equal(
      windowsPathToWslPath("D:/Macaulay2 Work"),
      "/mnt/d/Macaulay2 Work",
    );
  });

  test("converts WSL UNC paths to Linux paths", function () {
    assert.equal(
      windowsPathToWslPath("\\\\wsl$\\Ubuntu\\home\\admin\\m2-project"),
      "/home/admin/m2-project",
    );
    assert.equal(
      windowsPathToWslPath("\\\\wsl.localhost\\Ubuntu\\usr\\share\\Macaulay2"),
      "/usr/share/Macaulay2",
    );
  });

  test("converts WSL paths back to Windows-openable paths", function () {
    assert.equal(
      wslPathToWindowsPath("/mnt/c/Users/Admin/m2-project", "Ubuntu"),
      "C:\\Users\\Admin\\m2-project",
    );
    assert.equal(
      wslPathToWindowsPath("/home/admin/m2-project", "Ubuntu"),
      "\\\\wsl$\\Ubuntu\\home\\admin\\m2-project",
    );
    assert.equal(wslPathToWindowsPath("/home/admin/m2-project"), undefined);
  });

  test("builds a native M2 launch configuration", function () {
    assert.deepEqual(
      getM2LaunchConfiguration(
        { executablePath: "/usr/local/bin/M2", source: "PATH" },
        ["--webapp"],
        "/Users/admin/project",
      ),
      {
        executablePath: "/usr/local/bin/M2",
        args: ["--webapp"],
        cwd: "/Users/admin/project",
      },
    );
  });

  test("adds configured launch arguments after built-in M2 args", function () {
    assert.deepEqual(
      getM2LaunchConfiguration(
        { executablePath: "/usr/local/bin/M2", source: "PATH" },
        ["--webapp"],
        "/Users/admin/project",
        "--print-width 50",
      ),
      {
        executablePath: "/usr/local/bin/M2",
        args: ["--webapp", "--print-width", "50"],
        cwd: "/Users/admin/project",
      },
    );
  });

  test("builds a WSL M2 launch configuration", function () {
    assert.deepEqual(
      getM2LaunchConfiguration(
        {
          executablePath: "C:\\Windows\\System32\\wsl.exe",
          source: "WSL",
          wslExecutablePath: "/usr/bin/M2",
        },
        ["--webapp"],
        "C:\\Users\\Admin\\m2-project",
      ),
      {
        executablePath: "C:\\Windows\\System32\\wsl.exe",
        args: [
          "--cd",
          "/mnt/c/Users/Admin/m2-project",
          "--exec",
          "/usr/bin/M2",
          "--webapp",
        ],
      },
    );
  });

  test("adds configured launch arguments to WSL M2 invocations", function () {
    assert.deepEqual(
      getM2LaunchConfiguration(
        {
          executablePath: "C:\\Windows\\System32\\wsl.exe",
          source: "WSL",
          wslExecutablePath: "/usr/bin/M2",
        },
        ["--webapp"],
        "C:\\Users\\Admin\\m2-project",
        "--silent",
      ),
      {
        executablePath: "C:\\Windows\\System32\\wsl.exe",
        args: [
          "--cd",
          "/mnt/c/Users/Admin/m2-project",
          "--exec",
          "/usr/bin/M2",
          "--webapp",
          "--silent",
        ],
      },
    );
  });
});

suite("Send Paragraph to REPL", function () {
  function lines(...ls: string[]) {
    return (n: number) => ls[n];
  }

  test("expands from a non-blank line to full paragraph boundaries", function () {
    // cursor on line 1 (middle of paragraph)
    assert.deepEqual(
      getParagraphLineRange(1, 4, lines("x = 1", "y = 2", "", "z = 3")),
      { startLine: 0, endLine: 1 },
    );
  });

  test("expands to the entire paragraph when there are no surrounding blank lines", function () {
    assert.deepEqual(
      getParagraphLineRange(1, 3, lines("x = 1", "y = 2", "z = 3")),
      { startLine: 0, endLine: 2 },
    );
  });

  test("handles a single non-blank line", function () {
    assert.deepEqual(
      getParagraphLineRange(0, 1, lines("x = 1")),
      { startLine: 0, endLine: 0 },
    );
  });

  test("on a blank line with a paragraph below, sends that next paragraph", function () {
    // cursor on line 2 (blank), paragraph is lines 3-4
    assert.deepEqual(
      getParagraphLineRange(
        2,
        5,
        lines("x = 1", "y = 2", "", "z = 3", "w = 4"),
      ),
      { startLine: 3, endLine: 4 },
    );
  });

  test("skips multiple blank lines to reach the next paragraph", function () {
    // cursor on line 1, three blank lines before paragraph at 4-5
    assert.deepEqual(
      getParagraphLineRange(
        1,
        6,
        lines("x = 1", "", "", "", "y = 2", "z = 3"),
      ),
      { startLine: 4, endLine: 5 },
    );
  });

  test("on a blank line at the top of the file, sends the paragraph below", function () {
    assert.deepEqual(
      getParagraphLineRange(0, 3, lines("", "x = 1", "y = 2")),
      { startLine: 1, endLine: 2 },
    );
  });

  test("on a blank line with only whitespace below, falls back to the previous paragraph", function () {
    // cursor on line 2 (blank), line 3 also blank — previous paragraph is 0-1
    assert.deepEqual(
      getParagraphLineRange(2, 4, lines("x = 1", "y = 2", "", "")),
      { startLine: 0, endLine: 1 },
    );
  });

  test("on the last line when blank, falls back to the previous paragraph", function () {
    assert.deepEqual(
      getParagraphLineRange(2, 3, lines("x = 1", "y = 2", "")),
      { startLine: 0, endLine: 1 },
    );
  });

  test("returns undefined for an entirely blank buffer", function () {
    assert.equal(
      getParagraphLineRange(0, 3, lines("", "", "")),
      undefined,
    );
  });

  test("cursor at start of file on non-blank line", function () {
    assert.deepEqual(
      getParagraphLineRange(0, 4, lines("x = 1", "y = 2", "", "z = 3")),
      { startLine: 0, endLine: 1 },
    );
  });

  test("cursor at last non-blank line", function () {
    assert.deepEqual(
      getParagraphLineRange(2, 3, lines("x = 1", "", "z = 3")),
      { startLine: 2, endLine: 2 },
    );
  });
});
