(function () {
//const vscode = acquireVsCodeApi();
    // const inputElement = document.getElementById('input');
                const outputElement = document.getElementById('output');


    window.addEventListener('message', event => {    
                    const message = event.data;
                    switch (message.command) {
                        case 'output':
                            outputElement.innerHTML += message.text;
    // myshell.displayOutput(message.text);
                            renderMathInElement(outputElement, {
                                delimiters: [
                                    {left: "$", right: "$", display: false},
                                ]
                            });
                            outputElement.scrollTop = outputElement.scrollHeight; // Scroll to the bottom
                            break;
                    }
    });


    console.log("here");
    /*
      myshell = new Shell1(
    outputElement,
    null,
    null,
    null,
    false // no input span
    );
    */
    console.log("HELLO");
})
