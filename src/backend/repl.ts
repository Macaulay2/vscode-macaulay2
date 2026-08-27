import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

import { spawn, ChildProcess, execFileSync } from "child_process";
import {
  getM2ExecutableResolutionDetail,
  getM2LaunchConfiguration,
  M2LaunchArgsConfiguration,
  M2ExecutableResolution,
  resolveM2Executable,
  windowsPathToWslPath,
  wslPathToWindowsPath,
} from "./executablePath";
import { registerM2ExecutableSwitcher } from "./executableSwitcher";

let g_context: vscode.ExtensionContext | undefined;
let g_panel: vscode.WebviewPanel | undefined;
let g_terminal: vscode.Terminal | undefined;
let g_getWebviewCompletionItems:
  | (() => Promise<WebviewCompletionItem[]>)
  | undefined;
let proc: ChildProcess | undefined;
let startReplPromise: Promise<void> | undefined;
let procWorkingDir: string | undefined;
let procFileSystem: M2ProcessFileSystem = { kind: "local" };
let procSourceSearchRoots: string[] = [];
let terminalWorkingDir: string | undefined;
let terminalFileSystem: M2ProcessFileSystem = { kind: "local" };
let terminalSourceSearchRoots: string[] = [];
const keepWebviewOpenOnProcessClose = new WeakSet<ChildProcess>();
const closeWebviewOnProcessClose = new WeakSet<ChildProcess>();
let shouldRestoreEditorFocusAfterWebviewOutput = false;
let editorToRestoreAfterWebviewOutput: vscode.TextEditor | undefined;
let g_flashDecoration: vscode.TextEditorDecorationType | undefined;

type WebviewCompletionItem = {
  label: string;
  kind: string;
};
type WebviewColorTheme = "classic" | "light" | "dark" | "vscode";
type WebviewTopLevelMode = "webapp" | "standard";
type WebviewSyntaxClass =
  | "keyword"
  | "operator"
  | "function"
  | "class-name"
  | "constant";
type WebviewSyntaxToken = {
  label: string;
  className: WebviewSyntaxClass;
  priority: number;
};
type WebviewSyntaxPattern = {
  source: string;
  className: WebviewSyntaxClass;
};
type WebviewSyntax = {
  tokens: WebviewSyntaxToken[];
  patterns: WebviewSyntaxPattern[];
};
type M2ProcessFileSystem =
  | { kind: "local" }
  | { kind: "wsl"; distroName?: string; hostExecutablePath: string };

type M2PathResolutionContext = {
  workingDir?: string;
  fileSystem: M2ProcessFileSystem;
  sourceSearchRoots: string[];
};

const defaultWebviewMatrixKatexMaxEntries = 2500;

export type M2OutputFileLocationLink = {
  index: number;
  text: string;
  target: string;
};

type HelpPanelState = {
  panel: vscode.WebviewPanel;
  currentFilePath: string;
  currentM2FilePath?: string;
};

type ResolvedHelpTarget = {
  filePath?: string;
  m2FilePath?: string;
  externalUri?: vscode.Uri;
  fragment?: string;
};

const helpPanels = new Set<HelpPanelState>();

// In WebApp mode, some help pages fail while processing example output.
// Keep native help where it works, and fall back to the top documentation node.
// Also expand ordinary method functions through their installed methods when
// `code f` has no direct source body to show. WebApp also calls realpath while
// converting source-location links, but macOS realpath rejects paths containing
// #L anchors; render FilePosition links directly so code output keeps its
// styled Hypertext form. WebApp also overrides some texMath methods through
// html, which can recurse back into texMath; restore direct LaTeX paths for
// affected core types.
function normalizeWebviewMatrixKatexMaxEntries(value: number): number {
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : defaultWebviewMatrixKatexMaxEntries;
}

export function getM2StartupPatch(
  matrixKatexMaxEntries = defaultWebviewMatrixKatexMaxEntries,
): string {
  const normalizedMatrixKatexMaxEntries = normalizeWebviewMatrixKatexMaxEntries(
    matrixKatexMaxEntries,
  );

  return [
    "try (",
    "local toURLFun, urlEncodeFun, htmlLiteralFun;",
    'toURLFun = value ((Core#"private dictionary")#"toURL");',
    'urlEncodeFun = value ((Core#"private dictionary")#"urlEncode");',
    'htmlLiteralFun = value ((Core#"private dictionary")#"htmlLiteral");',
    'html FilePosition := p -> concatenate("<samp><a href=\\"", htmlLiteralFun (urlEncodeFun (toURLFun p)), "\\">", htmlLiteralFun (toString p), "</a></samp>");',
    ') else printerr "warning: VS Code FilePosition HTML fallback could not be installed";',
    "try (",
    "vscodeM2ExtensionOriginalCodeFunction = lookup(code, Function);",
    "code MethodFunction := f -> (",
    "m := methods f;",
    "if #m > 0 then code m else vscodeM2ExtensionOriginalCodeFunction f);",
    ') else printerr "warning: VS Code code fallback could not be installed";',
    "try (",
    "vscodeM2ExtensionOriginalCodeMethodFunctionWithOptions = lookup(code, MethodFunctionWithOptions);",
    "code MethodFunctionWithOptions := f -> (",
    "m := methods f;",
    "if #m > 0 then code m else vscodeM2ExtensionOriginalCodeMethodFunctionWithOptions f);",
    ') else printerr "warning: VS Code code MethodFunctionWithOptions fallback could not be installed";',
    "try (",
    "vscodeM2ExtensionOriginalCaptureString = lookup(capture, String);",
    "capture String := opts -> s -> (",
    "oldTopLevelMode := topLevelMode;",
    "topLevelMode = Standard;",
    "result := try (vscodeM2ExtensionOriginalCaptureString opts) s except err do (topLevelMode = oldTopLevelMode; error err);",
    "topLevelMode = oldTopLevelMode;",
    "result);",
    ') else printerr "warning: VS Code capture fallback could not be installed";',
    "try (",
    `vscodeM2ExtensionMatrixKatexMaxEntries = ${normalizedMatrixKatexMaxEntries};`,
    "vscodeM2ExtensionOriginalHtmlMatrix = lookup(html, Matrix);",
    "html Matrix := m -> if numRows m * numColumns m > vscodeM2ExtensionMatrixKatexMaxEntries then html net m else vscodeM2ExtensionOriginalHtmlMatrix m;",
    "vscodeM2ExtensionOriginalHtmlMutableMatrix = lookup(html, MutableMatrix);",
    "html MutableMatrix := m -> if numRows m * numColumns m > vscodeM2ExtensionMatrixKatexMaxEntries then html net m else vscodeM2ExtensionOriginalHtmlMutableMatrix m;",
    ') else printerr "warning: VS Code large matrix HTML fallback could not be installed";',
    'try (local lit; lit = value (Core#"private dictionary")#"texMathLiteral"; texMath Type := x -> "\\\\texttt{" | lit toString x | "}") else printerr "warning: VS Code texMath Type fallback could not be installed";',
    'try (local lit; lit = value (Core#"private dictionary")#"texMathLiteral"; texMath Ring := x -> if x.?texMath then x.texMath else "\\\\texttt{" | lit toString x | "}") else printerr "warning: VS Code texMath Ring fallback could not be installed";',
    "try (",
    "local tag, rawdoc, rawtag, pkg, fkey, rawTable, had, old, result, k, fetchAny, oldDocumentTag;",
    "vscodeM2ExtensionOriginalDocHelp = lookup(help#0, DocumentTag);",
    "vscodeM2ExtensionTopHelp = tag -> (",
    'fetchAny = value (Core#"private dictionary")#"fetchAnyRawDocumentation";',
    "rawdoc = fetchAny tag;",
    "if rawdoc === null then return vscodeM2ExtensionOriginalDocHelp tag;",
    "rawtag = rawdoc.DocumentTag;",
    "pkg = package rawtag;",
    "fkey = format rawtag;",
    'rawTable = pkg#"raw documentation";',
    "had = rawTable#?fkey;",
    "if had then old = rawTable#fkey;",
    "rawTable#fkey = selectKeys(rawdoc, k -> k =!= Description);",
    'oldDocumentTag = value ((Core#"private dictionary")#"currentDocumentTag");',
    '((Core#"private dictionary")#"currentDocumentTag") <- rawtag;',
    "result = try vscodeM2ExtensionOriginalDocHelp rawtag else (",
    '((Core#"private dictionary")#"currentDocumentTag") <- oldDocumentTag;',
    "if had then rawTable#fkey = old else remove(rawTable, fkey);",
    'error "VS Code help fallback failed while rendering the top documentation node");',
    '((Core#"private dictionary")#"currentDocumentTag") <- oldDocumentTag;',
    "if had then rawTable#fkey = old else remove(rawTable, fkey);",
    "result);",
    "help#0 DocumentTag := tag -> try vscodeM2ExtensionOriginalDocHelp tag else vscodeM2ExtensionTopHelp tag;",
    ') else printerr "warning: VS Code help fallback could not be installed"',
  ].join(" ");
}

function getM2StartupExpression(): string {
  return getM2StartupPatch(getWebviewMatrixKatexMaxEntries());
}

