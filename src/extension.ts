// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
'use strict';

import * as vscode from 'vscode';
import * as completions from "./completionProviders";
import * as repl from "./repl";
import client from "./client";

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "macaulay2" is now active!');

	completions.activate(context);
	repl.activate(context);
	client.start();

}

// this method is called when your extension is deactivated
export function deactivate() {}
