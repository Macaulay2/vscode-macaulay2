// import { autoRender } from "./autoRender";
const webAppTagCodes = [
    ["Html", 17, "M2Html"], // indicates what follows is HTML
    ["End", 18, "M2End"], // end of HTML (or url) section
    ["Cell", 19, "M2Text M2Cell"], // cell (bundled input + output)
    ["CellEnd", 20, "M2CellEnd"], // end of cell
    ["Input", 28, "M2Text M2Input"], // it's text but it's input
    ["InputContd", 29, "M2Text M2Input M2InputContd"], // text, continuation of input
    ["Url", 30, "M2Url"], // url
    ["Prompt", 14, "M2Text M2Prompt"],
    ["Position", 21, "M2Position"],
];
const webAppTags = {};
const webAppClasses = {};
webAppTagCodes.forEach((x) => {
    webAppTags[x[0]] = String.fromCharCode(x[1]);
    webAppClasses[String.fromCharCode(x[1])] = x[2];
});
const webAppRegex = new RegExp("([" + Object.values(webAppTags).join("") + "])");

//# sourceMappingURL=tags.js.map
const scrollLeft = function (el) {
    el.scrollLeft = 0;
};
const scrollDown = function (el) {
    el.scrollTop = el.scrollHeight;
};
const scrollDownLeft = function (el) {
    scrollLeft(el);
    scrollDown(el);
};
const baselinePosition = function (el) {
    const probe = document.createElement("span");
    probe.appendChild(document.createTextNode("X"));
    probe.style.fontSize = "0";
    probe.style.visibility = "hidden";
    el.parentElement.insertBefore(probe, el);
    const result = probe.getBoundingClientRect().top - el.getBoundingClientRect().top;
    probe.remove();
    return result;
};
// TODO: rewrite getCaret(2) in a similar way as setCaret
// caret (always assuming selection is collapsed)
const getCaretInternal = function (el, node, offset) {
    let cur = el;
    let len = 0;
    while (true) {
        if (cur === node) {
            if (cur.nodeType === 3 || offset === 0)
                // bingo
                return len + offset;
            // more complicated: target node is an element
            node = node.childNodes[offset];
            offset = 0;
        }
        if (cur.nodeType === 3)
            // Text node
            len += cur.textContent.length;
        if (cur.nodeType !== 1 || (cur.nodeType === 1 && !cur.firstChild)) {
            if (cur == el)
                return null;
            // backtrack
            while (!cur.nextSibling) {
                //if (cur.nodeName == "DIV" || cur.nodeName == "BR") len++; // for Firefox
                cur = cur.parentElement;
                if (cur == el)
                    return null;
            }
            //if (cur.nodeName == "DIV" || cur.nodeName == "BR") len++; // for Firefox
            cur = cur.nextSibling;
        }
        else
            cur = cur.firstChild; // forward
    }
};
const getCaret = function (el) {
    const sel = window.getSelection();
    return getCaretInternal(el, sel.focusNode, sel.focusOffset);
};
const getCaret2 = function (el) {
    const sel = window.getSelection();
    return [
        getCaretInternal(el, sel.anchorNode, sel.anchorOffset),
        getCaretInternal(el, sel.focusNode, sel.focusOffset),
    ];
};
const utf8 = new TextEncoder(); // M2 uses utf8, counts locations in bytes :/
const locateRowColumn = function (txt, row, col) {
    // finds the offset of a row/col location in a text element
    // TODO: treat row<1 case (fail or return 0???)
    const matches = [
        { index: -1 },
        ...txt.matchAll(/\n/g),
        { index: txt.length },
    ]; // a bit clumsy TODO don't scan the whole text
    // what to do if beyond column? for now just truncate to length
    if (row < 1 || row >= matches.length)
        return null;
    let offset = matches[row - 1].index + 1;
    while (col > 0 && offset < matches[row].index) {
        col = col - utf8.encode(txt.charAt(offset)).length;
        offset = offset + 1;
    }
    return offset;
};
const locateOffsetInternal = function (el, cur, pos) {
    let tentativeNode = null;
    while (true) {
        if (cur.nodeType === 3) {
            if (pos < cur.textContent.length)
                // bingo
                return [cur, pos];
            pos -= cur.textContent.length;
            if (pos == 0) // annoying edge case
                tentativeNode = cur;
        }
        if (cur.nodeType !== 1 || (cur.nodeType === 1 && !cur.firstChild)) {
            // backtrack
            while (!cur.nextSibling) {
                //if (cur.nodeName == "DIV" || cur.nodeName == "BR") pos--; // for Firefox
                cur = cur.parentElement;
                if (cur == el)
                    return tentativeNode === null ? null : [tentativeNode, tentativeNode.textContent.length];
            }
            //if (cur.nodeName == "DIV" || cur.nodeName == "BR") pos--; // for Firefox
            // then go to next sibling
            cur = cur.nextSibling;
        }
        else
            cur = cur.firstChild; // otherwise forward
    }
};
const locateOffset = function (el, pos) {
    // finds the node/node offset of a given character pos in a text element
    const cur = el.firstChild;
    return cur ? locateOffsetInternal(el, cur, pos) : pos == 0 ? [el, 0] : null; // not sure about the cur === null case
};
const locateOffset2 = function (el, pos1, pos2) {
    // finds the node/node offset of two character pos in a text element
    const cur = el.firstChild;
    if (cur === null)
        return pos1 == 0 && pos2 == 0 ? [el, 0, el, 0] : null; // not sure about the cur === null case
    const node1 = locateOffsetInternal(el, cur, pos1);
    if (node1 === null)
        return null;
    const node2 = locateOffsetInternal(el, node1[0], pos2 - pos1 + node1[1]);
    if (node2 === null)
        return null;
    return [node1[0], node1[1], node2[0], node2[1]]; // TODO use objects
};
// some of these edge cases need to be clarified (empty HTMLElements; etc)
const setCaret = function (el, pos1, pos2, mark) {
    if (!pos2)
        pos2 = pos1;
    else if (pos2 < pos1) {
        const pos = pos1;
        pos1 = pos2;
        pos2 = pos;
    }
    el.focus({ preventScroll: true });
    const nodeOffsets = locateOffset2(el, pos1, pos2);
    const sel = window.getSelection();
    if (!nodeOffsets) {
        if (mark)
            return el.appendChild(addMarker());
    }
    else {
        sel.setBaseAndExtent(nodeOffsets[0], nodeOffsets[1], nodeOffsets[2], nodeOffsets[3]);
        if (mark)
            return addMarkerPos(nodeOffsets[2], nodeOffsets[3]);
    }
};
const forwardCaret = function (el, incr) {
    const sel = window.getSelection();
    const node = locateOffsetInternal(el, sel.focusNode, sel.focusOffset + incr);
    if (node !== null)
        window.getSelection().setBaseAndExtent(node[0], node[1], node[0], node[1]);
};
const nextChar = function () {
    const sel = window.getSelection();
    let cur = sel.focusNode;
    let pos = sel.focusOffset;
    while (pos >= cur.textContent.length) {
        pos -= cur.textContent.length;
        while (!cur.nextSibling) {
            if (cur.nodeName == "DIV" || cur.nodeName == "BR") {
                // for Firefox
                if (pos == 0)
                    return "\n";
                pos--;
            }
            cur = cur.parentElement;
            if (cur == null)
                return "";
        }
        if (cur.nodeName == "DIV" || cur.nodeName == "BR") {
            // for Firefox
            if (pos == 0)
                return "\n";
            pos--;
        }
        cur = cur.nextSibling;
    }
    return cur.textContent[pos];
};
const setCaretAtEndMaybe = function (el, flag) {
    // flag means only do it if not already in el
    if (!flag || document.activeElement != el) {
        // not quite right... should test containance
        setCaret(el, el.textContent.length);
        el.scrollIntoView({ inline: "end", block: "nearest" });
    }
};
const attachElement = function (el, container) {
    // move an HTML element (with single text node) while preserving focus/caret
    const caret = getCaret(el);
    container.appendChild(el);
    if (caret !== null)
        // note that it could be zero
        setCaret(el, caret);
};
// not used any more
const stripElement = function (el) {
    const caret = getCaret(el);
    el.textContent = el.textContent; // !
    if (caret !== null)
        // note that it could be zero
        setCaret(el, caret);
};
// bit of a trick
const caretIsAtEnd = function () {
    const sel = window.getSelection();
    if (!sel.isCollapsed)
        return false;
    const offset = sel.focusOffset;
    const node = sel.focusNode;
    sel.modify("move", "forward", "character");
    if (offset == sel.focusOffset && node == sel.focusNode)
        return true;
    else {
        sel.modify("move", "backward", "character");
        return false;
    }
};
const selectRowColumn = function (el, rowcols) {
    let pos1 = locateRowColumn(el.textContent, rowcols[0], rowcols[1]);
    if (pos1 === null)
        pos1 = el.textContent.length;
    let pos2 = locateRowColumn(el.textContent, rowcols[2], rowcols[3]);
    if (pos2 === null)
        pos2 = el.textContent.length;
    const nodesOffsets = locateOffset2(el, pos1, pos2);
    if (!nodesOffsets)
        return false; // shouldn't happen
    const sel = window.getSelection();
    sel.setBaseAndExtent(nodesOffsets[0], nodesOffsets[1], nodesOffsets[2], nodesOffsets[3]);
    const marker = addMarkerPos(nodesOffsets[2], nodesOffsets[3]);
    if (pos1 == pos2)
        marker.classList.add("caret-marker");
    setTimeout(function () {
        // in case not in editor tab, need to wait
        marker.scrollIntoView({
            behavior: "smooth",
            block: "center",
            inline: "end",
        });
    }, 0);
    return true;
};
const addMarker = function (perma) {
    // perma means don't remove it after 1.5s
    // markers are used for scrolling or highlighting
    const marker = document.createElement("span");
    marker.classList.add("marker");
    if (!perma)
        setTimeout(function () {
            marker.remove();
        }, 1500);
    return marker;
};
const addMarkerPos = function (node, offset, perma) {
    const marker = addMarker(perma);
    if (node.nodeType === 3)
        // should always be the case but there are edge cases
        node.parentElement.insertBefore(marker, node.splitText(offset));
    // !!
    else
        node.appendChild(marker); // fall-back behavior (?)
    return marker;
};
const addMarkerEl = function (el, pos, perma) {
    const nodeOffset = locateOffset(el, pos);
    return nodeOffset
        ? addMarkerPos(nodeOffset[0], nodeOffset[1], perma)
        : addMarker(perma);
};
const stripId = function (el) {
    // remove "id" from *children* of el. useful for cloned elements
    Array.from(el.querySelectorAll("[id]")).forEach((x) => x.removeAttribute("id"));
};
const language = function (e) {
    // tries to determine language of code. not great...
    for (let i = 0; i < 3; i++)
        if (e != null) {
            if (e.dataset.language)
                return e.dataset.language;
            e = e.parentElement;
        }
    return "Macaulay2"; // by default we assume code is M2
};