export function getM2WebviewProcessArgs(
  startupExpression: string,
  topLevelMode: WebviewTopLevelMode = "webapp",
): string[] {
  const args = ["--webapp", "-e", startupExpression];
  if (topLevelMode === "standard")
    args.push("--print-width", "120", "-e", "topLevelMode = Standard");
  return args;
}

export function getM2TerminalProcessArgs(startupExpression: string): string[] {
  return ["-e", startupExpression];
}

function getM2LaunchArgs(): M2LaunchArgsConfiguration {
  return vscode.workspace
    .getConfiguration("macaulay2")
    .get<string>("launchArgs", "");
}

function getWebviewColorTheme(): WebviewColorTheme {
  const configuredTheme = vscode.workspace
    .getConfiguration("macaulay2")
    .get<string>("webviewColorTheme", "vscode");
  return configuredTheme === "light" ||
    configuredTheme === "dark" ||
    configuredTheme === "classic"
    ? configuredTheme
    : "vscode";
}

function getWebviewTopLevelMode(): WebviewTopLevelMode {
  const configuredMode = vscode.workspace
    .getConfiguration("macaulay2")
    .get<string>("webviewTopLevelMode", "webapp");
  return configuredMode === "standard" ? "standard" : "webapp";
}

function getWebviewMatrixKatexMaxEntries(): number {
  const configuredLength = vscode.workspace
    .getConfiguration("macaulay2")
    .get<number>(
      "webviewMatrixKatexMaxEntries",
      defaultWebviewMatrixKatexMaxEntries,
    );

  return normalizeWebviewMatrixKatexMaxEntries(configuredLength);
}

function postWebviewSettings() {
  if (!g_panel) return;

  g_panel.webview.postMessage({
    type: "settings",
    colorTheme: getWebviewColorTheme(),
  });
}

function getM2ExecutableResolution() {
  const configuredPath = vscode.workspace
    .getConfiguration("macaulay2")
    .get<string>("executablePath");
  const resolution = resolveM2Executable(configuredPath);
  if (!resolution) {
    const action = "Open Settings";
    vscode.window
      .showErrorMessage(
        "Could not locate the Macaulay2 executable automatically. Install Macaulay2 so the M2 command is available natively or in WSL, or set 'macaulay2.executablePath' manually.",
        action,
      )
      .then((selectedAction) => {
        if (selectedAction === action) {
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "macaulay2.executablePath",
          );
        }
      });
    return undefined;
  }

  console.log(
    `Using M2 executable from ${resolution.source}: ${getM2ExecutableResolutionDetail(
      resolution,
    )}`,
  );
  return resolution;
}

function getM2WorkingDir(): string {
  let workingDir: string;
  const activeEditor = vscode.window.activeTextEditor;

  if (activeEditor && activeEditor.document.uri.scheme === "file") {
    // Use the directory of the currently active file
    workingDir = path.dirname(activeEditor.document.uri.fsPath);
    console.log(`Starting M2 in current file directory: ${workingDir}`);
  } else if (
    vscode.workspace.workspaceFolders &&
    vscode.workspace.workspaceFolders.length > 0
  ) {
    // Use the first workspace folder
    workingDir = vscode.workspace.workspaceFolders[0].uri.fsPath;
    console.log(`Starting M2 in workspace root: ${workingDir}`);
  } else {
    // Fallback to process.cwd()
    workingDir = process.cwd();
    console.log(`Starting M2 in process working directory: ${workingDir}`);
  }

  return workingDir;
}

function getM2ProcessWorkingDir(
  resolution: M2ExecutableResolution,
  workingDir: string,
): string {
  return resolution.wslExecutablePath
    ? windowsPathToWslPath(workingDir) || "~"
    : workingDir;
}

function getM2ProcessFileSystem(
  resolution: M2ExecutableResolution,
): M2ProcessFileSystem {
  return resolution.wslExecutablePath
    ? {
        kind: "wsl",
        distroName: resolution.wslDistroName,
        hostExecutablePath: resolution.executablePath,
      }
    : { kind: "local" };
}

function addMacaulay2SourceRootsFromExecutable(
  roots: Set<string>,
  executablePath: string,
  fileSystem: M2ProcessFileSystem,
) {
  const pathModule = fileSystem.kind === "wsl" ? path.posix : path;
  const executableDir = pathModule.dirname(executablePath);
  const prefixDir = pathModule.dirname(executableDir);

  roots.add(pathModule.join(prefixDir, "share", "Macaulay2"));
  roots.add(pathModule.join(prefixDir, "usr", "share", "Macaulay2"));
}

function realpathIfAvailable(filePath: string): string | undefined {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    try {
      return fs.realpathSync(filePath);
    } catch {
      return undefined;
    }
  }
}

function getMacaulay2SourceSearchRoots(
  resolution: M2ExecutableResolution,
  workingDir: string,
  fileSystem: M2ProcessFileSystem,
): string[] {
  const roots = new Set<string>();

  if (fileSystem.kind === "wsl" && resolution.wslExecutablePath) {
    addMacaulay2SourceRootsFromExecutable(
      roots,
      resolution.wslExecutablePath,
      fileSystem,
    );
  } else {
    addMacaulay2SourceRootsFromExecutable(
      roots,
      resolution.executablePath,
      fileSystem,
    );
    const realExecutablePath = realpathIfAvailable(resolution.executablePath);
    if (realExecutablePath) {
      addMacaulay2SourceRootsFromExecutable(
        roots,
        realExecutablePath,
        fileSystem,
      );
    }
  }

  if (fileSystem.kind === "wsl") {
    roots.add(workingDir);
    for (const folder of vscode.workspace.workspaceFolders || []) {
      roots.add(windowsPathToWslPath(folder.uri.fsPath));
    }
  } else {
    roots.add(workingDir);
    for (const folder of vscode.workspace.workspaceFolders || []) {
      roots.add(folder.uri.fsPath);
    }
  }

  return Array.from(roots).filter(Boolean);
}

function normalizeM2Input(text: string): string {
  // TODO: remove this ... (make sure stuff copied from editor has \n) and fix ctrl-C
  // Filter out empty lines and send to terminal
  var lines = text.split(/\r?\n/);
  lines = lines.filter((line) => line !== "");
  text = lines.join("\n");

  if (!text.endsWith("\n")) {
    text = text + "\n";
  }
  return text;
}

export function shouldCloseWebviewOnM2Input(text: string): boolean {
  const executableLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("--"));

  if (executableLines.length !== 1) {
    return false;
  }

  return /^(?:exit|quit)(?:\s*\(\s*(?:-?\d+)?\s*\)|\s+-?\d+)?\s*;?$/.test(
    executableLines[0],
  );
}

export function getM2ProcessExitMessage(
  code: number | null,
  signal: string | null,
): string {
  const detail =
    signal !== null
      ? `signal ${signal}`
      : code !== null
        ? `exit code ${code}`
        : "unknown status";

  return `\n[Macaulay2 process exited with ${detail}. Submit input to start a new session.]\n`;
}

function processInputStreamIsWritable(child: ChildProcess): boolean {
  const stdin = child.stdin as any;
  return (
    !!stdin &&
    stdin.writable !== false &&
    stdin.destroyed !== true &&
    stdin.writableEnded !== true
  );
}

function postM2ProcessExitMessage(code: number | null, signal: string | null) {
  if (!g_panel) return;

  g_panel.webview.postMessage({
    type: "output",
    data: getM2ProcessExitMessage(code, signal),
  });
}

function postM2InputWriteFailureMessage(error: Error) {
  if (!g_panel) return;

  g_panel.webview.postMessage({
    type: "output",
    data: `\n[Could not send input to Macaulay2: ${error.message}. Submit input again to start a new session.]\n`,
  });
}

function handleM2StdinError(child: ChildProcess, error: Error) {
  console.error("M2 stdin error:", error);
  if (proc !== child) {
    return;
  }

  proc = undefined;
  closeWebviewOnProcessClose.delete(child);
  keepWebviewOpenOnProcessClose.delete(child);
  postM2InputWriteFailureMessage(error);
}

