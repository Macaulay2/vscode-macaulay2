import { Shell } from './shellEmulator.js';

// @ts-ignore
const vscode = acquireVsCodeApi();

const outputElement = document.getElementById('terminal');

window.addEventListener('message', event => {    
  const message = event.data;
  switch (message.type) {
    case 'output':
      myshell.displayOutput(message.data);
      // next line is a hack: scroll is already performed by shellEmulator,
      // but it doesn't work on <body>, need to do it on its parent element instead
      outputElement.parentElement.scrollTop=outputElement.parentElement.scrollHeight;
      // put focus back on editor:
      vscode.postMessage({ type: 'focus' });
      break;
  }
});


const myshell = new Shell(
  outputElement,
  (msg) => vscode.postMessage({ type: 'execute', data: msg }),
  null,
  null,
  true
);

console.log("Shell created.");
