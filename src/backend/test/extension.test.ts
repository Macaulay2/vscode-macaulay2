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
  CachedCommandResolver,
  CommandExecutableResolution,
  CommandProbe,
  createCachedCommandResolver,
  probeConfiguredCommand,
  getM2ExecutableResolutionDetail,
  getM2LaunchConfiguration,
  M2ExecutableResolution,
  normalizeM2LaunchArgs,
  probeCommandWithWsl,
  probeWindowsCommandExecutable,
  resolveM2Executable,
  runShellCommand,
  windowsPathToWslPath,
  wslPathToWindowsPath,
} from "../executablePath";
import {
  getM2OutputFileLocationLinks,
  getM2ProcessExitMessage,
  getM2StartupPatch,
  getM2TerminalProcessArgs,
  getM2WebviewProcessArgs,
  shouldCloseWebviewOnM2Input,
} from "../repl";
import { formatMacaulay2Text } from "../formatter";
import { spacedOperators } from "../operators";
import {
  createLanguageServerController,
  LanguageServerControllerOptions,
} from "../languageServer";

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
    assert.equal(
      manifest.contributes.configuration.properties[
        "macaulay2.languageServerPath"
      ].scope,
      "machine-overridable",
    );
  });

  test("every contributed command is prefixed in the palette", function () {
    // The README documents them all as "Macaulay2: ...", which is what the
    // category produces.  Without it a command shows up bare, next to the
    // prefixed ones.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
    );
    const uncategorized = manifest.contributes.commands
      .filter((command: { category?: string }) => !command.category)
      .map((command: { command: string }) => command.command);

    assert.deepEqual(uncategorized, []);
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

suite("Command Executable Resolution", function () {
  const autoDetected: CommandProbe = {
    resolution: {
      executablePath: "/usr/bin/M2-language-server",
      source: "PATH",
    },
    timedOut: false,
  };

  test("a configured path wins over auto-detection", function () {
    let probed = false;
    const probe = probeConfiguredCommand(
      "/opt/M2-language-server",
      "M2-language-server",
      () => {
        probed = true;
        return autoDetected;
      },
      "linux",
    );

    assert.deepEqual(probe, {
      resolution: {
        executablePath: "/opt/M2-language-server",
        source: "setting",
      },
      timedOut: false,
    });
    // Not just overridden afterwards: the probe must not run at all, since it
    // is the expensive part.
    assert.equal(probed, false);
  });

  test("an empty or whitespace setting falls back to auto-detection", function () {
    for (const configured of [undefined, "", "   "]) {
      assert.deepEqual(
        probeConfiguredCommand(
          configured,
          "M2-language-server",
          () => autoDetected,
        ),
        autoDetected,
      );
    }
  });

  test("a configured path is trimmed but not otherwise checked", function () {
    // Taken as given, like macaulay2.executablePath, so a wrong path fails at
    // startup naming itself rather than silently auto-detecting something else.
    assert.deepEqual(
      probeConfiguredCommand(
        "  /nonexistent/M2-language-server  ",
        "M2-language-server",
        () => {
          throw new Error("should not auto-detect");
        },
        "linux",
      ),
      {
        resolution: {
          executablePath: "/nonexistent/M2-language-server",
          source: "setting",
        },
        timedOut: false,
      },
    );
  });

  test("launches a configured Unix path through WSL on Windows", function () {
    let probed = false;
    const probe = probeConfiguredCommand(
      "/opt/Macaulay2/bin/M2-language-server",
      "M2-language-server",
      () => {
        probed = true;
        return autoDetected;
      },
      "win32",
      () => "C:\\Windows\\System32\\wsl.exe",
    );

    assert.deepEqual(probe, {
      resolution: {
        executablePath: "C:\\Windows\\System32\\wsl.exe",
        source: "setting via WSL",
        args: ["--exec", "/opt/Macaulay2/bin/M2-language-server"],
      },
      timedOut: false,
    });
    assert.equal(probed, false);
  });

  test("launches a configured native Windows path directly", function () {
    const configured = "C:\\Program Files\\Macaulay2\\M2-language-server.exe";

    assert.deepEqual(
      probeConfiguredCommand(
        configured,
        "M2-language-server",
        () => {
          throw new Error("should not auto-detect");
        },
        "win32",
        () => {
          throw new Error("should not look for WSL");
        },
      ),
      {
        resolution: {
          executablePath: configured,
          source: "setting",
        },
        timedOut: false,
      },
    );
  });

  test("preserves a WSL shell timeout", function () {
    const result = probeCommandWithWsl(
      "M2-language-server",
      () => "C:\\Windows\\System32\\wsl.exe",
      () => ({ timedOut: true }),
    );

    assert.deepEqual(result, { timedOut: true });
  });

  test("propagates a WSL timeout after a conclusive Cygwin miss", function () {
    const result = probeWindowsCommandExecutable(
      "M2-language-server",
      () => ({ timedOut: false }),
      () => ({ timedOut: true }),
    );

    assert.deepEqual(result, { timedOut: true });
  });

  test("uses a hard kill signal for synchronous shell probes", function () {
    let receivedTimeout: number | undefined;
    let receivedKillSignal: string | undefined;
    const timeoutError = Object.assign(new Error("timed out"), {
      signal: "SIGKILL",
    });

    const result = runShellCommand(
      "/path/to/shell",
      ["-lc", "command -v M2-language-server"],
      123,
      (_executablePath, _args, options) => {
        receivedTimeout = options.timeout;
        receivedKillSignal = options.killSignal;
        throw timeoutError;
      },
    );

    assert.equal(receivedTimeout, 123);
    assert.equal(receivedKillSignal, "SIGKILL");
    assert.deepEqual(result, { timedOut: true });
  });
});

suite("Language Server Controller", function () {
  // One entry per client the controller builds, so a test can tell "restarted
  // the same client" from "built a second one".
  interface FakeClient {
    start(): Thenable<void>;
    stop(): Thenable<void>;
    dispose(): void;
    executablePath: string;
    calls: string[];
  }

  function createHarness(
    probes: CommandProbe[],
    overrides: Partial<LanguageServerControllerOptions> = {},
  ) {
    const clients: FakeClient[] = [];
    let failCreate: unknown;
    let failStart: unknown;
    let failStop: unknown;
    let stopHook: (() => Thenable<void> | void) | undefined;

    const createClient = async (resolution: CommandExecutableResolution) => {
      if (failCreate !== undefined) throw failCreate;

      const client: FakeClient = {
        executablePath: resolution.executablePath,
        calls: [],
        async start() {
          client.calls.push("start");
          if (failStart !== undefined) throw failStart;
        },
        async stop() {
          client.calls.push("stop");
          if (stopHook) await stopHook();
          if (failStop !== undefined) throw failStop;
        },
        dispose() {
          client.calls.push("dispose");
        },
      };
      clients.push(client);
      return client;
    };

    let probeCount = 0;
    // Runs out of scripted answers rather than repeating the last one, so a
    // controller that probes more often than expected fails loudly.
    const resolver: CachedCommandResolver = createCachedCommandResolver(
      "M2-language-server",
      () => {
        const probe = probes[probeCount];
        probeCount += 1;
        assert.ok(probe, `unexpected probe #${probeCount}`);
        return probe;
      },
    );

    const reported: string[] = [];
    const controller = createLanguageServerController({
      createClient,
      resolver,
      isEnabled: () => true,
      reportDisabled: () => reported.push("disabled"),
      reportNotFound: () => reported.push("notFound"),
      reportStartError: () => reported.push("startError"),
      reportStopError: () => reported.push("stopError"),
      ...overrides,
    });

    return {
      clients,
      controller,
      reported,
      failCreateWith(error: unknown) {
        failCreate = error;
      },
      failStartWith(error: unknown) {
        failStart = error;
      },
      failStopWith(error: unknown) {
        failStop = error;
      },
      runDuringStop(hook: (() => Thenable<void> | void) | undefined) {
        stopHook = hook;
      },
      get probeCount() {
        return probeCount;
      },
      // Flattened call log across every client built, which is what most of
      // these tests actually care about.
      get calls() {
        return clients.flatMap((client) => client.calls);
      },
    };
  }

  const found: CommandProbe = {
    resolution: {
      executablePath: "/usr/bin/M2-language-server",
      source: "PATH",
    },
    timedOut: false,
  };
  const moved: CommandProbe = {
    resolution: {
      executablePath: "/opt/bin/M2-language-server",
      source: "PATH",
    },
    timedOut: false,
  };
  const notFound: CommandProbe = { timedOut: false };
  const timedOut: CommandProbe = { timedOut: true };

  test("probes once when the language server is not installed", async function () {
    // The bug this guards: start() is called from onDidChangeActiveTextEditor,
    // so a missing language server used to mean a blocking probe per tab
    // switch.
    const harness = createHarness([notFound]);

    await harness.controller.start();
    await harness.controller.start();
    await harness.controller.start();

    assert.equal(harness.probeCount, 1);
    assert.deepEqual(harness.clients, []);
    // Silent: nobody asked for a language server by opening a file.
    assert.deepEqual(harness.reported, []);
  });

  test("builds no client when the language server is not installed", async function () {
    // vscode-languageclient is imported by createClient, so never calling it
    // is what keeps it out of activation for most users.
    const harness = createHarness([notFound]);

    await harness.controller.start();

    assert.deepEqual(harness.clients, []);
  });

  test("builds no client while disabled", async function () {
    const harness = createHarness([], { isEnabled: () => false });

    await harness.controller.start();

    assert.equal(harness.probeCount, 0);
    assert.deepEqual(harness.clients, []);
  });

  test("probes once and builds one client when the server starts", async function () {
    const harness = createHarness([found]);

    await harness.controller.start();
    await harness.controller.start();

    assert.equal(harness.probeCount, 1);
    assert.equal(harness.clients.length, 1);
    assert.deepEqual(harness.calls, ["start"]);
  });

  test("coalesces concurrent starts into one", async function () {
    const harness = createHarness([found]);

    await Promise.all([
      harness.controller.start(),
      harness.controller.start(),
      harness.controller.start(),
    ]);

    assert.equal(harness.probeCount, 1);
    assert.equal(harness.clients.length, 1);
    assert.deepEqual(harness.calls, ["start"]);
  });

  test("does not repeat a timed-out probe from editor starts", async function () {
    // Editor events are not a safe retry path for synchronous discovery: a
    // persistently slow shell would otherwise stall every tab switch.
    const harness = createHarness([timedOut, found]);

    await harness.controller.start();
    assert.deepEqual(harness.clients, []);
    await harness.controller.start();
    await harness.controller.start();

    assert.equal(harness.probeCount, 1);
    assert.deepEqual(harness.clients, []);
    assert.deepEqual(harness.reported, []);

    // The explicit command forgets the cached timeout and tries again.
    await harness.controller.restart();

    assert.equal(harness.probeCount, 2);
    assert.deepEqual(harness.calls, ["start"]);
    assert.deepEqual(harness.reported, []);
  });

  test("restart re-probes and starts a server installed since activation", async function () {
    const harness = createHarness([notFound, found]);

    await harness.controller.start();
    assert.deepEqual(harness.clients, []);

    await harness.controller.restart();

    assert.equal(harness.probeCount, 2);
    assert.deepEqual(harness.calls, ["start"]);
    assert.deepEqual(harness.reported, []);
  });

  test("restart builds a new client rather than reusing the old one", async function () {
    // The executable path is baked into a client at construction, so a restart
    // that finds the server somewhere else has to build a fresh one.
    const harness = createHarness([found, moved]);

    await harness.controller.start();
    await harness.controller.restart();

    assert.deepEqual(
      harness.clients.map((client) => client.executablePath),
      ["/usr/bin/M2-language-server", "/opt/bin/M2-language-server"],
    );
    assert.deepEqual(harness.clients[0].calls, ["start", "stop", "dispose"]);
    assert.deepEqual(harness.clients[1].calls, ["start"]);
  });

  test("restart says so when there is nothing to restart", async function () {
    // The counterpart to start() staying silent: a restart is an explicit
    // request, so it gets an answer every time rather than failing quietly.
    const harness = createHarness([notFound, notFound]);

    await harness.controller.restart();
    assert.deepEqual(harness.reported, ["notFound"]);

    await harness.controller.restart();
    assert.deepEqual(harness.reported, ["notFound", "notFound"]);
    assert.deepEqual(harness.clients, []);
  });

  test("restart preserves a running client when resolution times out", async function () {
    const harness = createHarness([found, timedOut, moved]);

    await harness.controller.start();
    await harness.controller.restart();

    assert.equal(harness.probeCount, 2);
    assert.equal(harness.clients.length, 1);
    assert.deepEqual(harness.clients[0].calls, ["start"]);
    assert.deepEqual(harness.reported, []);

    // A later explicit restart retries and replaces the still-running client.
    await harness.controller.restart();

    assert.equal(harness.probeCount, 3);
    assert.deepEqual(
      harness.clients.map((client) => client.executablePath),
      ["/usr/bin/M2-language-server", "/opt/bin/M2-language-server"],
    );
    assert.deepEqual(harness.clients[0].calls, ["start", "stop", "dispose"]);
    assert.deepEqual(harness.clients[1].calls, ["start"]);
    assert.deepEqual(harness.reported, []);
  });

  test("restart reports when the language server is disabled", async function () {
    const harness = createHarness([], { isEnabled: () => false });

    await harness.controller.restart();

    assert.equal(harness.probeCount, 0);
    assert.deepEqual(harness.reported, ["disabled"]);
  });

  test("restart stops a running server whose executable has gone", async function () {
    // Otherwise the user is told it was not found while it is still running,
    // and start() short-circuits on the stale started flag forever after.
    const harness = createHarness([found, notFound, found]);

    await harness.controller.start();
    await harness.controller.restart();

    assert.deepEqual(harness.clients[0].calls, ["start", "stop", "dispose"]);
    assert.deepEqual(harness.reported, ["notFound"]);

    await harness.controller.restart();
    assert.equal(harness.clients.length, 2);
    assert.deepEqual(harness.clients[1].calls, ["start"]);
  });

  test("a start racing a restart does not start a second client", async function () {
    const harness = createHarness([found, found]);

    await harness.controller.start();

    const restarting = harness.controller.restart();
    const racing = harness.controller.start();
    await Promise.all([restarting, racing]);

    assert.equal(harness.clients.length, 2);
    assert.deepEqual(harness.clients[1].calls, ["start"]);
    assert.deepEqual(harness.reported, []);
  });

  test("reports a failed start once and allows a later retry", async function () {
    const harness = createHarness([found]);
    harness.failStartWith(new Error("boom"));

    await harness.controller.start();
    assert.deepEqual(harness.reported, ["startError"]);
    assert.deepEqual(harness.clients[0].calls, ["start", "dispose"]);

    harness.failStartWith(undefined);
    await harness.controller.start();

    assert.deepEqual(harness.reported, ["startError"]);
    assert.equal(harness.probeCount, 1);
    assert.deepEqual(harness.clients[1].calls, ["start"]);
  });

  test("preserves a running client when replacement construction fails", async function () {
    const harness = createHarness([found, moved, moved]);

    await harness.controller.start();
    harness.failCreateWith(new Error("cannot load client"));
    await harness.controller.restart();

    assert.equal(harness.probeCount, 2);
    assert.equal(harness.clients.length, 1);
    assert.deepEqual(harness.clients[0].calls, ["start"]);
    assert.deepEqual(harness.reported, ["startError"]);

    harness.failCreateWith(undefined);
    await harness.controller.restart();

    assert.equal(harness.probeCount, 3);
    assert.deepEqual(harness.clients[0].calls, ["start", "stop", "dispose"]);
    assert.deepEqual(harness.clients[1].calls, ["start"]);
  });

  test("disposes an unused replacement when old shutdown rejects", async function () {
    const harness = createHarness([found, moved]);

    await harness.controller.start();
    harness.failStopWith(new Error("shutdown failed"));
    await harness.controller.restart();

    assert.deepEqual(harness.clients[0].calls, ["start", "stop", "dispose"]);
    assert.deepEqual(harness.clients[1].calls, ["dispose"]);
    assert.deepEqual(harness.reported, ["stopError"]);
  });

  test("stop shuts the running client down", async function () {
    const harness = createHarness([found]);

    await harness.controller.start();
    await harness.controller.stop();

    assert.deepEqual(harness.clients[0].calls, ["start", "stop", "dispose"]);
  });

  test("stop then start builds a fresh client", async function () {
    // Turning the setting off and back on goes through stop() and start()
    // rather than a window reload, so the second start has to work.
    const harness = createHarness([found, found]);

    await harness.controller.start();
    await harness.controller.stop();
    await harness.controller.start();

    assert.equal(harness.clients.length, 2);
    assert.deepEqual(harness.clients[0].calls, ["start", "stop", "dispose"]);
    assert.deepEqual(harness.clients[1].calls, ["start"]);
  });

  test("a start requested during shutdown runs after it", async function () {
    const harness = createHarness([found]);
    let markStopEntered: () => void;
    let releaseStop: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      markStopEntered = resolve;
    });
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    harness.runDuringStop(() => {
      markStopEntered();
      return stopGate;
    });

    await harness.controller.start();
    const stopping = harness.controller.stop();
    await stopEntered;
    const starting = harness.controller.start();
    releaseStop();
    await Promise.all([stopping, starting]);

    assert.equal(harness.probeCount, 1);
    assert.equal(harness.clients.length, 2);
    assert.deepEqual(harness.clients[0].calls, ["start", "stop", "dispose"]);
    assert.deepEqual(harness.clients[1].calls, ["start"]);
  });

  test("configuration changes while disabled invalidate without probing", async function () {
    let enabled = true;
    const harness = createHarness([found, moved], {
      isEnabled: () => enabled,
    });

    await harness.controller.start();
    enabled = false;
    // Represents one settings save that changes the path and disables the
    // server. It must stop the old client without probing the new path.
    await harness.controller.configurationChanged();
    assert.equal(harness.probeCount, 1);
    assert.deepEqual(harness.clients[0].calls, ["start", "stop", "dispose"]);

    // A later path edit while still disabled must invalidate the cached path,
    // but it still must not launch discovery.
    await harness.controller.configurationChanged();
    assert.equal(harness.probeCount, 1);

    enabled = true;
    await harness.controller.configurationChanged();

    assert.equal(harness.probeCount, 2);
    assert.deepEqual(
      harness.clients.map((client) => client.executablePath),
      ["/usr/bin/M2-language-server", "/opt/bin/M2-language-server"],
    );
    assert.deepEqual(harness.clients[1].calls, ["start"]);
    assert.deepEqual(harness.reported, []);
  });

  test("enabling after installation retries a cached miss", async function () {
    let enabled = true;
    const harness = createHarness([notFound, moved], {
      isEnabled: () => enabled,
    });

    await harness.controller.start();
    assert.equal(harness.probeCount, 1);

    enabled = false;
    await harness.controller.configurationChanged();
    assert.equal(harness.probeCount, 1);

    enabled = true;
    await harness.controller.configurationChanged();

    assert.equal(harness.probeCount, 2);
    assert.equal(harness.clients.length, 1);
    assert.equal(
      harness.clients[0].executablePath,
      "/opt/bin/M2-language-server",
    );
    assert.deepEqual(harness.clients[0].calls, ["start"]);
    assert.deepEqual(harness.reported, []);
  });

  test("stop queues behind an in-flight start", async function () {
    const harness = createHarness([found]);

    const starting = harness.controller.start();
    const stopping = harness.controller.stop();
    await Promise.all([starting, stopping]);

    assert.equal(harness.clients.length, 1);
    assert.deepEqual(harness.clients[0].calls, ["start", "stop", "dispose"]);
  });

  test("stop still disposes and reports when shutdown rejects", async function () {
    const harness = createHarness([found]);

    await harness.controller.start();
    harness.failStopWith(new Error("shutdown failed"));
    await harness.controller.stop();

    assert.deepEqual(harness.clients[0].calls, ["start", "stop", "dispose"]);
    assert.deepEqual(harness.reported, ["stopError"]);
  });

  test("stop is harmless when nothing ever started", async function () {
    const harness = createHarness([notFound]);

    await harness.controller.start();
    await harness.controller.stop();

    assert.deepEqual(harness.clients, []);
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