function startM2() {
  const resolution = getM2ExecutableResolution();
  if (!resolution) {
    return;
  }
  const workingDir = getM2WorkingDir();
  const launch = getM2LaunchConfiguration(
    resolution,
    getM2WebviewProcessArgs(getM2StartupExpression(), getWebviewTopLevelMode()),
    workingDir,
    getM2LaunchArgs(),
  );

  // Spawn M2 directly (no shell) so signals like SIGINT reach the M2 process.
  // Previously we used a shell with `2>&1` which merged stderr/stdout but prevented
  // SIGINT from interrupting the actual M2 process. Listening to both stdout and
  // stderr separately preserves output while allowing interrupts to work.
  const child = spawn(launch.executablePath, launch.args, {
    cwd: launch.cwd,
  });
  proc = child;
  console.log("M2 process started (pid=", child.pid, ")");

  procWorkingDir = getM2ProcessWorkingDir(resolution, workingDir);
  procFileSystem = getM2ProcessFileSystem(resolution);
  procSourceSearchRoots = getMacaulay2SourceSearchRoots(
    resolution,
    procWorkingDir,
    procFileSystem,
  );

  child.stdout.on("data", (data) => {
    if (g_panel)
      g_panel.webview.postMessage({ type: "output", data: data.toString() });
  });

  child.stderr.on("data", (data) => {
    // forward stderr as output too
    console.log("M2 stderr:", data.toString());
    if (g_panel)
      g_panel.webview.postMessage({
        type: "output",
        data: data.toString(),
        stream: "stderr",
      });
  });

  if (child.stdin) {
    child.stdin.on("error", (err) => handleM2StdinError(child, err));
  }

  child.on("error", (err) => {
    console.error("M2 process error:", err);
    if (g_panel)
      g_panel.webview.postMessage({
        type: "output",
        data: `Error starting Macaulay2: ${err.message}`,
      });
    if (proc === child) proc = undefined;
  });

  child.on("close", (code, signal) => {
    console.log("M2 process closed. code=", code, "signal=", signal);
    const closedActiveProcess = proc === child;
    const shouldKeepWebviewOpen = keepWebviewOpenOnProcessClose.has(child);
    const shouldCloseWebview = closeWebviewOnProcessClose.has(child);
    keepWebviewOpenOnProcessClose.delete(child);
    closeWebviewOnProcessClose.delete(child);

    if (!closedActiveProcess) {
      return;
    }

    proc = undefined;

    if (shouldKeepWebviewOpen) {
      if (g_panel) g_panel.webview.postMessage({ type: "exit", code, signal });
      return;
    }

    if (shouldCloseWebview && g_panel) {
      const panel = g_panel;
      g_panel = undefined;
      procWorkingDir = undefined;
      procSourceSearchRoots = [];
      panel.dispose();
      return;
    }

    postM2ProcessExitMessage(code, signal);
  });

  /*
  proc.on("close", (code) => { // not needed at the moment
    proc = undefined;
    g_panel.webview.postMessage({
      type: "exit",
      code,
    });
  });
   */
}

function startREPLCommand() {
  startREPL(false);
}

async function startREPL(preserveFocus: boolean) {
  if (proc !== undefined) {
    return;
  }

  if (startReplPromise) {
    await startReplPromise;
    return;
  }

  startReplPromise = startREPLOnce(preserveFocus).finally(() => {
    startReplPromise = undefined;
  });
  await startReplPromise;
}

async function startREPLOnce(preserveFocus: boolean) {
  if (proc !== undefined) {
    return;
  }

  // Create the webview panel before starting M2 so process output has a target.
  if (g_panel === undefined) {
    const completionItems = g_getWebviewCompletionItems
      ? await g_getWebviewCompletionItems()
      : [];
    if (g_panel === undefined) {
      g_panel = vscode.window.createWebviewPanel(
        "macaulay2Output",
        "Macaulay2 Output",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: preserveFocus },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(g_context!.extensionUri, "media"),
          ],
        },
      );

      g_panel.webview.html = getWebviewContent(
        g_panel.webview,
        completionItems,
        !preserveFocus,
      );

      g_panel.webview.onDidReceiveMessage(handleWebviewMessage);

      g_panel.onDidDispose(() => {
        g_panel = undefined;
        if (proc) {
          proc.kill();
          proc = undefined;
        }
        procWorkingDir = undefined;
        procSourceSearchRoots = [];
      });
    }
  }

  if (proc === undefined) {
    startM2();
  }
}

async function executeCode(
  text: string,
  restoreEditorFocus = false,
  recordSubmittedInput = false,
) {
  const editorToRestore = restoreEditorFocus
    ? vscode.window.activeTextEditor
    : undefined;
  await startREPL(true);

  text = normalizeM2Input(text);
  if (proc && proc.stdin && processInputStreamIsWritable(proc)) {
    const child = proc;
    if (shouldCloseWebviewOnM2Input(text)) {
      closeWebviewOnProcessClose.add(child);
    }
    shouldRestoreEditorFocusAfterWebviewOutput = restoreEditorFocus;
    editorToRestoreAfterWebviewOutput = editorToRestore;
    if (recordSubmittedInput && g_panel) {
      await g_panel.webview.postMessage({
        type: "submittedInput",
        data: text,
      });
    }
    proc.stdin.write(text, (err) => {
      if (err) {
        handleM2StdinError(child, err);
      }
    });
  } else {
    vscode.window.showErrorMessage("Macaulay2 process is not running.");
  }
}

function startTerminalCommand() {
  startM2Terminal(false);
}

function startM2Terminal(preserveFocus: boolean): vscode.Terminal | undefined {
  if (g_terminal && !g_terminal.exitStatus) {
    g_terminal.show(preserveFocus);
    return g_terminal;
  }
  g_terminal = undefined;

  const resolution = getM2ExecutableResolution();
  if (!resolution) {
    return undefined;
  }

  const workingDir = getM2WorkingDir();
  const launch = getM2LaunchConfiguration(
    resolution,
    getM2TerminalProcessArgs(getM2StartupExpression()),
    workingDir,
    getM2LaunchArgs(),
  );
  terminalWorkingDir = getM2ProcessWorkingDir(resolution, workingDir);
  terminalFileSystem = getM2ProcessFileSystem(resolution);
  terminalSourceSearchRoots = getMacaulay2SourceSearchRoots(
    resolution,
    terminalWorkingDir,
    terminalFileSystem,
  );
  g_terminal = vscode.window.createTerminal({
    name: "Macaulay2",
    shellPath: launch.executablePath,
    shellArgs: launch.args,
    cwd: launch.cwd,
  });
  g_terminal.show(preserveFocus);
  return g_terminal;
}

async function handleM2ExecutableChanged() {
  const restartActions: string[] = [];
  if (proc && g_panel) {
    restartActions.push("Restart REPL");
  }
  if (g_terminal && !g_terminal.exitStatus) {
    restartActions.push("Restart Terminal");
  }

  if (restartActions.length === 0) {
    vscode.window.showInformationMessage(
      "M2 executable updated. New M2 sessions will use the selected executable.",
    );
    return;
  }

  const selectedAction = await vscode.window.showInformationMessage(
    "M2 executable updated. Running M2 sessions keep their current executable until restarted.",
    ...restartActions,
  );

  if (selectedAction === "Restart REPL") {
    restartM2Process();
  } else if (selectedAction === "Restart Terminal") {
    restartM2Terminal();
  }
}

function restartM2Process() {
  if (!g_panel) {
    return;
  }

  if (!proc) {
    startM2();
    return;
  }

  const oldProc = proc;
  keepWebviewOpenOnProcessClose.add(oldProc);
  proc = undefined;
  oldProc.once("close", () => {
    if (g_panel) {
      startM2();
    }
  });
  oldProc.kill();
}

function restartM2Terminal() {
  if (g_terminal) {
    g_terminal.dispose();
    g_terminal = undefined;
  }
  startM2Terminal(false);
}

async function executeCodeInTerminal(text: string) {
  const terminal = startM2Terminal(true);
  if (!terminal) {
    return;
  }

  text = normalizeM2Input(text);
  terminal.sendText(text, false);
}

function flashRange(editor: vscode.TextEditor, range: vscode.Range): void {
  const lineHighlight = vscode.workspace
    .getConfiguration("editor")
    .get<string>("renderLineHighlight", "line");
  if (lineHighlight === "none" || lineHighlight === "gutter") {
    return;
  }
  if (!g_flashDecoration) {
    g_flashDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor(
        "editor.selectionHighlightBackground",
      ),
    });
  }
  editor.setDecorations(g_flashDecoration, [{ range }]);
  setTimeout(() => {
    if (g_flashDecoration) editor.setDecorations(g_flashDecoration, []);
  }, 300);
}

export function getParagraphLineRange(
  currentLine: number,
  lineCount: number,
  getLineText: (line: number) => string,
): { startLine: number; endLine: number } | undefined {
  const lastLine = lineCount - 1;

  if (getLineText(currentLine).trim() !== "") {
    let startLine = currentLine;
    while (startLine > 0 && getLineText(startLine - 1).trim() !== "") {
      startLine--;
    }
    let endLine = currentLine;
    while (endLine < lastLine && getLineText(endLine + 1).trim() !== "") {
      endLine++;
    }
    return { startLine, endLine };
  }

  // On a blank line: find the next paragraph below.
  let below = currentLine + 1;
  while (below <= lastLine && getLineText(below).trim() === "") {
    below++;
  }
  if (below <= lastLine) {
    let endLine = below;
    while (endLine < lastLine && getLineText(endLine + 1).trim() !== "") {
      endLine++;
    }
    return { startLine: below, endLine };
  }

  // All whitespace below: fall back to the previous paragraph above.
  let above = currentLine - 1;
  while (above >= 0 && getLineText(above).trim() === "") {
    above--;
  }
  if (above >= 0) {
    let startLine = above;
    while (startLine > 0 && getLineText(startLine - 1).trim() !== "") {
      startLine--;
    }
    return { startLine, endLine: above };
  }

  return undefined;
}

function executeSelectionInTerminal() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const selection = editor.selection;
  const range = selection.isEmpty
    ? editor.document.lineAt(selection.start.line).range
    : new vscode.Range(selection.start, selection.end);
  flashRange(editor, range);
  executeCodeInTerminal(editor.document.getText(range));
  if (selection.isEmpty) {
    vscode.commands.executeCommand("cursorMove", {
      to: "down",
      by: "line",
      value: 1,
    });
  }
}

async function executeSelectionInWebview() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const selection = editor.selection;
  const range = selection.isEmpty
    ? editor.document.lineAt(selection.start.line).range
    : new vscode.Range(selection.start, selection.end);
  flashRange(editor, range);
  await executeCode(editor.document.getText(range), true, true);
  if (selection.isEmpty) {
    vscode.commands.executeCommand("cursorMove", {
      to: "down",
      by: "line",
      value: 1,
    });
  }
}

