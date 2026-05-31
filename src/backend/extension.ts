// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
"use strict";

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import * as repl from "./repl";
import * as formatter from "./formatter";
import client from "./client";
import hljs from "highlight.js/lib/core";
import hljsM2 from "highlightjs-macaulay2";

hljs.registerLanguage("macaulay2", hljsM2);

type CompletionProviderModule = typeof import("./completionProviders");

function isMacaulay2Document(document: vscode.TextDocument): boolean {
  return document.languageId === "macaulay2";
}

function isLanguageServerAvailable(): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, "M2-language-server"), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log('Congratulations, your extension "macaulay2" is now active!');

  let completionsModule: Promise<CompletionProviderModule> | undefined;
  let completionsActivated = false;
  let activateCompletionsPromise: Promise<void> | undefined;
  const loadCompletions = () => {
    if (!completionsModule) {
      completionsModule = import("./completionProviders");
    }
    return completionsModule;
  };

  const activateCompletions = () => {
    if (completionsActivated) {
      return Promise.resolve();
    }

    if (!activateCompletionsPromise) {
      activateCompletionsPromise = loadCompletions().then((completions) => {
        completions.activate(context);
        completionsActivated = true;
      });
    }
    return activateCompletionsPromise;
  };

  const getWebviewCompletionItems = async () => {
    await activateCompletions();
    const completions = await loadCompletions();
    return completions.getWebviewCompletionItems();
  };

  if (vscode.workspace.textDocuments.some(isMacaulay2Document)) {
    void activateCompletions();
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (isMacaulay2Document(document)) {
        void activateCompletions();
      }
    }),
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && isMacaulay2Document(editor.document)) {
        void activateCompletions();
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "macaulay2.openGettingStartedExample",
      () => {
        const exampleUri = vscode.Uri.joinPath(
          context.extensionUri,
          "examples",
          "getting-started.m2",
        );
        return vscode.commands.executeCommand("vscode.open", exampleUri);
      },
    ),
  );

  repl.activate(context, getWebviewCompletionItems);
  formatter.activate(context);
  const config = vscode.workspace.getConfiguration("macaulay2");
  if (config.get<boolean>("enableLanguageServer", true) && isLanguageServerAvailable()) {
    context.subscriptions.push(client);
    context.subscriptions.push(
      vscode.commands.registerCommand("macaulay2.restartLanguageServer", () =>
        client.restart()
      )
    );
    client.start().catch((error) => {
      void vscode.window.showErrorMessage(
        `Failed to start Macaulay2 Language Server: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("macaulay2.enableLanguageServer")) {
        void vscode.window
          .showInformationMessage(
            "Reload the window to apply language server changes.",
            "Reload"
          )
          .then((selection) => {
            if (selection === "Reload")
              vscode.commands.executeCommand("workbench.action.reloadWindow");
          });
      }
    })
  );

  return {
    // markdown-it plugin to highlight m2 code in markdown previews
    extendMarkdownIt(md: any) {
      const highlight = md.options.highlight;
      md.options.highlight = (code, lang) => {
        if (lang && ["m2", "macaulay2"].includes(lang.toLowerCase())) {
          return hljs.highlight(code, {
            language: lang,
            ignoreIllegals: true,
          }).value;
        } else {
          return highlight(code, lang);
        }
      };
      return md;
    },
  };
}

// this method is called when your extension is deactivated
export function deactivate(): Thenable<void> | undefined {
  repl.deactivate();
  return client.stop();
}
