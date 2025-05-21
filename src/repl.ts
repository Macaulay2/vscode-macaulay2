import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

import { spawn, ChildProcess} from 'child_process';

let g_context: vscode.ExtensionContext | undefined;
let g_terminal: vscode.Terminal | undefined;
let g_panel: vscode.WebviewPanel | undefined;
let outputFilePath: string | undefined;
let filePosition = 0; // Variable to track the current read position in the file
let proc: ChildProcess | undefined; 

function runAndSendToWebview(webview: vscode.Webview) {
    let exepath = vscode.workspace.getConfiguration("macaulay2").get<string>("executablePath");
    if (!exepath) {
        vscode.window.showErrorMessage("Macaulay2 executable path is not set. Please configure 'macaulay2.executablePath' in your settings.");
        return;
    }
    proc = spawn(exepath, ['--webapp']);
    console.log('M2 process started');

    proc.stdout.on('data', (data) => {
        // Send output to webview
        console.log('M2 stdout:', data.toString());
        webview.postMessage({
            type: 'output',
            data: data.toString()
        });
    });

    proc.stderr.on('data', (data) => {
        webview.postMessage({
            type: 'output',
            data: data.toString()
        });
    });

    proc.on('close', (code) => {
        webview.postMessage({
            type: 'exit',
            code
        });
    });
}



function startREPLCommand(context: vscode.ExtensionContext) {
    startREPL(false);
}

async function startREPL(preserveFocus: boolean) {
    if (proc === undefined) {
        let exepath = vscode.workspace.getConfiguration("macaulay2").get<string>("executablePath");
        let editor = vscode.window.activeTextEditor;
        let fullpath = editor!.document.uri.path;
        let dirpath = path.dirname(fullpath);

        // Create or show the webview panel
        if (g_panel === undefined) {
            g_panel = vscode.window.createWebviewPanel(
                'macaulay2Output',
                'Macaulay2 Output',
                vscode.ViewColumn.Two,
                {
                  enableScripts: true,
		  localResourceRoots: [vscode.Uri.joinPath(g_context!.extensionUri, 'media')],
                }
            );

          g_panel.webview.html = getWebviewContent(g_panel.webview);

            g_panel.webview.onDidReceiveMessage(handleWebviewMessage);

            g_panel.onDidDispose(() => {
                g_panel = undefined;
            });
        }

        runAndSendToWebview(g_panel.webview); 
    }
}


async function executeCode(text: string) {
    if (!text.endsWith("\n")) {
        text = text + '\n';
    }

    await startREPL(true);
    //g_terminal!.show(true);

    // Filter out empty lines and send to terminal
    var lines = text.split(/\r?\n/);
    lines = lines.filter(line => line !== '');
    text = lines.join('\n');

    if (proc && proc.stdin) {
        proc.stdin.write(text + '\n');
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
    var text = selection.isEmpty ? editor.document.lineAt(selection.start.line).text : editor.document.getText(selection);

  executeCode(text);
  // Move the cursor to the next line
  vscode.commands.executeCommand('cursorMove', { to: 'down', by: 'line', value: 1 });
}

function getWebviewContent(webview: vscode.Webview) {
  
  const extensionUri = g_context!.extensionUri;
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media','main.js'));
  const VGUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media','VectorGraphics.js'));
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media','minimal.css'));
    return `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Macaulay2 Output</title>
            <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.13.11/dist/katex.min.css">
            <script defer src="https://cdn.jsdelivr.net/npm/katex@0.13.11/dist/katex.min.js"></script>
            <script defer src="https://cdn.jsdelivr.net/npm/katex@0.13.11/dist/contrib/auto-render.min.js"></script>
            <link rel="stylesheet" href="${cssUri}">
            <script type="module" src="${scriptUri}"></script>
            <script type="module" src="${VGUri}"></script>
          </head>
          <body id="terminal" class="M2Text" style="max-height: 90vh">
          </body>
        </html>
    `;
}

function handleWebviewMessage(message: any) {
    switch (message.type) {
      case 'execute':
        executeCode(message.data);
        break;
      case 'focus':
        const editor = vscode.window.activeTextEditor;
	vscode.window.showTextDocument(editor!.document, editor!.viewColumn, false); // restore focus
	break;
    }
}

export function activate(context: vscode.ExtensionContext) {
    g_context = context;

    context.subscriptions.push(vscode.commands.registerCommand('macaulay2.startREPL', startREPLCommand));
    context.subscriptions.push(vscode.commands.registerCommand('macaulay2.sendToREPL', executeSelection));

    vscode.window.onDidCloseTerminal(terminal => {
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