Array.prototype.sortedPush = function (el) {
    let m = 0;
    let n = this.length - 1;
    while (m <= n) {
        const k = (n + m) >> 1;
        if (el > this[k])
            m = k + 1;
        else if (el < this[k])
            n = k - 1;
        else {
            m = -1;
            n = -2;
        }
    }
    if (m >= 0)
        this.splice(m, 0, el);
    return this.length;
};
const processCell = function (a, b) {
}; // TODO remember what this is
const Shell = function (terminal, emitInput, editor, iFrame, createInputSpan) {
    // Shell is an old-style javascript oop constructor
    // we're using arguments as private variables, cf
    // https://stackoverflow.com/questions/18099129/javascript-using-arguments-for-closure-bad-or-good
    const obj = this; // for nested functions with their own 'this'. or one could use bind, or => functions, but simpler this way
    let htmlSec; // the current place in terminal where new stuff gets written
    let inputSpan = null; // the input HTML element at the bottom of the terminal. note that inputSpan should always have *one text node*
    const cmdHistory = []; // History of commands for terminal-like arrow navigation
    cmdHistory.index = 0;
    cmdHistory.sorted = []; // a sorted version
    // input is a bit messy...
    let inputEndFlag = false;
    let procInputSpan = null; // temporary span containing currently processed input (for aesthetics only)
    let interpreterDepth = 1;
    const isEmptyCell = function (el) {
        // tests if a cell is empty
        if (!el.classList.contains("M2Cell"))
            return false;
        const c = el.childNodes;
        for (let i = 0; i < c.length; i++)
            if (c[i].nodeType != 1 || !c[i].classList.contains("M2CellBar"))
                return false;
        return true;
    };
    const createHtml = function (className) {
        const cell = className.indexOf("M2Cell") >= 0; // a bit special
        const anc = htmlSec;
        htmlSec = document.createElement(cell ? "div" : "span");
        htmlSec.className = className;
        if (cell) {
            if (!isEmptyCell(anc)) {
                // avoid 2 separators in a row
                // insert separator above
                const ss = document.createElement("span");
                ss.className = "M2CellBar M2Separator";
                ss.tabIndex = 0;
                htmlSec.appendChild(ss);
            }
            // insert bar at left -- NB: left bar must be after separator for css to work
            const s = document.createElement("span");
            s.className = "M2CellBar M2Left";
            s.tabIndex = 0;
            htmlSec.appendChild(s);
        }
        if (className.indexOf("M2Text") < 0)
            htmlSec.dataset.code = "";
        // even M2Html needs to keep track of innerHTML because html tags may get broken
        if (inputSpan && inputSpan.parentElement == anc)
            anc.insertBefore(htmlSec, inputSpan);
        else
            anc.appendChild(htmlSec);
    };
    const createInputEl = function () {
        // (re)create the input area
        if (inputSpan)
            inputSpan.remove(); // parentElement.removeChild(inputSpan);
        inputSpan = document.createElement("span");
        //inputSpan = document.createElement("input"); // interesting idea but creates tons of problems
        inputSpan.contentEditable = true; // inputSpan.setAttribute("contentEditable",true);
        inputSpan.spellcheck = false; // sadly this or any of the following attributes are not recognized in contenteditable :(
        inputSpan.autocapitalize = "off";
        inputSpan.autocorrect = "off";
        inputSpan.autocomplete = "off";
        inputSpan.classList.add("M2Input");
        inputSpan.classList.add("M2CurrentInput");
        inputSpan.classList.add("M2Text");
        htmlSec = terminal;
        //    if (editor) htmlSec.appendChild(document.createElement("br")); // a bit of extra space doesn't hurt
        createHtml(webAppClasses[webAppTags.Cell]); // we create a first cell for the whole session
        createHtml(webAppClasses[webAppTags.Cell]); // and one for the starting text (Macaulay2 version... or whatever comes out of M2 first)
        htmlSec.appendChild(inputSpan);
        inputSpan.focus();
        inputEndFlag = false;
    };
    if (createInputSpan)
        createInputEl();
    else
        htmlSec = terminal;
    const codeStack = []; // stack of past code run
    const returnSymbol = "\u21B5";
    const focusElement = function () {
        const foc = window.getSelection().focusNode;
        return foc && foc.nodeType == 3 ? foc.parentElement : foc;
    };
    terminal.onpaste = function (e) {
        if (!inputSpan)
            return;
        setCaretAtEndMaybe(inputSpan, true);
        e.preventDefault();
        const txt = e.clipboardData.getData("text/plain").replace(/\t/g, "    "); // chrome doesn't like \t
        // paste w/o formatting
        document.execCommand("insertText", false, txt);
        scrollDown(terminal);
    };
    terminal.onclick = function (e) {
        if (!inputSpan || !window.getSelection().isCollapsed)
            return;
        let t = e.target;
        while (t != terminal) {
            if (t.classList.contains("M2CellBar") ||
                t.tagName == "A" ||
                t.tagName == "INPUT" ||
                t.tagName == "BUTTON" ||
                t.classList.contains("M2PastInput"))
                return;
            t = t.parentElement;
        }
        if (document.activeElement != inputSpan) {
            inputSpan.focus({ preventScroll: true });
            setCaret(inputSpan, inputSpan.textContent.length);
        }
    };
    /*
    terminal.onbeforeinput = function (e) {
      //    console.log("inputSpan beforeinput: " + e.inputType);
      if (!e.inputType) e.preventDefault(); // prevent messed up pasting of editor into input span during syntax hilite (TEMP?)
    };
    inputSpan.oninput = function (e) { // pointless to attach events to inputSpan
      if (
        inputSpan.parentElement == htmlSec &&
        htmlSec.classList.contains("M2Input")
      )
        delayedHighlight(htmlSec);
        // multiple problems:
        // the test should be when hiliting, not delayed!!!!
        // more importantly, Prism breaks existing HTML and that's fatal for inputSpan
    };
    */
    const subList = [];
    const recurseReplace = function (container, str, el) {
        for (let i = 0; i < container.childNodes.length; i++) {
            const sub = container.childNodes[i];
            if (sub.nodeType === 3) {
                const pos = sub.textContent.indexOf(str);
                if (pos >= 0) {
                    const rest = sub.textContent.substring(pos + str.length);
                    const next = sub.nextSibling; // really, #i+1 except if last
                    if (pos > 0) {
                        sub.textContent = sub.textContent.substring(0, pos);
                        container.insertBefore(el, next);
                    }
                    else
                        container.replaceChild(el, sub);
                    if (rest.length > 0)
                        container.insertBefore(document.createTextNode(rest), next);
                    return true;
                }
            }
            else if (sub.nodeType === 1) {
                if (recurseReplace(sub, str, el))
                    return true;
            }
        }
        return false;
    };
    const isTrueInput = function () {
        // test if input is from user or from e.g. examples
        if (!createInputSpan)
            return false;
        let el = htmlSec;
        while (el && el != terminal && !el.classList.contains("M2Html"))
            el = el.parentElement; // TODO better
        return el == terminal;
    };
    const sessionCell = function (el) {
        while (el && el.parentElement != terminal) {
            el = el.parentElement;
        }
        return el;
    };
    const closeHtml = function () {
        let anc = htmlSec.parentElement;
        if (htmlSec.classList.contains("M2Input"))
            anc.appendChild(document.createElement("br")); // this first for spacing purposes
        if (htmlSec.contains(inputSpan))
            attachElement(inputSpan, anc);
        // move back input element to outside htmlSec
        if (isEmptyCell(htmlSec)) {
            // reject empty cells
            htmlSec.remove();
            htmlSec = anc;
            return;
        }
        if (htmlSec.classList.contains("M2Prompt") && isTrueInput()) {
            const txt = htmlSec.textContent;
            const newInterpreterDepth = /^i*/.exec(txt)[0].length;
            if (newInterpreterDepth > 0) {
                while (interpreterDepth != newInterpreterDepth) {
                    const saveHtmlSec = htmlSec;
                    const saveAnc = anc;
                    htmlSec = anc.parentElement;
                    if (interpreterDepth > newInterpreterDepth) {
                        interpreterDepth--;
                        closeHtml();
                    }
                    else {
                        interpreterDepth++;
                        createHtml(webAppClasses[webAppTags.Cell]);
                    }
                    htmlSec.appendChild(saveAnc);
                    htmlSec = saveHtmlSec;
                    anc = saveAnc;
                }
            }
        }
        else if (htmlSec.classList.contains("M2Position") && isTrueInput()) {
            if (!htmlSec.parentElement.dataset.positions)
                htmlSec.parentElement.dataset.positions = " ";
            htmlSec.parentElement.dataset.positions += htmlSec.dataset.code + " ";
        }
        else if (htmlSec.classList.contains("M2Input")) {
            if (isTrueInput()) {
                // add input to history
                let txt = htmlSec.textContent;
                if (txt[txt.length - 1] == "\n")
                    txt = txt.substring(0, txt.length - 1); // should be true
                if (htmlSec.classList.contains("M2InputContd"))
                    // rare case where input is broken -- e.g.  I=ideal 0; x=(\n   1)
                    cmdHistory[cmdHistory.length - 1] += "\n" + txt;
                else
                    cmdHistory.index = cmdHistory.push(txt);
                txt.split("\n").forEach((line) => {
                    line = line.trim();
                    if (line.length > 0)
                        cmdHistory.sorted.sortedPush(line);
                });
            }
            // highlight
            /*
            htmlSec.innerHTML = Prism.highlight(
              htmlSec.textContent,
              Prism.languages.macaulay2
            );
             */
            htmlSec.classList.add("M2PastInput");
        }
        else if (htmlSec.classList.contains("M2Url")) {
            let url = htmlSec.dataset.code.trim();
            console.log("Opening URL " + url);
            if (!iFrame ||
                (window.location.protocol == "https:" && url.startsWith("http://")) // no insecure in frame
            )
                window.open(url, "M2 browse");
            else if (url.startsWith("#"))
                document.location.hash = url;
            else {
                const url1 = new URL(url, "file://");
                url = url1.toString();
                if (url.startsWith("file://"))
                    url = url.slice(7);
                iFrame.src = url;
            }
        }
        else if (htmlSec.classList.contains("M2Html")) {
            // first things first: make sure we don't mess with input (interrupts, tasks, etc, can display unexpectedly)
            if (anc.classList.contains("M2Input")) {
                anc.parentElement.insertBefore(htmlSec, anc);
            }
            htmlSec.insertAdjacentHTML("beforeend", htmlSec.dataset.code);
            // KaTeX rendering
	    renderMathInElement(htmlSec, {
		strict: false,
		trust: true,
            delimiters: [
                {left: "$", right: "$", display: false},
            ]
        });
            // autoRender(htmlSec);
            // syntax highlighting code
            /*
            Array.from(
              htmlSec.querySelectorAll(
                "code.language-macaulay2"
              ) as NodeListOf<HTMLElement>
            ).forEach(
              (x) =>
                (x.innerHTML = Prism.highlight(
                  x.innerText,
                  Prism.languages.macaulay2
                ))
            );
             */
            // error highlighting
            Array.from(htmlSec.querySelectorAll(".M2ErrorLocation a[href*=editor]")).forEach((x) => {
                const m = x.getAttribute("href").match(
                // .href would give the expanded url, not the original one
                /^#editor:([^:]+):(\d+):(\d+)/ // cf similar pattern in extra.ts
                );
                if (m) {
                    // highlight error
                    if (m[1] == "stdio") {
                        const nodeOffset = obj.locateStdio(sessionCell(htmlSec), +m[2], +m[3]);
                        if (nodeOffset) {
                            addMarkerPos(nodeOffset[0], nodeOffset[1]).classList.add("error-marker");
                        }
                    }
                    else if (editor) {
                        // check if by any chance file is open in editor
                        const fileNameEl = document.getElementById("editorFileName");
                        if (fileNameEl.value == m[1]) {
                            // should this keep track of path somehow? needs more testing
                            const pos = locateRowColumn(editor.textContent, +m[2], +m[3]);
                            if (pos !== null) {
                                const nodeOffset = locateOffset(editor, pos);
                                if (nodeOffset) {
                                    const marker = addMarkerPos(nodeOffset[0], nodeOffset[1]);
                                    marker.classList.add("error-marker");
                                    setTimeout(function () {
                                        marker.scrollIntoView({
                                            behavior: "smooth",
                                            block: "center",
                                            inline: "end",
                                        });
                                    }, 100); // seems 0 doesn't always trigger
                                }
                            }
                        }
                    }
                }
            });
            // putting pieces back together
            if (htmlSec.dataset.idList) {
                htmlSec.dataset.idList.split(" ").forEach(function (id) {
                    const el = document.getElementById("sub" + id);
                    if (el) {
                        if (el.style.color == "transparent")
                            subList[+id][1].remove();
                        // e.g. inside \vphantom{}
                        else {
                            el.style.display = "contents"; // could put in css but don't want to overreach
                            el.style.fontSize = "0.826446280991736em"; // to compensate for katex's 1.21 factor
                            el.innerHTML = "";
                            el.appendChild(subList[+id][1]);
                        }
                    }
                    else {
                        // more complicated
                        if (!recurseReplace(htmlSec, subList[+id][0], subList[+id][1]))
                            console.log("Error restoring html element");
                    }
                });
                htmlSec.removeAttribute("data-id-list");
            }
        }
        htmlSec.removeAttribute("data-code");
        if (anc.classList.contains("M2Html") && anc.dataset.code != "") {
            // stack
            // in case it's inside TeX, we compute dimensions
            // 18mu= 1em * mathfont size modifier, here 1.21 factor of KaTeX
            const fontSize = +window
                .getComputedStyle(htmlSec, null)
                .getPropertyValue("font-size")
                .split("px", 1)[0] * 1.21;
            const baseline = baselinePosition(htmlSec);
            const str = "\\htmlId{sub" +
                subList.length +
                "}{\\vphantom{" + // the vphantom ensures proper horizontal space
                "\\raisebox{" +
                baseline / fontSize +
                "ce}{}" +
                "\\raisebox{" +
                (baseline - htmlSec.offsetHeight) / fontSize +
                "ce}{}" +
                "}\\hspace{" +
                htmlSec.offsetWidth / fontSize +
                "ce}" + // the hspace is really just for debugging
                "}";
            anc.dataset.code += str;
            if (!anc.dataset.idList)
                anc.dataset.idList = subList.length;
            else
                anc.dataset.idList += " " + subList.length;
            subList.push([str, htmlSec]);
        }
        htmlSec = anc;
    };
    obj.displayOutput = function (msg) {
        if (procInputSpan !== null) {
            procInputSpan.remove();
            procInputSpan = null;
        }
        const txt = msg.replace(/\r/g, "").split(webAppRegex);
        for (let i = 0; i < txt.length; i += 2) {
            //console.log(i+"-"+(i+1)+"/"+txt.length+": ",i==0?"":webAppClasses[txt[i-1]]," : ",txt[i].replace("\n",returnSymbol));
            // if we are at the end of an input section
            if (inputEndFlag &&
                ((i == 0 && txt[i].length > 0) ||
                    (i > 0 && txt[i - 1] !== webAppTags.InputContd))) {
                closeHtml();
                inputEndFlag = false;
            }
            if (i > 0) {
                const tag = txt[i - 1];
                if (tag == webAppTags.End || tag == webAppTags.CellEnd) {
                    if (htmlSec != terminal || !createInputSpan) {
                        // htmlSec == terminal should only happen at very start
                        // or at the very end for rendering help -- then it's OK
                        while (htmlSec.classList.contains("M2Input"))
                            closeHtml(); // M2Input is *NOT* closed by end tag but rather by \n
                        // but in rare circumstances (ctrl-C interrupt) it may be missing its \n
                        const oldHtmlSec = htmlSec;
                        closeHtml();
                        if (tag == webAppTags.CellEnd &&
                            isTrueInput() &&
                            codeStack.length > 0) {
                            processCellBlock: {
                                let i = 0;
                                for (const el of oldHtmlSec.children)
                                    if (el.classList.contains("M2PastInput")) {
                                        while ((i = codeStack[0].dataset.m2code.indexOf(el.textContent.trimRight(), i)) < 0) {
                                            codeStack.shift();
                                            if (codeStack.length == 0)
                                                break processCellBlock;
                                            i = 0;
                                        }
                                        i += el.textContent.trimRight().length;
                                    }
                                if (!MINIMAL)
                                    processCell(oldHtmlSec, codeStack[0]); // or whole thing should be skipped in minimal mode?
                                if (i >= codeStack[0].dataset.m2code.length)
                                    codeStack.shift();
                            }
                        }
                    }
                }
                else if (tag === webAppTags.InputContd && inputEndFlag) {
                    // continuation of input section
                    inputEndFlag = false;
                }
                else {
                    // new section
                    createHtml(webAppClasses[tag]);
                    if (inputSpan &&
                        (tag === webAppTags.Input || tag === webAppTags.InputContd)) {
                        // input section: a bit special (ends at first \n)
                        attachElement(inputSpan, htmlSec); // !!! we move the input inside the current span to get proper indentation !!!
                    }
                }
            }
            if (txt[i].length > 0) {
                // for next round, check if we're nearing the end of an input section
                if (htmlSec.classList.contains("M2Input")) {
                    const ii = txt[i].indexOf("\n");
                    if (ii >= 0) {
                        if (ii < txt[i].length - 1) {
                            // need to do some surgery
                            displayText(txt[i].substring(0, ii + 1));
                            closeHtml();
                            txt[i] = txt[i].substring(ii + 1, txt[i].length);
                        }
                        else
                            inputEndFlag = true;
                        // can't tell for sure if it's the end of input or not (could be a InputContd), so set a flag to remind us
                    }
                }
                if (htmlSec.dataset.code !== undefined)
                    htmlSec.dataset.code += txt[i];
                else
                    displayText(txt[i]);
                //          if (l.contains("M2Html")) htmlSec.innerHTML = htmlSec.dataset.code; // used to update in real time
                // all other states are raw text -- don't rewrite htmlSec.textContent+=txt[i] in case of input
            }
        }
        scrollDownLeft(terminal);
    };
    const displayText = function (msg) {
        const node = document.createTextNode(msg);
        if (inputSpan && inputSpan.parentElement == htmlSec)
            htmlSec.insertBefore(node, inputSpan);
        else
            htmlSec.appendChild(node);
    };
    obj.locateStdio = function (cel, row, column) {
        // find relevant input from stdio:row:column
        const query = '.M2PastInput[data-positions*=" ' + row + ':"]';
        const pastInputs = Array.from(cel.querySelectorAll(query));
        if (pastInputs.length == 0)
            return null;
        const m = pastInputs.map((p) => p.dataset.positions.match(/ (\d+):(\d+) /));
        let i = 0;
        while (i + 1 < pastInputs.length &&
            (+m[i + 1][1] < row || (+m[i + 1][1] == row && +m[i + 1][2] <= column)))
            i++;
        const m1 = m[i];
        const txt = pastInputs[i].textContent;
        const offset = locateRowColumn(txt, row - +m1[1] + 1, row == +m1[1] ? column - +m1[2] : column);
        if (offset === null)
            return null;
        const nodeOffset = locateOffset(pastInputs[i], offset);
        if (nodeOffset)
            // should always be true
            return [nodeOffset[0], nodeOffset[1], pastInputs[i], offset]; // node, offset in node, element, offset in element
    };
    obj.selectPastInput = function (el, rowcols) {
        const cel = sessionCell(el);
        if (!cel)
            return;
        const nodeOffset1 = obj.locateStdio(cel, rowcols[0], rowcols[1]);
        if (!nodeOffset1)
            return;
        const nodeOffset2 = obj.locateStdio(cel, rowcols[2], rowcols[3]);
        if (!nodeOffset2 || nodeOffset2[2] != nodeOffset1[2])
            return;
        const sel = window.getSelection();
        sel.setBaseAndExtent(nodeOffset1[0], nodeOffset1[1], nodeOffset2[0], nodeOffset2[1]);
        const marker = addMarkerPos(nodeOffset2[0], nodeOffset2[1]);
        if (rowcols[0] == rowcols[2] && rowcols[1] == rowcols[3])
            marker.classList.add("caret-marker");
        setTimeout(function () {
            marker.scrollIntoView({
                behavior: "smooth",
                block: "center",
                inline: "end",
            });
        }, 100);
    };
    if (inputSpan)
        window.addEventListener("load", function () {
            inputSpan.focus();
        });
};
export { Shell };
//# sourceMappingURL=shellEmulator.js.map