async function executeLineInWebview() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const line = editor.document.lineAt(editor.selection.active.line);
  flashRange(editor, line.range);
  await executeCode(line.text, true, true);
  vscode.commands.executeCommand("cursorMove", {
    to: "down",
    by: "line",
    value: 1,
  });
}

async function executeRegionInWebview() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const selection = editor.selection;
  if (selection.isEmpty) {
    vscode.window.showInformationMessage("No region selected.");
    return;
  }
  flashRange(editor, selection);
  await executeCode(editor.document.getText(selection), true, true);
}

async function executeBufferInWebview() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const document = editor.document;
  const lastLine = document.lineCount - 1;
  const range = new vscode.Range(
    new vscode.Position(0, 0),
    new vscode.Position(lastLine, document.lineAt(lastLine).text.length),
  );
  flashRange(editor, range);
  await executeCode(document.getText(), true, true);
}

async function executeAboveInWebview() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const position = editor.selection.active;
  if (position.isEqual(new vscode.Position(0, 0))) return;
  const range = new vscode.Range(new vscode.Position(0, 0), position);
  flashRange(editor, range);
  await executeCode(editor.document.getText(range), true, true);
}

async function executeBelowInWebview() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const position = editor.selection.active;
  const lastLine = editor.document.lineCount - 1;
  const lastChar = editor.document.lineAt(lastLine).text.length;
  const end = new vscode.Position(lastLine, lastChar);
  if (position.isEqual(end)) return;
  const range = new vscode.Range(position, end);
  flashRange(editor, range);
  await executeCode(editor.document.getText(range), true, true);
}

async function executeParagraphInWebview() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const document = editor.document;
  const currentLine = editor.selection.active.line;

  const lineRange = getParagraphLineRange(
    currentLine,
    document.lineCount,
    (line) => document.lineAt(line).text,
  );
  if (!lineRange) return;

  const { startLine, endLine } = lineRange;
  const range = new vscode.Range(
    new vscode.Position(startLine, 0),
    new vscode.Position(endLine, document.lineAt(endLine).text.length),
  );
  flashRange(editor, range);
  await executeCode(document.getText(range), true, true);

  if (endLine + 1 < document.lineCount) {
    editor.selection = new vscode.Selection(
      new vscode.Position(endLine + 1, 0),
      new vscode.Position(endLine + 1, 0),
    );
  } else {
    const endChar = document.lineAt(endLine).text.length;
    editor.selection = new vscode.Selection(
      new vscode.Position(endLine, endChar),
      new vscode.Position(endLine, endChar),
    );
  }
}

async function executeFileInWebview(resource?: vscode.Uri) {
  const document = resource
    ? vscode.workspace.textDocuments.find(
        (textDocument) => textDocument.uri.toString() === resource.toString(),
      ) || (await vscode.workspace.openTextDocument(resource))
    : vscode.window.activeTextEditor?.document;

  if (!document) {
    vscode.window.showErrorMessage("Open a Macaulay2 file to run it.");
    return;
  }

  if (document.languageId !== "macaulay2") {
    vscode.window.showErrorMessage("Open a Macaulay2 file to run it.");
    return;
  }

  await executeCode(document.getText(), true, true);
}

function getWebviewContent(
  webview: vscode.Webview,
  completionItems: WebviewCompletionItem[],
  focusInputOnLoad = true,
) {
  const extensionUri = g_context!.extensionUri;
  const nonce = getNonce();
  const htmlPath = vscode.Uri.joinPath(
    extensionUri,
    "media",
    "webview.html",
  ).fsPath;
  let html = fs.readFileSync(htmlPath, "utf8");
  const colorTheme = getWebviewColorTheme();
  html = html.replace(
    '<html lang="en">',
    `<html lang="en" data-macaulay2-color-theme="${colorTheme}">`,
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "main.js"),
  );
  html = html.replace("${scriptUri}", scriptUri.toString());
  const VGUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "VectorGraphics.js"),
  );
  html = html.replace("${VGUri}", VGUri.toString());
  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "minimal.css"),
  );
  html = html.replace("${cssUri}", cssUri.toString());
  const katexCssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "katex", "katex.min.css"),
  );
  html = html.replace("${katexCssUri}", katexCssUri.toString());
  const katexJsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "katex", "katex.min.js"),
  );
  html = html.replace("${katexJsUri}", katexJsUri.toString());
  const katexAutoRenderUri = webview.asWebviewUri(
    vscode.Uri.joinPath(
      extensionUri,
      "media",
      "katex",
      "contrib",
      "auto-render.min.js",
    ),
  );
  html = html.replace("${katexAutoRenderUri}", katexAutoRenderUri.toString());
  html = html.replace(/\$\{nonce\}/g, nonce);
  html = html.replace("${cspMeta}", getWebviewCspMeta(webview, nonce));
  const completionItemsJson = JSON.stringify(completionItems).replace(
    /</g,
    "\\u003c",
  );
  const syntaxJson = JSON.stringify(getWebviewSyntax(extensionUri)).replace(
    /</g,
    "\\u003c",
  );
  const colorThemeJson = JSON.stringify(colorTheme);
  const focusInputOnLoadJson = JSON.stringify(focusInputOnLoad);
  const topLevelModeJson = JSON.stringify(getWebviewTopLevelMode());
  html = html.replace(
    "</head>",
    `<script nonce="${nonce}">window.macaulay2CompletionItems = ${completionItemsJson}; window.macaulay2Syntax = ${syntaxJson}; window.macaulay2ColorTheme = ${colorThemeJson}; window.macaulay2FocusInputOnLoad = ${focusInputOnLoadJson}; window.macaulay2TopLevelMode = ${topLevelModeJson};</script>\n  </head>`,
  );
  return html;
}

function getNonce(): string {
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return nonce;
}

function getWebviewCspMeta(webview: vscode.Webview, nonce: string): string {
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `font-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
  ].join("; ");

  return `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(
    csp,
  )}">`;
}

