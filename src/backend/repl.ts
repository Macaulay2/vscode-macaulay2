import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

import { spawn, ChildProcess } from "child_process";

let g_context: vscode.ExtensionContext | undefined;
let g_terminal: vscode.Terminal | undefined;
let g_panel: vscode.WebviewPanel | undefined;
let outputFilePath: string | undefined;
let filePosition = 0; // Variable to track the current read position in the file
let proc: ChildProcess | undefined;

function runAndSendToWebview(webview: vscode.Webview) {
  let exepath = vscode.workspace
    .getConfiguration("macaulay2")
    .get<string>("executablePath");
  if (!exepath) {
    vscode.window.showErrorMessage(
      "Macaulay2 executable path is not set. Please configure 'macaulay2.executablePath' in your settings.",
    );
    return;
  }
  proc = spawn(exepath, ["--webapp", "2>&1"], { shell: true });
  console.log("M2 process started");

  proc.stdout.on("data", (data) => {
    // Send output to webview
    console.log("M2 stdout:", data.toString());
    webview.postMessage({
      type: "output",
      data: data.toString(),
    });
  });

  /*
    proc.stderr.on('data', (data) => {
        console.log('M2 stderr:', data.toString());
        webview.postMessage({
            type: 'output',
            data: data.toString()
        });
    });
   */

  proc.on("close", (code) => {
    proc = undefined;
    webview.postMessage({
      type: "exit",
      code,
    });
  });
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
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: preserveFocus },
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

    runAndSendToWebview(g_panel.webview);
  }
}

async function executeCode(text: string) {
  await startREPL(true);

  // Filter out empty lines and send to terminal
  var lines = text.split(/\r?\n/);
  lines = lines.filter((line) => line !== "");
  text = lines.join("\n");

  if (!text.endsWith("\n")) {
    text = text + "\n";
  }

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
  const htmlPath = vscode.Uri.joinPath(extensionUri, 'media', 'webview.html').fsPath;
  let html = fs.readFileSync(htmlPath, 'utf8');
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "main.js"),
  );
  html = html.replace('${scriptUri}', scriptUri.toString());
  const VGUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "VectorGraphics.js"),
  );
  html = html.replace('${VGUri}', VGUri.toString());
  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "minimal.css"),
  );
  html = html.replace('${cssUri}', cssUri.toString());
  return html;
}

function handleWebviewMessage(message: any) {
  switch (message.type) {
    case "execute":
      executeCode(message.data);
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

  vscode.window.onDidCloseTerminal((terminal) => {
    if (terminal === g_terminal) {
      g_terminal = undefined;
    }
  });
}

export function deactivate() {
  if (g_terminal) {
    g_terminal.dispose();
  }
  if (g_panel) {
    g_panel.dispose();
  }
}
