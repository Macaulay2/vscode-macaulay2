import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

import { spawn, ChildProcess } from "child_process";

let g_context: vscode.ExtensionContext | undefined;
let g_panel: vscode.WebviewPanel | undefined;
let proc: ChildProcess | undefined;
let procWorkingDir: string | undefined;

function startM2() {
  let exepath = vscode.workspace
    .getConfiguration("macaulay2")
    .get<string>("executablePath");
  if (!exepath) {
    vscode.window.showErrorMessage(
      "Macaulay2 executable path is not set. Please configure 'macaulay2.executablePath' in your settings.",
    );
    return;
  }

  // Determine the working directory for Macaulay2
  let workingDir: string;
  const activeEditor = vscode.window.activeTextEditor;
  
  if (activeEditor && activeEditor.document.uri.scheme === 'file') {
    // Use the directory of the currently active file
    workingDir = path.dirname(activeEditor.document.uri.fsPath);
    console.log(`Starting M2 in current file directory: ${workingDir}`);
  } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    // Use the first workspace folder
    workingDir = vscode.workspace.workspaceFolders[0].uri.fsPath;
    console.log(`Starting M2 in workspace root: ${workingDir}`);
  } else {
    // Fallback to process.cwd()
    workingDir = process.cwd();
    console.log(`Starting M2 in process working directory: ${workingDir}`);
  }

  // proc = spawn(exepath, ["--webapp"]); // this fixes SIGINT but breaks stderr/stdout interleaving
  proc = spawn(exepath, ["--webapp", "2>&1"], { shell: true, cwd: workingDir }); // for now, use this instead -- breaks SIGINT but error messages displayed correctly
  console.log("M2 process started");

  procWorkingDir = workingDir;

  proc.stdout.on("data", (data) => {
    // Send output to webview
    // console.log("M2 stdout:", data.toString());
    if (g_panel)
      g_panel.webview.postMessage({
        type: "output",
        data: data.toString(),
      });
  });

  proc.stderr.on('data', (data) => { // not needed with 2>&1
    console.log('M2 stderr:', data.toString());
    if (g_panel)
        g_panel.webview.postMessage({
            type: 'output',
            data: data.toString()
        });
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

function startREPLCommand(context: vscode.ExtensionContext) {
  startREPL(false);
}

async function startREPL(preserveFocus: boolean) {
  if (proc === undefined) {
    // Create or show the webview panel
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

      g_panel.webview.html = getWebviewContent(g_panel.webview);

      g_panel.webview.onDidReceiveMessage(handleWebviewMessage);

      g_panel.onDidDispose(() => {
        g_panel = undefined;
        if (proc) {
          proc.kill();
          proc = undefined;
        }
      });
    }
    startM2();
  }
}

async function executeCode(text: string) {
  await startREPL(true);

  // TODO: remove this ... (make sure stuff copied from editor has \n) and fix ctrl-C
  // Filter out empty lines and send to terminal
  var lines = text.split(/\r?\n/);
  lines = lines.filter((line) => line !== "");
  text = lines.join("\n");

  if (!text.endsWith("\n")) {
    text = text + "\n";
  }
  // ... until here
  if (proc && proc.stdin) {
    proc.stdin.write(text);
  } else {
    vscode.window.showErrorMessage("Macaulay2 process is not running.");
  }
}

function executeSelection() {
  var editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  var selection = editor.selection;
  var text = selection.isEmpty
    ? editor.document.lineAt(selection.start.line).text
    : editor.document.getText(selection);

  executeCode(text);
  // Move the cursor to the next line
  vscode.commands.executeCommand("cursorMove", {
    to: "down",
    by: "line",
    value: 1,
  });
}

function getWebviewContent(webview: vscode.Webview) {
  const extensionUri = g_context!.extensionUri;
  const htmlPath = vscode.Uri.joinPath(
    extensionUri,
    "media",
    "webview.html",
  ).fsPath;
  let html = fs.readFileSync(htmlPath, "utf8");
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
  return html;
}

function parseVSCodeFragment(pathWithFragment: string): {
  path: string,
  start?: { line: number, column: number },
  end?: { line: number, column: number }
} {
  const re = /^(.*?)(?:#\D*(\d+)(?::\D*(\d+))?(?:-\D*(\d+)(?::\D*(\d+))?)?)?$/;
  const m = pathWithFragment.match(re);
  if (!m) return { path: pathWithFragment };

  const [ , path, line1, col1, line2, col2 ] = m;
  let result: {
    path: string,
    start?: { line: number, column: number },
    end?: { line: number, column: number }
  } = { path };

  if (line1) result.start = { line: parseInt(line1) - 1, column: col1 ? parseInt(col1) : 0 }; // TODO check shifts by 1
  if (line2) result.end   = { line: parseInt(line2) - 1, column: col2 ? parseInt(col2) : 0 };
  return result;
}

function handleWebviewMessage(message: any) {
  switch (message.type) {
    case "input":
      executeCode(message.data);
      break;
    case "reset":
      console.log("reset");
      if (proc) proc.kill();
      startM2();
      break;
    case "interrupt":
      console.log("interrupt");
      if (proc) proc.kill("SIGINT");
      break;
    case "open":
      console.log("open "+message.data);
      // fix relative path: relative to where M2 was started
      const { path: relPath, start, end } = parseVSCodeFragment(message.data);
      let selection;
      if (start && end) {
	selection = new vscode.Range(start.line, start.column, end.line, end.column);
      } else if (start) {
	selection = new vscode.Range(start.line, start.column, start.line, start.column);
      }
      const absPath = path.resolve(procWorkingDir!, relPath);
      const fileUri = vscode.Uri.file(absPath);
      vscode.window.showTextDocument(fileUri, { preview: false, selection, viewColumn: vscode.ViewColumn.One });
      break;
    case "focus":
      const editor = vscode.window.activeTextEditor;
      if (editor)
        vscode.window.showTextDocument(
          editor!.document,
          editor!.viewColumn,
          false,
        ); // restore focus
      break;
  }
}

export function activate(context: vscode.ExtensionContext) {
  g_context = context;

  context.subscriptions.push(
    vscode.commands.registerCommand("macaulay2.startREPL", startREPLCommand),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("macaulay2.sendToREPL", executeSelection),
  );
}

export function deactivate() {
  if (proc) {
    proc.kill();
    proc = undefined;
  }
}
