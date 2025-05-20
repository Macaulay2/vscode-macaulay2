import { Shell } from "./shellEmulator.js"

//const vscode = acquireVsCodeApi();
const outputElement = document.getElementById('terminal');


window.addEventListener('message', event => {    
    const message = event.data;
    switch (message.command) {
    case 'output':
	myshell.displayOutput(message.text);
        break;
    }
});


  const myshell = new Shell(
  outputElement,
  null,
  null,
  null,
  true // no input span
  );

console.log("Shell created");
