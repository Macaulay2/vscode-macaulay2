//
// Construction of the Macaulay2 language client.
//
// This module is loaded through a dynamic import, so that the extension does
// not pull vscode-languageclient into activation for the many users who have
// no M2-language-server installed, or who have turned the setting off.
//
// Each client is built from one resolution and never mutated afterwards.  The
// server options are read when the client starts, so mutating them in place
// happens to work, but it leaves the client's configuration and the executable
// it was resolved from able to drift apart.  Building a fresh client when the
// resolution changes keeps them the same thing.
//

import {
  Executable,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";

import { CommandExecutableResolution } from "./executablePath";

const clientOptions: LanguageClientOptions = {
  documentSelector: [
    { scheme: "file", language: "macaulay2" },
    { scheme: "untitled", language: "macaulay2" },
  ],
};

export function createLanguageClient(
  resolution: CommandExecutableResolution,
): LanguageClient {
  const serverOptions: Executable = {
    command: resolution.executablePath,
    args: resolution.args,
  };

  return new LanguageClient(
    "macaulay2-language-server",
    "Macaulay2 Language Server",
    serverOptions as ServerOptions,
    clientOptions,
  );
}