function getHtmlTitle(html: string, fallback: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return fallback;

  return (
    match[1]
      .replace(/\s+/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .trim() || fallback
  );
}

function getWebviewSyntaxClass(
  scopeName: string,
): { className: WebviewSyntaxClass; priority: number } | undefined {
  if (scopeName.startsWith("keyword.operator.")) {
    return { className: "operator", priority: 5 };
  }
  if (scopeName.startsWith("keyword.")) {
    return { className: "keyword", priority: 4 };
  }
  if (scopeName.startsWith("constant.numeric.")) {
    return { className: "constant", priority: 3 };
  }
  if (scopeName.startsWith("entity.name.type.")) {
    return { className: "class-name", priority: 3 };
  }
  if (scopeName.startsWith("support.function.")) {
    return { className: "function", priority: 2 };
  }
  if (scopeName.startsWith("constant.language.")) {
    return { className: "constant", priority: 1 };
  }
}

export const WEBVIEW_SYNTAX_REPOSITORY_KEYS = [
  "keywords",
  "numbers",
  "support",
];

export function extractWordsFromTextMateMatch(
  match: string,
): string[] | undefined {
  const wordGroup = match.match(/\\b\(([^()]+)\)\\b$/);
  if (!wordGroup) return undefined;

  const words = wordGroup[1].split("|");
  if (!words.every((word) => /^[A-Za-z_]\w*$/.test(word))) return undefined;
  return words;
}

function getWebviewSyntax(extensionUri: vscode.Uri): WebviewSyntax {
  try {
    const grammarPath = vscode.Uri.joinPath(
      extensionUri,
      "syntaxes",
      "macaulay2.tmLanguage.json",
    ).fsPath;
    const grammar = JSON.parse(fs.readFileSync(grammarPath, "utf8"));
    const tokens: WebviewSyntaxToken[] = [];
    const patterns: WebviewSyntaxPattern[] = [];
    // Only these repository entries hold the flat word lists and operator
    // regexes the webview can use; the rest are begin/end rules it has no way
    // to evaluate.
    const patternGroups = WEBVIEW_SYNTAX_REPOSITORY_KEYS.map(
      (key) => grammar.repository?.[key]?.patterns,
    );

    patternGroups.forEach((group) => {
      if (!Array.isArray(group)) return;
      group.forEach((pattern) => {
        if (
          typeof pattern?.name !== "string" ||
          typeof pattern?.match !== "string"
        )
          return;

        const tokenClass = getWebviewSyntaxClass(pattern.name);
        if (!tokenClass) return;

        const words = extractWordsFromTextMateMatch(pattern.match);
        if (words) {
          words.forEach((label) =>
            tokens.push({
              label,
              className: tokenClass.className,
              priority: tokenClass.priority,
            }),
          );
        } else {
          patterns.push({
            source: pattern.match,
            className: tokenClass.className,
          });
        }
      });
    });

    return { tokens, patterns };
  } catch (err) {
    console.warn("Could not load Macaulay2 TextMate grammar for webview", err);
    return { tokens: [], patterns: [] };
  }
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isAbsoluteUri(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function isUnixAbsolutePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}

function decodeUriPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeHelpUrl(rawUrl: string): string {
  let url = rawUrl.trim();
  const quotedUrlMatch = url.match(/^["'](.+?)["'][.,;:!?]*$/);
  if (quotedUrlMatch) {
    return quotedUrlMatch[1];
  }

  return url.replace(/[.,;:!?]+$/, "");
}

function splitFragment(value: string): { pathPart: string; fragment?: string } {
  const hashIndex = value.indexOf("#");
  if (hashIndex < 0) return { pathPart: value };

  return {
    pathPart: value.substring(0, hashIndex),
    fragment: value.substring(hashIndex + 1),
  };
}

function getVSCodeFilePathForM2PathInContext(
  filePath: string,
  fileSystem: M2ProcessFileSystem,
): string | undefined {
  if (fileSystem.kind !== "wsl") {
    return filePath;
  }

  if (isWindowsDrivePath(filePath) || filePath.startsWith("\\\\")) {
    return path.normalize(filePath);
  }

  return wslPathToWindowsPath(
    filePath,
    fileSystem.distroName,
    fileSystem.hostExecutablePath,
  );
}

function getVSCodeFilePathForM2Path(filePath: string): string | undefined {
  return getVSCodeFilePathForM2PathInContext(filePath, procFileSystem);
}

function getHelpTargetForM2Path(
  filePath: string,
  fragment?: string,
): ResolvedHelpTarget {
  const m2FilePath = path.posix.normalize(filePath);
  return {
    filePath: getVSCodeFilePathForM2Path(m2FilePath) || m2FilePath,
    m2FilePath,
    fragment,
  };
}

function resolveM2ProcessFilePathInContext(
  targetPath: string,
  context: M2PathResolutionContext,
): string {
  const decodedTargetPath = decodeUriPath(targetPath);
  if (isAbsoluteUri(decodedTargetPath)) {
    const uri = vscode.Uri.parse(decodedTargetPath);
    if (uri.scheme === "file") {
      return context.fileSystem.kind === "wsl" && isUnixAbsolutePath(uri.path)
        ? path.posix.normalize(uri.path)
        : uri.fsPath;
    }
  }

  if (isWindowsDrivePath(decodedTargetPath)) {
    return path.normalize(decodedTargetPath);
  }

  if (context.fileSystem.kind === "wsl") {
    return isUnixAbsolutePath(decodedTargetPath)
      ? path.posix.normalize(decodedTargetPath)
      : path.posix.resolve(context.workingDir || "/", decodedTargetPath);
  }

  return path.resolve(context.workingDir || process.cwd(), decodedTargetPath);
}

function wslFileExistsInContext(
  fileSystem: M2ProcessFileSystem,
  m2FilePath?: string,
): boolean {
  if (fileSystem.kind !== "wsl" || !m2FilePath) {
    return false;
  }

  try {
    execFileSync(
      fileSystem.hostExecutablePath,
      ["--exec", "test", "-e", m2FilePath],
      {
        stdio: "ignore",
        timeout: 5000,
      },
    );
    return true;
  } catch {
    return false;
  }
}

function fileExistsInPathContext(
  filePath: string | undefined,
  m2FilePath: string,
  context: M2PathResolutionContext,
): boolean {
  return (
    (!!filePath && fs.existsSync(filePath)) ||
    wslFileExistsInContext(context.fileSystem, m2FilePath)
  );
}

function resolveVSCodeFilePathForM2OutputPath(
  targetPath: string,
  context: M2PathResolutionContext,
): string | undefined {
  const directM2Path = resolveM2ProcessFilePathInContext(targetPath, context);
  const directFilePath = getVSCodeFilePathForM2PathInContext(
    directM2Path,
    context.fileSystem,
  );
  if (
    fileExistsInPathContext(directFilePath, directM2Path, context) ||
    path.isAbsolute(targetPath) ||
    isWindowsDrivePath(targetPath) ||
    isAbsoluteUri(targetPath)
  ) {
    return directFilePath;
  }

  const decodedTargetPath = decodeUriPath(targetPath);
  for (const root of context.sourceSearchRoots) {
    const candidateM2Path =
      context.fileSystem.kind === "wsl"
        ? path.posix.resolve(root, decodedTargetPath)
        : path.resolve(root, decodedTargetPath);
    const candidateFilePath = getVSCodeFilePathForM2PathInContext(
      candidateM2Path,
      context.fileSystem,
    );
    if (fileExistsInPathContext(candidateFilePath, candidateM2Path, context)) {
      return candidateFilePath;
    }
  }

  return directFilePath;
}

function resolveHelpFilePath(
  pathPart: string,
  baseFilePath?: string,
  baseM2FilePath?: string,
  fragment?: string,
): ResolvedHelpTarget {
  const decodedPathPart = decodeUriPath(pathPart);

  if (isWindowsDrivePath(decodedPathPart)) {
    return { filePath: path.normalize(decodedPathPart), fragment };
  }

  if (procFileSystem.kind === "wsl" && isUnixAbsolutePath(decodedPathPart)) {
    return getHelpTargetForM2Path(decodedPathPart, fragment);
  }

  if (procFileSystem.kind === "wsl" && baseM2FilePath) {
    const m2BaseDir = path.posix.dirname(baseM2FilePath);
    const m2Path =
      decodedPathPart.length === 0
        ? baseM2FilePath
        : path.posix.resolve(m2BaseDir, decodedPathPart);
    return getHelpTargetForM2Path(m2Path, fragment);
  }

  if (baseFilePath) {
    return {
      filePath:
        decodedPathPart.length === 0
          ? baseFilePath
          : path.resolve(path.dirname(baseFilePath), decodedPathPart),
      fragment,
    };
  }

  if (procFileSystem.kind === "wsl") {
    const baseDir = procWorkingDir || windowsPathToWslPath(process.cwd());
    const m2Path =
      decodedPathPart.length === 0
        ? baseDir
        : path.posix.resolve(baseDir || "/", decodedPathPart);
    return getHelpTargetForM2Path(m2Path, fragment);
  }

  const baseDir = procWorkingDir || process.cwd();
  return { filePath: path.resolve(baseDir, decodedPathPart), fragment };
}

function getMacaulay2DocRoot(filePath: string): string | undefined {
  const resolvedPath = path.resolve(filePath).replace(/\\/g, "/");
  const parts = resolvedPath.split("/");

  for (let i = 1; i < parts.length - 1; i++) {
    if (
      parts[i - 1] === "share" &&
      parts[i] === "doc" &&
      parts[i + 1] === "Macaulay2"
    ) {
      return parts.slice(0, i + 2).join("/") || path.parse(filePath).root;
    }
  }
}

function getMacaulay2DocRootForM2Path(filePath: string): string | undefined {
  const resolvedPath = path.posix.resolve(filePath);
  const parts = resolvedPath.split("/");

  for (let i = 1; i < parts.length - 1; i++) {
    if (
      parts[i - 1] === "share" &&
      parts[i] === "doc" &&
      parts[i + 1] === "Macaulay2"
    ) {
      return parts.slice(0, i + 2).join("/") || "/";
    }
  }
}

function getHelpSourceSearchRoots(state: HelpPanelState): string[] {
  const roots = new Set(procSourceSearchRoots);
  const docRoot = getMacaulay2DocRoot(state.currentFilePath);
  if (docRoot) {
    roots.add(path.resolve(docRoot, "..", "..", "Macaulay2"));
  }

  if (state.currentM2FilePath) {
    const m2DocRoot = getMacaulay2DocRootForM2Path(state.currentM2FilePath);
    if (m2DocRoot) {
      roots.add(path.posix.resolve(m2DocRoot, "..", "..", "Macaulay2"));
    }
  }

  return Array.from(roots).filter(Boolean);
}

function getHelpSourceWorkingDir(state: HelpPanelState): string {
  if (procWorkingDir) {
    return procWorkingDir;
  }

  if (procFileSystem.kind === "wsl" && state.currentM2FilePath) {
    return path.posix.dirname(state.currentM2FilePath);
  }

  return path.dirname(state.currentFilePath);
}

function resolveHelpTarget(
  rawUrl: string,
  baseFilePath?: string,
  baseM2FilePath?: string,
): ResolvedHelpTarget {
  const trimmedUrl = normalizeHelpUrl(rawUrl || "");
  if (!trimmedUrl) return {};
  const { pathPart, fragment } = splitFragment(trimmedUrl);

  if (isWindowsDrivePath(pathPart)) {
    return {
      filePath: path.normalize(pathPart),
      fragment,
    };
  }

  if (isAbsoluteUri(trimmedUrl)) {
    const uri = vscode.Uri.parse(trimmedUrl);
    if (uri.scheme === "file") {
      return procFileSystem.kind === "wsl" && isUnixAbsolutePath(uri.path)
        ? getHelpTargetForM2Path(uri.path, uri.fragment || undefined)
        : { filePath: uri.fsPath, fragment: uri.fragment || undefined };
    }

    return { externalUri: uri };
  }

  return resolveHelpFilePath(pathPart, baseFilePath, baseM2FilePath, fragment);
}

function getHelpLocalResourceRoots(filePath: string): vscode.Uri[] {
  const roots = new Set<string>();
  const fileDir = path.dirname(filePath);
  roots.add(fileDir);
  const docRoot = getMacaulay2DocRoot(filePath);
  if (docRoot) {
    roots.add(docRoot);
    const shareRoot = path.resolve(docRoot, "..", "..");
    const sharedMacaulay2Root = path.join(shareRoot, "Macaulay2");
    if (fs.existsSync(path.join(sharedMacaulay2Root, "Style"))) {
      roots.add(sharedMacaulay2Root);
    }
  }

  let currentDir = fileDir;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(currentDir, "Style"))) {
      roots.add(currentDir);
      break;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return Array.from(roots).map((root) => vscode.Uri.file(root));
}

function getHelpViewColumn(): vscode.ViewColumn {
  return (
    g_panel?.viewColumn ||
    vscode.window.activeTextEditor?.viewColumn ||
    vscode.ViewColumn.Active
  );
}

function setHtmlColorThemeAttribute(
  html: string,
  colorTheme: WebviewColorTheme,
): string {
  if (!/<html\b[^>]*>/i.test(html)) return html;

  return html.replace(/<html\b([^>]*)>/i, (match, attributes) => {
    if (/data-macaulay2-color-theme\s*=/i.test(attributes)) return match;

    return `<html${attributes} data-macaulay2-color-theme="${escapeHtmlAttribute(
      colorTheme,
    )}">`;
  });
}

function getHelpThemeStyle(): string {
  return `<style id="macaulay2-vscode-help-theme">
  :root {
    --m2-help-background: #d8ffff;
    --m2-help-foreground: #000000;
    --m2-help-muted-foreground: #57606a;
    --m2-help-link: #0040a8;
    --m2-help-link-visited: #551a8b;
    --m2-help-link-hover: #006666;
    --m2-help-rule: #50b0b0;
    --m2-help-panel-background: #eaffff;
    --m2-help-code-background: #f7ffff;
    --m2-help-code-foreground: #000000;
    --m2-help-code-border: #50b0b0;
    --m2-help-example-background: #c0ffff;
    --m2-help-example-border: #50b0b0;
    --m2-help-token-comment: #607080;
    --m2-help-token-constant: #004060;
    --m2-help-token-string: #8b2252;
    --m2-help-token-keyword: #a020f0;
    --m2-help-token-function: #0000ff;
    --m2-help-token-class: #1c701c;
    --m2-help-token-operator: #6f4d19;
    --m2-help-token-punctuation: #57606a;
    --m2-help-selection-background: #b3d7ff;
    --m2-help-selection-foreground: #000000;
  }

  :root[data-macaulay2-color-theme="light"] {
    --m2-help-background: #ffffff;
    --m2-help-foreground: #1f2328;
    --m2-help-muted-foreground: #57606a;
    --m2-help-link: #0969da;
    --m2-help-link-visited: #8250df;
    --m2-help-link-hover: #0550ae;
    --m2-help-rule: #d0d7de;
    --m2-help-panel-background: #f6f8fa;
    --m2-help-code-background: #f6f8fa;
    --m2-help-code-foreground: #1f2328;
    --m2-help-code-border: #d0d7de;
    --m2-help-example-background: #f6f8fa;
    --m2-help-example-border: #d0d7de;
    --m2-help-token-comment: #57606a;
    --m2-help-token-constant: #0550ae;
    --m2-help-token-string: #0a3069;
    --m2-help-token-keyword: #8250df;
    --m2-help-token-function: #953800;
    --m2-help-token-class: #116329;
    --m2-help-token-operator: #953800;
    --m2-help-token-punctuation: #57606a;
    --m2-help-selection-background: #0969da;
    --m2-help-selection-foreground: #ffffff;
  }

  :root[data-macaulay2-color-theme="dark"] {
    --m2-help-background: #1f2328;
    --m2-help-foreground: #e6edf3;
    --m2-help-muted-foreground: #8b949e;
    --m2-help-link: #58a6ff;
    --m2-help-link-visited: #d2a8ff;
    --m2-help-link-hover: #79c0ff;
    --m2-help-rule: #484f58;
    --m2-help-panel-background: #161b22;
    --m2-help-code-background: #30363d;
    --m2-help-code-foreground: #e6edf3;
    --m2-help-code-border: #484f58;
    --m2-help-example-background: #30363d;
    --m2-help-example-border: #484f58;
    --m2-help-token-comment: #9aa4ad;
    --m2-help-token-constant: #79c0ff;
    --m2-help-token-string: #a5d6ff;
    --m2-help-token-keyword: #d2a8ff;
    --m2-help-token-function: #ffa657;
    --m2-help-token-class: #7ee787;
    --m2-help-token-operator: #ffa657;
    --m2-help-token-punctuation: #c9d1d9;
    --m2-help-selection-background: #264f78;
    --m2-help-selection-foreground: #ffffff;
  }

  :root[data-macaulay2-color-theme="vscode"] {
    --m2-help-background: var(--vscode-editor-background, #1e1e1e);
    --m2-help-foreground: var(--vscode-editor-foreground, #d4d4d4);
    --m2-help-muted-foreground: var(--vscode-descriptionForeground, #8b949e);
    --m2-help-link: var(--vscode-textLink-foreground, #3794ff);
    --m2-help-link-visited: var(--vscode-textLink-foreground, #c586c0);
    --m2-help-link-hover: var(--vscode-textLink-activeForeground, #4daafc);
    --m2-help-rule: var(--vscode-editorWidget-border, #454545);
    --m2-help-panel-background: var(--vscode-editorWidget-background, #252526);
    --m2-help-code-background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, .17));
    --m2-help-code-foreground: var(--vscode-editor-foreground, #d4d4d4);
    --m2-help-code-border: var(--vscode-editorWidget-border, #454545);
    --m2-help-example-background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, .17));
    --m2-help-example-border: var(--vscode-editorWidget-border, #454545);
    --m2-help-token-comment: var(--vscode-editorCodeLens-foreground, #999999);
    --m2-help-token-constant: var(--vscode-symbolIcon-constantForeground, #4fc1ff);
    --m2-help-token-string: var(--vscode-symbolIcon-stringForeground, #ce9178);
    --m2-help-token-keyword: var(--vscode-symbolIcon-keywordForeground, #c586c0);
    --m2-help-token-function: var(--vscode-symbolIcon-functionForeground, #dcdcaa);
    --m2-help-token-class: var(--vscode-symbolIcon-classForeground, #4ec9b0);
    --m2-help-token-operator: var(--vscode-symbolIcon-operatorForeground, #d4d4d4);
    --m2-help-token-punctuation: var(--vscode-editor-foreground, #d4d4d4);
    --m2-help-selection-background: var(--vscode-editor-selectionBackground, #264f78);
    --m2-help-selection-foreground: var(--vscode-editor-selectionForeground, var(--m2-help-foreground));
  }

  html,
  body {
    background: var(--m2-help-background) !important;
    color: var(--m2-help-foreground) !important;
  }

  body {
    box-sizing: border-box;
    line-height: 1.45;
    margin: 1.25rem auto;
    max-width: 1100px;
    padding: 0 1.25rem 2rem;
  }

  ::selection {
    background: var(--m2-help-selection-background);
    color: var(--m2-help-selection-foreground);
  }

  h1,
  h2,
  h3,
  h4 {
    color: var(--m2-help-foreground);
  }

  hr {
    border: 0;
    border-top: 1px solid var(--m2-help-rule);
  }

  a:link,
  a {
    background-color: transparent !important;
    color: var(--m2-help-link) !important;
  }

  a:visited {
    color: var(--m2-help-link-visited) !important;
  }

  a:hover,
  a:active {
    color: var(--m2-help-link-hover) !important;
  }

  div#buttons {
    background: var(--m2-help-panel-background);
    border: 1px solid var(--m2-help-rule);
    border-radius: 6px;
    box-sizing: border-box;
    gap: 1rem;
    margin-bottom: 1rem;
    padding: .75rem;
  }

  input,
  select,
  textarea {
    background: var(--m2-help-code-background);
    border: 1px solid var(--m2-help-code-border);
    color: var(--m2-help-code-foreground);
  }

  code,
  kbd,
  pre,
  samp,
  span.tt,
  tt {
    background: var(--m2-help-code-background) !important;
    color: var(--m2-help-code-foreground) !important;
    font-family: Iosevka, ui-monospace, SFMono-Regular, Consolas, monospace;
  }

  code,
  kbd,
  samp,
  span.tt,
  tt {
    border: 1px solid var(--m2-help-code-border);
    border-radius: 4px;
    padding: .08em .25em;
  }

  pre {
    border: 1px solid var(--m2-help-code-border);
    border-radius: 6px;
    box-sizing: border-box;
    line-height: 1.35;
    max-width: 100%;
    overflow-x: auto;
    padding: .75rem;
  }

  pre code,
  table.examples pre,
  table.examples pre code {
    background: transparent !important;
    border: 0;
    color: var(--m2-help-code-foreground) !important;
    padding: 0;
  }

  table.examples,
  table.matrix {
    background: var(--m2-help-example-background) !important;
    border-color: var(--m2-help-example-border) !important;
    border-radius: 6px;
    box-sizing: border-box;
    max-width: 100%;
    overflow: auto;
    width: auto;
  }

  table.examples td,
  table.matrix td,
  table.matrix th {
    background: var(--m2-help-code-background);
    border-color: var(--m2-help-example-border) !important;
    color: var(--m2-help-code-foreground);
  }

  .token.comment {
    color: var(--m2-help-token-comment) !important;
  }

  .token.constant {
    color: var(--m2-help-token-constant) !important;
  }

  .token.net,
  .token.string {
    color: var(--m2-help-token-string) !important;
  }

  .token.keyword {
    color: var(--m2-help-token-keyword) !important;
  }

  .token.function {
    color: var(--m2-help-token-function) !important;
  }

  .token.class-name {
    color: var(--m2-help-token-class) !important;
  }

  .token.operator,
  .token.entity,
  .token.url,
  .language-css .token.string,
  .style .token.string {
    background: transparent !important;
    color: var(--m2-help-token-operator) !important;
  }

  .token.punctuation {
    color: var(--m2-help-token-punctuation) !important;
  }
</style>`;
}

function refreshHelpPanels() {
  Array.from(helpPanels).forEach((state) => {
    if (!helpFileExists(state.currentFilePath, state.currentM2FilePath)) return;

    const rawHtml = readHelpFileSync(
      state.currentFilePath,
      state.currentM2FilePath,
    );
    if (rawHtml === undefined) return;

    state.panel.webview.html = getHelpWebviewContent(
      state.panel.webview,
      state.currentFilePath,
      undefined,
      rawHtml,
    );
  });
}

function wslFileExists(m2FilePath?: string): boolean {
  return wslFileExistsInContext(procFileSystem, m2FilePath);
}

function helpFileExists(filePath: string, m2FilePath?: string): boolean {
  return fs.existsSync(filePath) || wslFileExists(m2FilePath);
}

function readWslTextFileSync(m2FilePath?: string): string | undefined {
  if (procFileSystem.kind !== "wsl" || !m2FilePath) {
    return undefined;
  }

  try {
    return execFileSync(
      procFileSystem.hostExecutablePath,
      ["--exec", "cat", m2FilePath],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 5000,
      },
    );
  } catch {
    return undefined;
  }
}

function readHelpFileSync(
  filePath: string,
  m2FilePath?: string,
): string | undefined {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf8");
  }

  return readWslTextFileSync(m2FilePath);
}

function getHelpWebviewContent(
  webview: vscode.Webview,
  filePath: string,
  fragment?: string,
  rawHtml?: string,
): string {
  let html = rawHtml ?? fs.readFileSync(filePath, "utf8");
  const colorTheme = getWebviewColorTheme();
  html = setHtmlColorThemeAttribute(html, colorTheme);
  const fileDir = path.dirname(filePath);
  const dirPath = fileDir.endsWith(path.sep) ? fileDir : fileDir + path.sep;
  const baseUri = webview.asWebviewUri(vscode.Uri.file(dirPath)).toString();
  const baseTag = `<base href="${escapeHtmlAttribute(baseUri)}">`;
  const themeStyle = getHelpThemeStyle();
  const navigationScript = `
<script>
(function() {
  const vscode = acquireVsCodeApi();
  const requestedFragment = ${JSON.stringify(fragment || "")};

  function findAnchor(target) {
    for (var el = target; el && el !== document; el = el.parentElement) {
      if (el.matches && el.matches("a[href]")) return el;
    }

    return null;
  }

  function scrollToFragment(fragment) {
    if (!fragment) return;

    var decodedFragment = decodeURIComponent(fragment);
    var target = document.getElementById(decodedFragment) || document.getElementsByName(decodedFragment)[0];
    if (target && target.scrollIntoView) target.scrollIntoView();
  }

  function openHelpLink(href) {
    if (!href || href.startsWith("javascript:")) return false;
    if (href.startsWith("#")) {
      scrollToFragment(href.substring(1));
      return true;
    }

    vscode.postMessage({ type: "openHelpLink", href: href });
    return true;
  }

  function getSourceLocationTarget(match) {
    var target = match[1] + "#" + match[2];
    if (match[3] !== undefined) target += ":" + match[3];
    if (match[4] !== undefined) {
      target += "-" + match[4];
      if (match[5] !== undefined) target += ":" + match[5];
    }
    return target;
  }

  function linkifySourceLocationElement(element) {
    if (element.children.length > 0) return;

    var text = element.textContent || "";
    var re = /((?:[A-Za-z]:[\\\\/])?[^\\s:"'<>]+\\.m2):(\\d+)(?::(\\d+))?(?:-(\\d+)(?::(\\d+))?)?/g;
    var fragment = document.createDocumentFragment();
    var lastIndex = 0;
    var match;

    while ((match = re.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
      }

      var anchor = document.createElement("a");
      anchor.href = "#";
      anchor.dataset.macaulay2SourceTarget = getSourceLocationTarget(match);
      anchor.textContent = match[0];
      fragment.appendChild(anchor);
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex === 0) return;
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
    }
    element.textContent = "";
    element.appendChild(fragment);
  }

  function linkifySourceLocations() {
    Array.prototype.forEach.call(document.querySelectorAll("span.tt, tt, code, kbd, samp"), linkifySourceLocationElement);
  }

  document.addEventListener("click", function(event) {
    var anchor = findAnchor(event.target);
    if (!anchor) return;

    var sourceTarget = anchor.dataset.macaulay2SourceTarget;
    if (sourceTarget) {
      vscode.postMessage({ type: "openSourceLink", target: sourceTarget });
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      return;
    }

    var href = anchor.dataset.macaulay2HelpHref || anchor.getAttribute("href");
    if (!openHelpLink(href)) return;

    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  }, true);

  window.addEventListener("DOMContentLoaded", function() {
    Array.prototype.forEach.call(document.querySelectorAll("a[href]"), function(anchor) {
      var href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;

      anchor.dataset.macaulay2HelpHref = href;
      anchor.setAttribute("href", "#");
    });

    linkifySourceLocations();
    scrollToFragment(requestedFragment);
  });
}());
</script>`;

  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (headTag) => `${headTag}\n${baseTag}`);
  } else {
    html = `${baseTag}\n${html}`;
  }

  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `${themeStyle}\n</head>`);
  } else {
    html = `${themeStyle}\n${html}`;
  }

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${navigationScript}\n</body>`);
  }

  return `${html}\n${navigationScript}`;
}

async function openHelpUrl(rawUrl: string, state?: HelpPanelState) {
  const target = resolveHelpTarget(
    rawUrl,
    state?.currentFilePath,
    state?.currentM2FilePath,
  );
  if (target.externalUri) {
    await vscode.env.openExternal(target.externalUri);
    return;
  }

  if (!target.filePath) {
    vscode.window.showErrorMessage(
      `Could not resolve Macaulay2 help URL: ${rawUrl}`,
    );
    return;
  }

  const filePath = target.filePath;
  if (!helpFileExists(filePath, target.m2FilePath)) {
    vscode.window.showErrorMessage(
      `Macaulay2 help file does not exist: ${filePath}`,
    );
    return;
  }

  if (!/\.(html?|xhtml)$/i.test(filePath)) {
    await vscode.env.openExternal(vscode.Uri.file(filePath));
    return;
  }

  const rawHtml = readHelpFileSync(filePath, target.m2FilePath);
  if (rawHtml === undefined) {
    vscode.window.showErrorMessage(
      `Macaulay2 help file could not be read: ${filePath}`,
    );
    return;
  }
  const title = getHtmlTitle(rawHtml, path.basename(filePath));
  const panelState =
    state || createHelpPanel(title, filePath, target.m2FilePath);

  panelState.currentFilePath = filePath;
  panelState.currentM2FilePath = target.m2FilePath;
  panelState.panel.title = title;
  panelState.panel.webview.options = {
    ...panelState.panel.webview.options,
    localResourceRoots: getHelpLocalResourceRoots(filePath),
  };
  panelState.panel.webview.html = getHelpWebviewContent(
    panelState.panel.webview,
    filePath,
    target.fragment,
    rawHtml,
  );
  panelState.panel.reveal(panelState.panel.viewColumn || getHelpViewColumn());
}

function reportHelpOpenError(error: any) {
  console.error("Failed to open Macaulay2 help:", error);
  const message = error instanceof Error ? error.message : String(error);
  vscode.window.showErrorMessage(`Failed to open Macaulay2 help: ${message}`);
}

function createHelpPanel(
  title: string,
  filePath: string,
  m2FilePath?: string,
): HelpPanelState {
  const panel = vscode.window.createWebviewPanel(
    "macaulay2Help",
    title,
    getHelpViewColumn(),
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: getHelpLocalResourceRoots(filePath),
    },
  );
  const state = {
    panel,
    currentFilePath: filePath,
    currentM2FilePath: m2FilePath,
  };

  panel.webview.onDidReceiveMessage((message) => {
    if (message.type === "openHelpLink") {
      openHelpUrl(message.href, state).catch(reportHelpOpenError);
    } else if (
      message.type === "openSourceLink" &&
      typeof message.target === "string" &&
      message.target.length <= 8192
    ) {
      openM2OutputFileTarget(message.target, {
        workingDir: getHelpSourceWorkingDir(state),
        fileSystem: procFileSystem,
        sourceSearchRoots: getHelpSourceSearchRoots(state),
      }).catch((error) => {
        console.error("Failed to open Macaulay2 help source link:", error);
        vscode.window.showErrorMessage(
          `Failed to open Macaulay2 help source link: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
  });
  panel.onDidDispose(() => helpPanels.delete(state));
  helpPanels.add(state);

  return state;
}

