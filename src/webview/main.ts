import { Shell } from "./shellEmulator.js";

// @ts-ignore
const vscode = acquireVsCodeApi();

const outputElement = document.getElementById("terminal");

window.addEventListener("message", (event) => {
  const message = event.data;
  switch (message.type) {
    case "output":
      myshell.displayOutput(message.data);
      // next line is a hack: scroll is already performed by shellEmulator,
      // but it doesn't work on <body>, need to do it on its parent element instead
      if (outputElement && outputElement.parentElement) {
        // check  nonempty
        outputElement.parentElement.scrollTop =
          outputElement.parentElement.scrollHeight;
      }
      // put focus back on editor:
      vscode.postMessage({ type: "focus" });
      break;
  }
});

if (!outputElement) {
  throw new Error("Terminal output element not found.");
}

const myshell = new Shell(
  outputElement,
  (type, msg) => vscode.postMessage({ type: type, data: msg }),
  null,
  null,
  true,
);

console.log("Shell created.");
