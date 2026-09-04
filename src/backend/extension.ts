// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
"use strict";

import * as vscode from "vscode";
import * as repl from "./repl";
import * as formatter from "./formatter";
import {
  createCachedCommandResolver,
  probeConfiguredCommand,
} from "./executablePath";
import {
  createLanguageServerController,
  LanguageServerController,
} from "./languageServer";
import hljs from "highlight.js/lib/core";
import hljsM2 from "highlightjs-macaulay2";

hljs.registerLanguage("macaulay2", hljsM2);

const LANGUAGE_SERVER_COMMAND = "M2-language-server";

type CompletionProviderModule = typeof import("./completionProviders");

// Held for deactivate(), which runs outside activate()'s scope.
let languageServer: LanguageServerController | undefined;

function isMacaulay2Document(document: vscode.TextDocument): boolean {
  return document.languageId === "macaulay2";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  const isLanguageServerEnabled = () =>
    vscode.workspace
      .getConfiguration("macaulay2")
      .get<boolean>("enableLanguageServer", true);

  const getConfiguredLanguageServerPath = () =>
    vscode.workspace
      .getConfiguration("macaulay2")
      .get<string>("languageServerPath", "")
      .trim();

  const languageServerResolver = createCachedCommandResolver(
    LANGUAGE_SERVER_COMMAND,
    (command) =>
      probeConfiguredCommand(getConfiguredLanguageServerPath(), command),
  );

  const controller = createLanguageServerController({
    // Imported lazily: this is what keeps vscode-languageclient out of
    // activation for anyone with no language server installed.
    createClient: async (resolution) =>
      (await import("./client")).createLanguageClient(resolution),
    resolver: languageServerResolver,
    isEnabled: isLanguageServerEnabled,
    reportDisabled: () => {
      void vscode.window.showInformationMessage(
        "Macaulay2 Language Server is disabled.",
      );
    },
    reportNotFound: () => {
      void vscode.window.showWarningMessage(
        `${LANGUAGE_SERVER_COMMAND} was not found.`,
      );
    },
    reportStartError: (error) => {
      void vscode.window.showErrorMessage(
        `Failed to start Macaulay2 Language Server: ${describeError(error)}`,
      );
    },
    reportStopError: (error) => {
      void vscode.window.showErrorMessage(
        `Failed to stop Macaulay2 Language Server: ${describeError(error)}`,
      );
    },
  });

  languageServer = controller;

  if (vscode.workspace.textDocuments.some(isMacaulay2Document)) {
    void activateCompletions();
    void controller.start();
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (isMacaulay2Document(document)) {
        void activateCompletions();
        void controller.start();
      }
    }),
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && isMacaulay2Document(editor.document)) {
        void activateCompletions();
        void controller.start();
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
  context.subscriptions.push(controller);
  context.subscriptions.push(
    vscode.commands.registerCommand("macaulay2.restartLanguageServer", () =>
      controller.restart(),
    ),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      const pathChanged = e.affectsConfiguration(
        "macaulay2.languageServerPath",
      );
      const enabledChanged = e.affectsConfiguration(
        "macaulay2.enableLanguageServer",
      );
      if (pathChanged || enabledChanged) {
        // Handle both settings as one final desired state.  This also covers a
        // single settings.json save that changes the path while disabling the
        // server, without letting the path branch skip shutdown.
        void controller.configurationChanged();
      }
    }),
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
  return languageServer?.stop();
}
