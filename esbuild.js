const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const test = process.argv.includes("--test");

const baseConfig = {
  bundle: true,
  sourcemap: !production,
  minify: production,
};

async function build() {
  if (test) {
    const testCtx = await esbuild.context({
      ...baseConfig,
      entryPoints: {
        "client.test": "src/backend/test/client.test.ts",
        "extension.test": "src/backend/test/extension.test.ts",
        "grammar.test": "src/backend/test/grammar.test.ts",
        "outputLayout.test": "src/webview/test/outputLayout.test.ts",
      },
      outdir: "out/test",
      platform: "node",
      format: "cjs",
      target: "node18",
      // vscode-oniguruma loads onig.wasm relative to its own location, so it
      // has to stay in node_modules rather than being bundled.
      external: [
        "vscode",
        "vscode-textmate",
        "vscode-oniguruma",
        // The test server resolves its own JSON-RPC module in a child process.
        "vscode-jsonrpc/package.json",
      ],
    });

    if (watch) {
      await testCtx.watch();
      console.log("Watching tests...");
    } else {
      await testCtx.rebuild();
      await testCtx.dispose();
    }
    return;
  }

  const backendCtx = await esbuild.context({
    ...baseConfig,
    entryPoints: ["src/backend/extension.ts"],
    outfile: "out/extension.js",
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode"],
  });

  const webviewCtx = await esbuild.context({
    ...baseConfig,
    entryPoints: ["src/webview/main.ts"],
    outfile: "media/main.js",
    platform: "browser",
    format: "esm",
  });

  copyKatex();

  if (watch) {
    await backendCtx.watch();
    await webviewCtx.watch();
    console.log("Watching for changes...");
  } else {
    await backendCtx.rebuild();
    await webviewCtx.rebuild();
    await backendCtx.dispose();
    await webviewCtx.dispose();
  }
}

function copyKatex() {
  const katexDist = path.join("node_modules", "katex", "dist");
  const dest = path.join("media", "katex");
  fs.mkdirSync(path.join(dest, "contrib"), { recursive: true });
  fs.cpSync(path.join(katexDist, "fonts"), path.join(dest, "fonts"), { recursive: true });
  fs.copyFileSync(path.join(katexDist, "katex.min.js"), path.join(dest, "katex.min.js"));
  fs.copyFileSync(path.join(katexDist, "katex.min.css"), path.join(dest, "katex.min.css"));
  fs.copyFileSync(
    path.join(katexDist, "contrib", "auto-render.min.js"),
    path.join(dest, "contrib", "auto-render.min.js"),
  );
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
