import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Shell } from "./shellEmulator";

let g_context: vscode.ExtensionContext | undefined;
let g_terminal: vscode.Terminal | undefined;
let g_panel: vscode.WebviewPanel | undefined;
let outputFilePath: string | undefined;
let filePosition = 0; // Variable to track the current read position in the file

function startREPLCommand(context: vscode.ExtensionContext) {
    startREPL(false);
}

async function startREPL(preserveFocus: boolean) {
    if (g_terminal === undefined) {
        let exepath = vscode.workspace.getConfiguration("macaulay2").get<string>("executablePath");
        let editor = vscode.window.activeTextEditor;
        let fullpath = editor!.document.uri.path;
        let dirpath = path.dirname(fullpath);

        // Create a temporary file for output
        outputFilePath = path.join(dirpath, "macaulay2_output.txt");
        fs.writeFileSync(outputFilePath, ""); // Clear the file initially

        g_terminal = vscode.window.createTerminal({
            name: "macaulay2",
            shellPath: "/bin/bash",
            cwd: `${dirpath}`,
          shellArgs: ['-c', `stty -echo; ${exepath} --webapp 2>&1 | tee ${outputFilePath}`] // Redirect both stdout and stderr to the file
        });

      g_terminal.show(preserveFocus);


        // Create or show the webview panel
        if (g_panel === undefined) {
            g_panel = vscode.window.createWebviewPanel(
                'macaulay2Output',
                'Macaulay2 Output',
                vscode.ViewColumn.Two,
                {
                  enableScripts: true,
		  localResourceRoots: [vscode.Uri.joinPath(g_context.extensionUri, 'out')],
                }
            );

          g_panel.webview.html = getWebviewContent(g_panel.webview);

            g_panel.webview.onDidReceiveMessage(handleWebviewMessage);

            g_panel.onDidDispose(() => {
                g_panel = undefined;
            });
        }

        // Start listening to the output file for changes
        startOutputListener();
    }
}

function startOutputListener() {
    if (outputFilePath && g_panel) {
        console.log(`Watching file: ${outputFilePath}`);

        // Watch the file for changes
        fs.watch(outputFilePath, (eventType) => {
            if (eventType === 'change') {
                console.log(`File changed: ${outputFilePath}`);

                if (outputFilePath) {
                    // Read only the new data from the file
                    let stats = fs.statSync(outputFilePath); // Get the current size of the file
                    let stream = fs.createReadStream(outputFilePath, {
                        start: filePosition,
                        end: stats.size
                    });

                    let newData = '';
                    stream.on('data', chunk => {
                        newData += chunk.toString();
                    });

                    stream.on('end', () => {
                        filePosition = stats.size; // Update the position for next read
                        // Remove specific terminal control characters
                      //newData = newData.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, ''); // Remove ANSI escape codes
                      //  newData = newData.replace(/\x1B\[\?2004[hl]/g, ''); // Remove specific control sequences
                        g_panel!.webview.postMessage({ command: 'output', text: newData });
                    });
                } else {
                    console.error('outputFilePath is undefined!');
                }
            }
        });
    } else {
        console.error('Output file path or webview panel is undefined!');
    }
}

async function executeCode(text: string) {
    if (!text.endsWith("\n")) {
        text = text + '\n';
    }

    await startREPL(true);
    g_terminal!.show(true);

    // Filter out empty lines and send to terminal
    var lines = text.split(/\r?\n/);
    lines = lines.filter(line => line !== '');
    text = lines.join('\n');

  /*
  // Also append the command itself to the output file for logging
     if (outputFilePath) {
     fs.appendFileSync(outputFilePath, text + "\n");
     }
   */
    g_terminal!.sendText(text);

    // Move the cursor to the next line
    vscode.commands.executeCommand('cursorMove', { to: 'down', by: 'line', value: 1 });
}

function executeSelection() {
    var editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    var selection = editor.selection;
    var text = selection.isEmpty ? editor.document.lineAt(selection.start.line).text : editor.document.getText(selection);

    executeCode(text);
}

function getWebviewContent(webview: vscode.Webview) {
  
  const extensionUri = g_context.extensionUri;
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out','main.js'));
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out','minimal.css'));
  
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
    <style>
                body {
                    font-family: monospace;
                    white-space: pre;
                }
                #terminal {
                    max-height: 90vh;
                    overflow-y: auto;
                }
            </style>
            <link rel="stylesheet" href="${cssUri}">
        </head>
        <body>
            <div id="terminal" class="M2Text"></div>
            <script type="module" src="${scriptUri}"></script>
        </body>
        </html>
    `;
}

function handleWebviewMessage(message: any) {
    switch (message.command) {
        case 'execute':
            executeCode(message.text);
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
