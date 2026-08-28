# Macaulay2 for Visual Studio Code

This extension adds language support for [Macaulay2](https://macaulay2.com/) to Visual Studio Code. It is intended for editing `.m2` files and running Macaulay2 interactively without leaving the editor.

## Requirements
If the extension cannot find Macaulay2, set `macaulay2.executablePath` to the full path of your `M2` executable. On Windows, leaving this empty also checks WSL for `M2`; a WSL path such as `/usr/bin/M2` can be used as the manual path when needed.

## Getting Started

Install Macaulay2 first, then open a `.m2` file in VS Code. The extension will try to find the `M2` executable automatically.

VS Code shows a short **Get Started with Macaulay2** walkthrough after installation, and it remains available from the Getting Started page.

Use `F12` or run **Macaulay2: Start M2 REPL** from the Command Palette to start the webview REPL. Use `Shift+Enter` or `Ctrl+Enter` to send the current selection, or the current line when nothing is selected, to the webview REPL. Use the run button in the editor title area of a `.m2` file to send the whole file to the webview REPL. Sending code to a Macaulay2 terminal session remains available from the Command Palette and right-click editor menu, but has no default keybinding. Both send commands can be rebound in VS Code Keyboard Shortcuts, which can be found by using the settings wheel in the extension menu.

- Optional executable switcher. Set `macaulay2.showExecutableSwitcher` to `true` and add paths to `macaulay2.executablePathAlternatives` to show a status bar button for switching between M2 binaries.
- This extension comes with a Macaulay2 formatter. When in a `.m2` file, press `Shift+Option+F` to autoformat.

## Features

- Syntax highlighting for Macaulay2 source files and fenced Macaulay2 code blocks in Markdown.
- Document formatting for `.m2` files through VS Code's standard **Format Document** command.
- Completion suggestions for Macaulay2 symbols, functions, constants, and keywords.
- Language configuration for comments, brackets, quotes, and surrounding pairs.
- An integrated Macaulay2 REPL in a VS Code webview.
- Terminal-backed evaluation in a standard VS Code terminal through a separate command/keybinding.
- Automatic `M2` executable detection on macOS and Windows, including WSL installs on Windows, with a manual override when needed.
- Language server support via `M2-language-server` for additional editor features when installed, found automatically or pointed at with a setting.

![Syntax highlighting](https://user-images.githubusercontent.com/186528/54696704-990e3480-4b2c-11e9-9376-3106aa64d618.png)


## Commands

| Command | Description |
| --- | --- |
| `Macaulay2: Start M2 REPL` | Start the integrated webview REPL. |
| `Macaulay2: Send Line or Selection to Macaulay2 Webview` | Send the current selection or line directly to the webview REPL. |
| `Macaulay2: Run Macaulay2 File` | Send the active Macaulay2 file to the webview REPL. |
| `Macaulay2: Start M2 Terminal` | Start Macaulay2 in a VS Code terminal. |
| `Macaulay2: Send Line or Selection to Macaulay2 Terminal` | Send the current selection or line directly to the terminal REPL. |
| `Macaulay2: Interrupt M2 Computation` | Interrupt the running Macaulay2 computation. |
| `Macaulay2: Restart Language Server` | Restart the Macaulay2 Language Server. |

## Default Keybindings

| Keybinding | Command |
| --- | --- |
| `Shift+Enter` | Send the current selection or line to the webview REPL. |
| `Ctrl+Enter` | Send the current selection or line to the webview REPL. |
| `Ctrl+C` | Interrupt the running Macaulay2 computation when the webview REPL is active. |

There is no REPL target setting. To send evaluation to the terminal from a keybinding, bind `Macaulay2: Send Line or Selection to Macaulay2 Terminal` in VS Code Keyboard Shortcuts. The interrupt shortcut is also controlled through VS Code Keyboard Shortcuts.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `macaulay2.executablePath` | `""` | Optional path to the `M2` executable. Leave empty to auto-detect. |
| `macaulay2.launchArgs` | `""` | Additional command-line arguments passed to `M2` when starting REPL sessions, for example `--print-width 50`. |
| `macaulay2.webviewColorTheme` | `vscode` | Choose the webview REPL color theme: `classic`, `light`, `dark`, or `vscode`. |
| `macaulay2.webviewTopLevelMode` | `webapp` | Choose the webview REPL top-level output mode: `webapp` or `standard`. |
| `macaulay2.webviewMatrixKatexMaxEntries` | `2500` | Maximum matrix entries the webview REPL renders with KaTeX. Larger matrices use Macaulay2 net output, matching `topLevelMode = Standard`. |
| `macaulay2.enableLanguageServer` | `true` | Enable the Macaulay2 Language Server. Requires `M2-language-server` to be installed; skipped silently if not found. |
| `macaulay2.languageServerPath` | `""` | Absolute path to the `M2-language-server` executable. Leave empty to detect it automatically. On Windows, a Unix path is launched through the default WSL distribution. |

## Regenerating the grammars

The syntax highlighting is generated from a running Macaulay2, so it stays in step with the interpreter rather than being maintained by hand. After installing a new Macaulay2, run:

```sh
npm run update
```

That runs `generate-grammar.m2`, which writes `syntaxes/m2-tokens.json` — the builtin symbols, the operator tables read out of the interpreter with `getParsing`, and the SimpleDoc section keywords — and then `scripts/generate-syntax.js`, which expands the `.in` templates.

Edit the `.in` templates, never the generated `.json` files. CI checks that regenerating is a no-op, so a new operator or SimpleDoc keyword in Macaulay2 shows up as a failing build.

The grammars follow the [Macaulay2 language grammar](https://github.com/Macaulay2/M2/wiki/Macaulay2-language-grammar) and [SimpleDoc language grammar](https://github.com/Macaulay2/M2/wiki/SimpleDoc-language-grammar).

## Acknowledgements 

This package was developed by [John Cobb](https://github.com/johndcobb), [Paul Zinn-Justin](https://github.com/pzinn), and [Mike Stillman](https://github.com/mikestillman). This extension was built from a previous version developed by [Corey Harris](https://github.com/coreysharris). The process of finding M2 executables on WSL was adapted from [Al Ashir Intisar](https://github.com/Al-Ashir-Intisar).