export function getM2OutputFileLocationLinks(
  text: string,
): M2OutputFileLocationLink[] {
  const re =
    /((?:[A-Za-z]:[\\/])?[^\s:"'<>]+\.m2):(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?/g;
  const links: M2OutputFileLocationLink[] = [];
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const [, filePath, lineNum, colNum, endLineNum, endColNum] = match;
    let target = `${filePath}#${lineNum}`;
    if (colNum !== undefined) target += `:${colNum}`;
    if (endLineNum !== undefined) {
      target += `-${endLineNum}`;
      if (endColNum !== undefined) target += `:${endColNum}`;
    }
    links.push({
      index: match.index,
      text: match[0],
      target,
    });
  }

  return links;
}

function parseVSCodeFragment(pathWithFragment: string): {
  path: string;
  start?: { line: number; column: number };
  end?: { line: number; column: number };
} {
  const re = /^(.*?)(?:#\D*(\d+)(?::\D*(\d+))?(?:-\D*(\d+)(?::\D*(\d+))?)?)?$/;
  const m = pathWithFragment.match(re);
  if (!m) return { path: pathWithFragment };

  const [, path, line1, col1, line2, col2] = m;
  let result: {
    path: string;
    start?: { line: number; column: number };
    end?: { line: number; column: number };
  } = { path };

  if (line1)
    result.start = {
      line: parseInt(line1) - 1,
      column: col1 ? parseInt(col1) : 0,
    }; // TODO check shifts by 1
  if (line2)
    result.end = {
      line: parseInt(line2) - 1,
      column: col2 ? parseInt(col2) : 0,
    };
  return result;
}

async function openM2OutputFileTarget(
  target: string,
  context: M2PathResolutionContext,
) {
  if (!context.workingDir) {
    vscode.window.showErrorMessage(
      "Cannot open Macaulay2 output link because the working directory is unknown.",
    );
    return;
  }

  const { path: relPath, start, end } = parseVSCodeFragment(target);
  let selection;
  if (start && end) {
    selection = new vscode.Range(
      start.line,
      start.column,
      end.line,
      end.column,
    );
  } else if (start) {
    selection = new vscode.Range(
      start.line,
      start.column,
      start.line,
      start.column,
    );
  }
  const filePath = resolveVSCodeFilePathForM2OutputPath(relPath, context);
  if (!filePath) {
    vscode.window.showErrorMessage(
      `Cannot open Macaulay2 output link because the WSL path could not be mapped to Windows: ${relPath}`,
    );
    return;
  }

  const fileUri = vscode.Uri.file(filePath);
  await vscode.window.showTextDocument(fileUri, {
    preview: false,
    selection,
    viewColumn: vscode.ViewColumn.One,
  });
}

function interruptM2() {
  console.log("interrupt");
  if (
    g_terminal &&
    !g_terminal.exitStatus &&
    (vscode.window.activeTerminal === g_terminal || !proc)
  ) {
    g_terminal.sendText("\x03", false);
    return;
  }

  if (!proc) return;

  try {
    // Best-effort: send SIGINT to the child process so it can interrupt computations.
    proc.kill("SIGINT");
  } catch (e) {
    console.error("Failed to send SIGINT to M2 process:", e);
    // On Windows, proc.kill('SIGINT') may not work. Attempt taskkill as a fallback.
    if (process.platform === "win32" && proc.pid) {
      try {
        const killer = spawn("taskkill", [
          "/PID",
          String(proc.pid),
          "/T",
          "/F",
        ]);
        killer.on("close", () => {
          console.log("taskkill executed for pid", proc!.pid);
        });
      } catch (ee) {
        console.error("taskkill fallback failed:", ee);
      }
    }
  }
}

function getWebviewMessageString(
  message: { data?: unknown },
  maxLength = 1024 * 1024,
): string | undefined {
  if (typeof message.data !== "string") {
    return undefined;
  }
  if (message.data.length > maxLength || message.data.includes("\0")) {
    return undefined;
  }
  return message.data;
}

function handleWebviewMessage(message: any) {
  if (!message || typeof message.type !== "string") {
    return;
  }

  switch (message.type) {
    case "input": {
      const input = getWebviewMessageString(message);
      if (input === undefined) break;
      executeCode(input);
      break;
    }
    case "reset":
      console.log("reset");
      if (proc) {
        keepWebviewOpenOnProcessClose.add(proc);
        proc.kill();
      }
      procWorkingDir = undefined; // Reset working directory
      procSourceSearchRoots = [];
      startM2();
      break;
    case "interrupt":
      interruptM2();
      break;
    case "paste":
      if (!g_panel?.active) {
        break;
      }
      vscode.env.clipboard.readText().then(
        (text) => {
          if (g_panel)
            g_panel.webview.postMessage({ type: "paste", data: text });
        },
        (err) => console.error("Failed to read clipboard:", err),
      );
      break;
    case "open": {
      const target = getWebviewMessageString(message, 8192);
      if (target === undefined) break;
      console.log("open " + target);
      openM2OutputFileTarget(target, {
        workingDir: procWorkingDir,
        fileSystem: procFileSystem,
        sourceSearchRoots: procSourceSearchRoots,
      }).catch((error) => {
        console.error("Failed to open Macaulay2 output link:", error);
        vscode.window.showErrorMessage(
          `Failed to open Macaulay2 output link: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      break;
    }
    case "openHelp": {
      const target = getWebviewMessageString(message, 8192);
      if (target === undefined) break;
      console.log("open help " + target);
      openHelpUrl(target).catch(reportHelpOpenError);
      break;
    }
    case "focus":
      if (!shouldRestoreEditorFocusAfterWebviewOutput) {
        break;
      }
      shouldRestoreEditorFocusAfterWebviewOutput = false;
      const editor = editorToRestoreAfterWebviewOutput;
      editorToRestoreAfterWebviewOutput = undefined;
      if (editor)
        vscode.window.showTextDocument(
          editor!.document,
          editor!.viewColumn,
          false,
        ); // restore focus
      break;
  }
}

class Macaulay2TerminalLink extends vscode.TerminalLink {
  constructor(
    startIndex: number,
    length: number,
    readonly target: string,
  ) {
    super(startIndex, length, "Open Macaulay2 source");
  }
}

class Macaulay2TerminalLinkProvider implements vscode.TerminalLinkProvider<Macaulay2TerminalLink> {
  provideTerminalLinks(
    context: vscode.TerminalLinkContext,
    _token: vscode.CancellationToken,
  ): Macaulay2TerminalLink[] {
    if (context.terminal !== g_terminal) {
      return [];
    }

    return getM2OutputFileLocationLinks(context.line).map(
      (link) =>
        new Macaulay2TerminalLink(link.index, link.text.length, link.target),
    );
  }

  handleTerminalLink(link: Macaulay2TerminalLink): void {
    openM2OutputFileTarget(link.target, {
      workingDir: terminalWorkingDir,
      fileSystem: terminalFileSystem,
      sourceSearchRoots: terminalSourceSearchRoots,
    }).catch((error) => {
      console.error("Failed to open Macaulay2 terminal link:", error);
      vscode.window.showErrorMessage(
        `Failed to open Macaulay2 terminal link: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
}

export function activate(
  context: vscode.ExtensionContext,
  getWebviewCompletionItems?: () => Promise<WebviewCompletionItem[]>,
) {
  g_context = context;
  g_getWebviewCompletionItems = getWebviewCompletionItems;

  context.subscriptions.push(
    vscode.commands.registerCommand("macaulay2.startREPL", startREPLCommand),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "macaulay2.startTerminal",
      startTerminalCommand,
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "macaulay2.sendToREPL",
      executeSelectionInWebview,
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "macaulay2.sendToWebview",
      executeSelectionInWebview,
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("macaulay2.runFile", executeFileInWebview),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "macaulay2.sendToTerminal",
      executeSelectionInTerminal,
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("macaulay2.interruptREPL", interruptM2),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "macaulay2.sendLineToREPL",
      executeLineInWebview,
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "macaulay2.sendRegionToREPL",
      executeRegionInWebview,
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "macaulay2.sendBufferToREPL",
      executeBufferInWebview,
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "macaulay2.sendAboveToREPL",
      executeAboveInWebview,
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "macaulay2.sendBelowToREPL",
      executeBelowInWebview,
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "macaulay2.sendParagraphToREPL",
      executeParagraphInWebview,
    ),
  );
  registerM2ExecutableSwitcher(context, handleM2ExecutableChanged);
  context.subscriptions.push(
    vscode.window.registerTerminalLinkProvider(
      new Macaulay2TerminalLinkProvider(),
    ),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("macaulay2.webviewColorTheme")) {
        postWebviewSettings();
        refreshHelpPanels();
      }
    }),
  );
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === g_terminal) {
        g_terminal = undefined;
        terminalWorkingDir = undefined;
        terminalSourceSearchRoots = [];
      }
    }),
  );
}

export function deactivate() {
  if (proc) {
    proc.kill();
    proc = undefined;
    procWorkingDir = undefined;
    procSourceSearchRoots = [];
  }
  if (g_terminal) {
    g_terminal.dispose();
    g_terminal = undefined;
    terminalWorkingDir = undefined;
    terminalSourceSearchRoots = [];
  }
  if (g_flashDecoration) {
    g_flashDecoration.dispose();
    g_flashDecoration = undefined;
  }
}
