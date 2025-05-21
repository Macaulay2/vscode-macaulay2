import { Shell } from './shellEmulator.js';

// @ts-ignore
const vscode = acquireVsCodeApi();

const outputElement = document.getElementById('terminal');

window.addEventListener('message', event => {    
  const message = event.data;
  switch (message.command) {
    case 'output':
      myshell.displayOutput(message.text);
      // next line is a hack: scroll is already performed by shellEmulator,
      // but it doesn't work on <body>, need to do it on its parent element instead
      outputElement.parentElement.scrollTop=outputElement.parentElement.scrollHeight;
      // TODO: put focus back on editor:
      // editor.focus()
      break;
  }
});


const myshell = new Shell(
  outputElement,
  (msg) => vscode.postMessage({ command: 'execute', text: msg }),
  null,
  null,
  true
);

console.log("Shell created.");
