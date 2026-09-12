import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "out/test/**/*.test.js",
  // Pinned so a VS Code release cannot turn CI red on its own.  Bump it
  // deliberately, and no lower than the "engines.vscode" floor in package.json.
  version: "1.122.1",
});
