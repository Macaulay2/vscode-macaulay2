import { Shell } from "./shellEmulator.js"

//const vscode = acquireVsCodeApi();
// const inputElement = document.getElementById('input');
const outputElement = document.getElementById('output');


window.addEventListener('message', event => {    
    const message = event.data;
    switch (message.command) {
    case 'output':
        //outputElement.innerHTML += message.text;
	myshell.displayOutput(message.text);
        outputElement.scrollTop = outputElement.scrollHeight; // Scroll to the bottom
        break;
    }
});


console.log("here");

  const myshell = new Shell(
  outputElement,
  null,
  null,
  null,
  false // no input span
  );

console.log("HELLO");
