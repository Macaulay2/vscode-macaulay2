declare const MINIMAL;
// import { autoRender } from "./autoRender";
import { webAppTags, webAppClasses, webAppRegex } from "./tags.js";
import {
  shouldAppendProtocolNewlineToPreviousOutput,
  shouldPromoteWebappOutputToBlock,
  splitTrailingProtocolNewline,
} from "./outputLayout.js";
import {
  scrollDownLeft,
  scrollDown,
  scrollLeft,
  baselinePosition,
  getCaret,
  setCaret,
  setCaretAtEndMaybe,
  attachElement,
  locateRowColumn,
  locateOffset,
  addMarkerPos,
  language,
  parseLocation,
} from "./htmlTools.js";

// import Prism from "prismjs"; // TODO reinstate

/*
function dehtml(s) {
  // these are all the substitutions performed by M2
  //  s = s.replace(/&bsol;/g, "\\");
  //s = s.replace(/&dollar;/g,"$");
  s = s.replace(/&lt;/g, "<");
  s = s.replace(/&gt;/g, ">");
  s = s.replace(/&quot;/g, '"');
  s = s.replace(/&amp;/g, "&"); // do this one last
  return s;
}
*/

declare global {
  interface Array<T> {
    sortedPush(el: any): number;
  }
}
Array.prototype.sortedPush = function (el: any) {
  let m = 0;
  let n = this.length - 1;

  while (m <= n) {
    const k = (n + m) >> 1;
    if (el > this[k]) m = k + 1;
    else if (el < this[k]) n = k - 1;
    else {
      m = -1;
      n = -2;
    }
  }
  if (m >= 0) this.splice(m, 0, el);

  return this.length;
};

type CompletionItem = {
  label: string;
  kind: string;
};

type SyntaxToken = {
  label: string;
  className: string;
  priority: number;
};

type SyntaxPattern = {
  source: string;
  className: string;
};

type SyntaxConfig = {
  tokens?: SyntaxToken[];
  patterns?: SyntaxPattern[];
};

const Shell = function (
  terminal: HTMLElement,
  emit: (type: string, msg?: string) => void, // should be renamed
  editor: HTMLElement,
  iFrame: HTMLFrameElement,
  createInputSpan: boolean,
  completionItems: CompletionItem[] = [],
  syntax: SyntaxConfig = {},
  focusInputOnLoad = true,
  initialOutputMode: "webapp" | "standard" = "webapp",
) {
  // Shell is an old-style javascript oop constructor
  // we're using arguments as private variables, cf
  // https://stackoverflow.com/questions/18099129/javascript-using-arguments-for-closure-bad-or-good
  const obj = this; // for nested functions with their own 'this'. or one could use bind, or => functions, but simpler this way
  obj.openedHelp = false;
  let htmlSec; // the current place in terminal where new stuff gets written
  let inputSpan = null; // the input HTML element at the bottom of the terminal. note that inputSpan should always have *one text node*
  const cmdHistory: any = []; // History of commands for terminal-like arrow navigation
  cmdHistory.index = 0;
  cmdHistory.sorted = []; // a sorted version
  // input is a bit messy...
  let outputMode: "webapp" | "standard" = initialOutputMode;
  let inputEndFlag = false;
  let procInputSpan = null; // temporary span containing currently processed input (for aesthetics only)
  let pendingStandardEcho = "";
  let pendingErrorOutput = "";
  let pendingStandardViewHelpOutput = "";
  let interpreterDepth = 1;
  let inputPromptIndentColumns = 0;
  const standardPromptClass = "M2StandardPrompt";
  const standardSubmittedInputClass = "M2StandardSubmittedInput";
  const standardCellClass = "M2StandardCell";
  const continuationIndentClass = "M2ContinuationIndent";

  const isEmptyCell = function (el) {
    // tests if a cell is empty
    if (!el.classList.contains("M2Cell")) return false;
    const c = el.childNodes;
    for (let i = 0; i < c.length; i++)
      if (c[i].nodeType != 1 || !c[i].classList.contains("M2CellBar"))
        return false;
    return true;
  };

  const openHelp = function (url: string) {
    obj.openedHelp = true;
    emit("openHelp", url);
  };

  const normalizeOpeningHref = function (href: string) {
    href = href.trim();
    const quotedHref = href.match(/^["'](.+?)["'][.,;:!?]*$/);
    if (quotedHref) return quotedHref[1];
    return href.replace(/[.,;:!?]+$/, "");
  };

  const isHtmlHelpLink = function (href: string) {
    const path = href.split("#", 1)[0].split("?", 1)[0];
    return (
      /^file:\/\/.+\.html?$/i.test(path) ||
      /^[a-zA-Z]:[\\/].+\.html?$/i.test(path) ||
      (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) && /\.html?$/i.test(path))
    );
  };

  const openStandardViewHelpLinks = function (txt: string) {
    if (outputMode !== "standard") {
      pendingStandardViewHelpOutput = "";
      return;
    }

    const searchText = pendingStandardViewHelpOutput + txt;
    const re = /(?:^|\n)o\d+\s*=\s*Opening\s+(\S+)/g;
    let match: RegExpExecArray | null;
    let consumedIndex = 0;

    while ((match = re.exec(searchText)) !== null) {
      const href = normalizeOpeningHref(match[1]);
      if (isHtmlHelpLink(href)) {
        openHelp(href);
        consumedIndex = re.lastIndex;
      }
    }

    const lastLineIndex = searchText.lastIndexOf("\n") + 1;
    pendingStandardViewHelpOutput = searchText
      .substring(Math.max(consumedIndex, lastLineIndex))
      .slice(-4096);
  };

  const getM2FileLocationLinks = function (txt: string) {
    const re =
      /((?:[A-Za-z]:[\\/])?[^\s:"'<>]+\.m2):(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?/g;
    const links: {
      index: number;
      text: string;
      target: string;
    }[] = [];
    let match: RegExpExecArray | null;

    while ((match = re.exec(txt)) !== null) {
      const [, filePath, lineNum, colNum, endLineNum, endColNum] = match;
      let target = filePath + "#" + lineNum;
      if (colNum !== undefined) target += ":" + colNum;
      if (endLineNum !== undefined) {
        target += "-" + endLineNum;
        if (endColNum !== undefined) target += ":" + endColNum;
      }
      links.push({
        index: match.index,
        text: match[0],
        target,
      });
    }

    return links;
  };
  // Bound cross-chunk rescans while still catching normal split file locations.
  const m2FileLocationChunkTailLength = 4096;
  const shouldSkipM2FileLocationTextNode = function (node: Node) {
    const parent = node.parentElement;
    if (!parent) return true;
    if (parent.closest("a")) return true;
    return !!parent.closest("script, style, textarea, .M2Input");
  };
  const linkifyM2FileLocationTextNode = function (node: Text) {
    const text = node.nodeValue || "";
    const links = getM2FileLocationLinks(text);
    if (links.length === 0) return;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;

    for (const linkInfo of links) {
      if (linkInfo.index > lastIndex) {
        fragment.appendChild(
          document.createTextNode(text.substring(lastIndex, linkInfo.index)),
        );
      }

      const link = document.createElement("a");
      link.textContent = linkInfo.text;
      link.href = "#";
      link.title = "Open source";
      link.style.textDecoration = "underline";
      link.style.cursor = "pointer";
      link.dataset.macaulay2SourceLocation = "true";
      link.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        emit("open", linkInfo.target);
      };
      fragment.appendChild(link);
      lastIndex = linkInfo.index + linkInfo.text.length;
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
    }

    node.replaceWith(fragment);
  };
  const linkifyM2FileLocationTextNodeWithPreviousTail = function (node: Text) {
    if (shouldSkipM2FileLocationTextNode(node)) return;

    const previous = node.previousSibling;
    if (
      previous instanceof Text &&
      !shouldSkipM2FileLocationTextNode(previous)
    ) {
      const previousText = previous.nodeValue || "";
      const nodeText = node.nodeValue || "";
      if (previousText.length > m2FileLocationChunkTailLength) {
        const splitIndex = previousText.length - m2FileLocationChunkTailLength;
        previous.nodeValue = previousText.substring(0, splitIndex);
        node.nodeValue = previousText.substring(splitIndex) + nodeText;
      } else {
        previous.nodeValue = previousText + nodeText;
        node.remove();
        node = previous;
      }
    }

    linkifyM2FileLocationTextNode(node);
  };
  const linkifyM2FileLocations = function (container: Node) {
    container.normalize();
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return shouldSkipM2FileLocationTextNode(node)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    const textNodes: Text[] = [];
    let node = walker.nextNode();
    while (node) {
      textNodes.push(node as Text);
      node = walker.nextNode();
    }
    textNodes.forEach(linkifyM2FileLocationTextNode);
  };

  const outputScrollClass = "M2OutputScroll";
  const outputScrollScrollableClass = "M2OutputScrollScrollable";
  const standardOutputClass = "M2StandardOutput";
  const outputSeparatorClass = "M2OutputSeparator";

  const updateOutputScrollState = function (output: Element) {
    if (!(output instanceof HTMLElement)) return;

    output.classList.toggle(
      outputScrollScrollableClass,
      output.scrollWidth > output.clientWidth + 1,
    );
  };

  const queueOutputScrollStateUpdate = function (output: HTMLElement) {
    updateOutputScrollState(output);
    window.requestAnimationFrame(() => updateOutputScrollState(output));
  };

  const updateAllOutputScrollStates = function () {
    Array.from(terminal.querySelectorAll(`.${outputScrollClass}`)).forEach(
      updateOutputScrollState,
    );
  };

  window.addEventListener("resize", () =>
    window.requestAnimationFrame(updateAllOutputScrollStates),
  );

  const outputScrollContainer = function (
    cell: HTMLElement,
    beforeNode?: Node | null,
    standardOutput = false,
  ) {
    const previous =
      beforeNode instanceof Element
        ? beforeNode.previousElementSibling
        : cell.lastElementChild;
    if (
      previous &&
      previous.classList.contains(outputScrollClass) &&
      previous.classList.contains(standardOutputClass) == standardOutput
    )
      return previous as HTMLElement;

    const output = document.createElement(standardOutput ? "div" : "span");
    output.className = outputScrollClass;
    if (standardOutput) {
      output.classList.add(standardOutputClass);
      output.classList.add("M2Text");
    }
    if (beforeNode) cell.insertBefore(output, beforeNode);
    else cell.appendChild(output);
    return output;
  };

  const moveTrailingProtocolNewlineBeforePrompt = function (
    cell: HTMLElement,
    beforeNode?: Node | null,
  ) {
    // Newlines between successive WebApp HTML fragments belong inside the
    // scroll container. Once the next output prompt arrives, move only the
    // trailing run into the cell flow so the prompt starts a new result row.
    const previous =
      beforeNode instanceof Element
        ? beforeNode.previousElementSibling
        : cell.lastElementChild;
    if (
      !previous ||
      !previous.classList.contains(outputScrollClass) ||
      previous.classList.contains(standardOutputClass) ||
      !(previous.lastChild instanceof Text)
    )
      return;

    const split = splitTrailingProtocolNewline(previous.lastChild.data);
    if (!split) return;

    if (split.content.length > 0) previous.lastChild.data = split.content;
    else previous.lastChild.remove();

    const separator = document.createElement("span");
    separator.className = outputSeparatorClass;
    separator.textContent = split.newline;
    if (beforeNode) cell.insertBefore(separator, beforeNode);
    else cell.appendChild(separator);
  };

  const createHtml = function (className) {
    const cell = className.indexOf("M2Cell") >= 0; // a bit special
    const anc = htmlSec;
    const beforeNode =
      inputSpan && inputSpan.parentElement == anc ? inputSpan : null;
    if (
      outputMode === "webapp" &&
      className.indexOf("M2Prompt") >= 0 &&
      anc.classList.contains("M2Cell")
    )
      moveTrailingProtocolNewlineBeforePrompt(anc, beforeNode);
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
    if (className.indexOf("M2Text") < 0) htmlSec.dataset.code = "";
    // even M2Html needs to keep track of innerHTML because html tags may get broken
    if (beforeNode) anc.insertBefore(htmlSec, beforeNode);
    else anc.appendChild(htmlSec);
  };

  const createInputEl = function () {
    // (re)create the input area
    if (inputSpan) inputSpan.remove(); // parentElement.removeChild(inputSpan);
    inputSpan = document.createElement("span");
    //inputSpan = document.createElement("input"); // interesting idea but creates tons of problems
    inputSpan.contentEditable = "plaintext-only";
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
    if (initialOutputMode === "webapp")
      createHtml(webAppClasses[webAppTags.Cell]); // and one for the starting text (Macaulay2 version... or whatever comes out of M2 first)
    else htmlSec.classList.add(standardCellClass);
    htmlSec.appendChild(inputSpan);

    if (focusInputOnLoad) inputSpan.focus();

    inputEndFlag = false;
  };

  if (createInputSpan) createInputEl();
  else htmlSec = terminal;

  const codeStack = []; // stack of past code run

  obj.codeInputAction = function (t) {
    let str = t.dataset.m2code ? t.dataset.m2code : t.textContent; // used to be innerText
    if (str[str.length - 1] == "\n") str = str.substring(0, str.length - 1); // cleaner this way
    t.dataset.m2code = str;
    t.classList.add("codetrigger");
    if (
      (t.tagName == "CODE" && !t.classList.contains("norun")) ||
      t.classList.contains("run")
    ) {
      t.classList.add("clicked");
      codeStack.push(t);
      obj.postMessage(str);
    } else {
      // past input / manual code: almost the same but not quite: code not sent, just replaces input
      // inputSpan.textContent = str;
      // setCaretAtEndMaybe(inputSpan);
      inputSpan.focus();
      document.execCommand("selectAll");
      document.execCommand("insertText", false, str);
      scrollDown(terminal);
    }
    setTimeout(() => {
      t.classList.remove("codetrigger");
    }, 100);
  };

  const returnSymbol = "\u21B5";

  // borrowed from editor.ts
  const sanitizeInput = function (msg: string) {
    // sanitize input
    //  return msg.replace(sanitizeRegEx, "").replace(/\n+$/, "");
    return msg.replace(webAppRegex, "").replace(/\n+$/, "");
  };
  const htmlToM2 = function (el: HTMLElement) {
    return el.textContent.replace("−", "-");
  };
  const normalizePlainText = function (txt: string) {
    return txt.replace(/\t/g, "    ");
  };
  const blockedHtmlElementNames = new Set([
    "base",
    "embed",
    "iframe",
    "link",
    "meta",
    "object",
    "script",
  ]);
  const urlAttributeNames = new Set([
    "action",
    "formaction",
    "href",
    "poster",
    "src",
    "xlink:href",
  ]);
  const isDangerousUrl = function (value: string) {
    const normalized = value
      .trim()
      .replace(/[\u0000-\u001f\u007f\s]+/g, "")
      .toLowerCase();
    if (
      normalized.startsWith("javascript:") ||
      normalized.startsWith("vbscript:")
    )
      return true;
    return (
      normalized.startsWith("data:") &&
      !/^data:image\/(?:gif|jpe?g|png|svg\+xml|webp);/i.test(normalized)
    );
  };
  const preserveTrustedVectorGraphicsHandler = function (
    el: Element,
    attrName: string,
    attrValue: string,
  ) {
    if (el.tagName.toLowerCase() != "animate" || attrName != "onbegin") return;

    const match = attrValue.match(
      /^\s*gfxToggleRotation\s*\(\s*event\s*,\s*(true|false)\s*\)\s*;?\s*$/,
    );
    if (!match) return;

    el.setAttribute("data-gfx-toggle-rotation-onbegin", match[1]);
  };
  const sanitizeHtmlElement = function (el: Element) {
    Array.from(el.attributes).forEach((attr) => {
      const attrName = attr.name.toLowerCase();
      if (attrName.startsWith("on") || attrName == "srcdoc") {
        preserveTrustedVectorGraphicsHandler(el, attrName, attr.value);
        el.removeAttribute(attr.name);
        return;
      }
      if (urlAttributeNames.has(attrName) && isDangerousUrl(attr.value)) {
        el.removeAttribute(attr.name);
        return;
      }
      if (
        attrName == "style" &&
        /(?:expression\s*\(|url\s*\(\s*['"]?\s*(?:javascript|vbscript):)/i.test(
          attr.value,
        )
      ) {
        el.removeAttribute(attr.name);
      }
    });
  };
  const sanitizeHtmlTree = function (root: ParentNode) {
    Array.from(root.children).forEach((el) => {
      if (blockedHtmlElementNames.has(el.tagName.toLowerCase())) {
        el.remove();
        return;
      }
      sanitizeHtmlElement(el);
      sanitizeHtmlTree(el);
    });
  };
  const sanitizedHtmlFragment = function (html: string) {
    const template = document.createElement("template");
    template.innerHTML = html;
    sanitizeHtmlTree(template.content);
    return template.content;
  };
  const initializeVectorGraphics = function (
    container: HTMLElement,
    retries = 100,
  ) {
    const initializer = (window as any).gfxInitializeMacaulay2Graphics;
    if (typeof initializer == "function") {
      initializer(container);
      return;
    }
    if (retries <= 0) return;
    setTimeout(() => initializeVectorGraphics(container, retries - 1), 25);
  };
  const defaultMathIgnoredTags = [
    "script",
    "noscript",
    "style",
    "textarea",
    "pre",
    "code",
    "option",
  ];
  const renderMathInElement = function (
    container: HTMLElement | Element,
    ignoredTags: string[],
  ) {
    const renderMath = (window as any).renderMathInElement;
    if (typeof renderMath != "function") return;

    try {
      renderMath(container, {
        strict: false,
        trust: true,
        // Dense Macaulay2 output can contain thousands of thin-space macros.
        maxExpand: 100000,
        delimiters: [{ left: "$", right: "$", display: false }],
        ignoredTags,
      });
    } catch (err) {
      console.warn("Could not render Macaulay2 output math", err);
    }
  };
  const renderMathInHtml = function (container: HTMLElement) {
    // SVG output is already structured markup, not TeX-bearing prose.
    renderMathInElement(container, defaultMathIgnoredTags.concat(["svg"]));
    // VectorGraphics uses foreignObject text for axis labels such as $x$ and
    // $y$, so render just those HTML islands inside the skipped SVG trees.
    container
      .querySelectorAll("svg foreignObject, svg foreignobject")
      .forEach((el) => renderMathInElement(el, defaultMathIgnoredTags));
  };
  const inputSwitchesToStandardMode = function (txt: string) {
    return /(?:^|[;\n])\s*topLevelMode\s*=\s*Standard\s*(?:;|$)/.test(txt);
  };
  const trailingLineColumns = function (txt: string) {
    const lineStart = txt.lastIndexOf("\n") + 1;
    return txt.substring(lineStart).replace(/\t/g, "    ").length;
  };
  const rememberInputPromptIndent = function () {
    inputPromptIndentColumns = trailingLineColumns(htmlSec.textContent || "");
  };
  const makeContinuationIndent = function () {
    // Visual-only spacer; keep it out of inputSpan so M2 input/history stay unchanged.
    const spacer = document.createElement("span");
    spacer.className = continuationIndentClass;
    spacer.contentEditable = "false";
    spacer.setAttribute("aria-hidden", "true");
    spacer.style.width = `${inputPromptIndentColumns}ch`;
    return spacer;
  };
  const inputHasContinuationIndent = function () {
    return (
      inputSpan &&
      inputSpan.previousElementSibling &&
      inputSpan.previousElementSibling.classList.contains(
        continuationIndentClass,
      )
    );
  };
  const insertStandardContinuationIndent = function () {
    if (!inputSpan || outputMode !== "standard" || inputHasContinuationIndent())
      return;

    inputSpan.parentElement.insertBefore(makeContinuationIndent(), inputSpan);
  };
  const removeStandardContinuationIndent = function () {
    if (!inputHasContinuationIndent()) return;
    inputSpan.previousElementSibling.remove();
  };
  const standardEchoText = function (txt: string) {
    const continuationPrompt = " ".repeat(inputPromptIndentColumns);
    return (
      txt
        .split("\n")
        .map((line, index) =>
          index > 0 ? continuationPrompt + line : line,
        )
        .join("\n") + "\n"
    );
  };
  const insertContinuationIndent = function () {
    if (!inputSpan || !htmlSec.classList.contains("M2Input")) return;

    const spacer = makeContinuationIndent();
    htmlSec.insertBefore(spacer, inputSpan);
  };
  const enterStandardMode = function () {
    outputMode = "standard";
    if (htmlSec && htmlSec.classList && htmlSec.classList.contains("M2Cell"))
      htmlSec.classList.add(standardCellClass);
  };
  const leaveStandardMode = function () {
    outputMode = "webapp";
    pendingStandardEcho = "";
  };
  const clipboardText = function (data: DataTransfer | null) {
    return data ? normalizePlainText(data.getData("text/plain")) : "";
  };
  const hasPlainText = function (data: DataTransfer | null) {
    return !!data && Array.from(data.types).indexOf("text/plain") >= 0;
  };
  const shouldHandlePlainTextPaste = function (target: EventTarget | null) {
    if (!inputSpan) return false;
    const el = target instanceof HTMLElement ? target : null;
    if (el && el !== inputSpan && !inputSpan.contains(el)) {
      if (el.tagName == "INPUT" || el.tagName == "TEXTAREA") return false;
      if (el.isContentEditable) return false;
    }
    return true;
  };
  const insertPlainText = function (txt: string) {
    setCaretAtEndMaybe(inputSpan, true);
    document.execCommand("insertText", false, txt);
    scrollDown(terminal);
  };
  let lastClipboardPasteRequest = 0;
  const requestClipboardPaste = function () {
    const now = Date.now();
    if (now - lastClipboardPasteRequest < 250) return;
    lastClipboardPasteRequest = now;
    emit("paste");
  };

  const maxCompletionItems = 50;
  const seenCompletionLabels = new Set<string>();
  const uniqueCompletionItems = completionItems.filter((item) => {
    if (seenCompletionLabels.has(item.label)) return false;
    seenCompletionLabels.add(item.label);
    return true;
  });
  const macaulay2TokenClasses = new Map<
    string,
    { className: string; priority: number }
  >();
  const macaulay2TokenClass = function (kind: string) {
    switch (kind) {
      case "Class":
        return { className: "class-name", priority: 3 };
      case "Function":
        return { className: "function", priority: 2 };
      case "Constant":
        return { className: "constant", priority: 1 };
      case "Keyword":
        return { className: "keyword", priority: 4 };
      default:
        return null;
    }
  };

  if (syntax.tokens && syntax.tokens.length > 0) {
    syntax.tokens.forEach((token) => {
      const current = macaulay2TokenClasses.get(token.label);
      if (!current || token.priority > current.priority) {
        macaulay2TokenClasses.set(token.label, {
          className: token.className,
          priority: token.priority,
        });
      }
    });
  } else {
    completionItems.forEach((item) => {
      const tokenClass = macaulay2TokenClass(item.kind);
      const current = macaulay2TokenClasses.get(item.label);
      if (tokenClass && (!current || tokenClass.priority > current.priority))
        macaulay2TokenClasses.set(item.label, tokenClass);
    });
  }

  const macaulay2TokenPatterns = (syntax.patterns || [])
    .map((pattern) => {
      try {
        return {
          className: pattern.className,
          regex: new RegExp("^(?:" + pattern.source + ")"),
        };
      } catch (err) {
        console.warn("Could not compile Macaulay2 token pattern", pattern, err);
        return null;
      }
    })
    .filter((pattern) => pattern !== null) as {
    className: string;
    regex: RegExp;
  }[];

  const macaulay2WordPattern = /^[A-Za-z_]\w*/;

  const appendMacaulay2Token = function (
    fragment: DocumentFragment,
    text: string,
    tokenClass?: string,
  ) {
    if (text.length == 0) return;
    if (!tokenClass) {
      fragment.appendChild(document.createTextNode(text));
      return;
    }

    const span = document.createElement("span");
    span.className = "token " + tokenClass;
    span.textContent = text;
    fragment.appendChild(span);
  };

  const highlightedMacaulay2Text = function (text: string) {
    const fragment = document.createDocumentFragment();
    let i = 0;
    let plainStart = 0;

    const appendToken = function (end: number, tokenClass: string) {
      appendMacaulay2Token(fragment, text.substring(plainStart, i));
      appendMacaulay2Token(fragment, text.substring(i, end), tokenClass);
      i = end;
      plainStart = i;
    };

    while (i < text.length) {
      if (text.startsWith("///", i)) {
        const close = text.indexOf("///", i + 3);
        appendToken(close < 0 ? text.length : close + 3, "string");
      } else if (text.startsWith("--", i)) {
        const close = text.indexOf("\n", i + 2);
        appendToken(close < 0 ? text.length : close, "comment");
      } else if (text.startsWith("-*", i)) {
        const close = text.indexOf("*-", i + 2);
        appendToken(close < 0 ? text.length : close + 2, "comment");
      } else if (text.startsWith("{*", i)) {
        const close = text.indexOf("*}", i + 2);
        appendToken(close < 0 ? text.length : close + 2, "comment");
      } else if (text[i] == '"') {
        let end = i + 1;
        while (end < text.length) {
          if (text[end] == "\\") {
            end += 2;
          } else if (text[end] == '"') {
            end++;
            break;
          } else end++;
        }
        appendToken(end, "string");
      } else {
        const rest = text.substring(i);
        const wordMatch = rest.match(macaulay2WordPattern);
        const patternMatches = macaulay2TokenPatterns
          .map((pattern) => {
            const match = rest.match(pattern.regex);
            return match && match[0].length > 0
              ? { text: match[0], className: pattern.className }
              : null;
          })
          .filter((match) => match !== null) as {
          text: string;
          className: string;
        }[];
        const patternMatch = patternMatches.sort(
          (a, b) => b.text.length - a.text.length,
        )[0];

        if (wordMatch) {
          const word = wordMatch[0];
          const tokenClass = macaulay2TokenClasses.get(word);
          if (tokenClass) appendToken(i + word.length, tokenClass.className);
          else i += word.length;
        } else if (patternMatch) {
          appendToken(i + patternMatch.text.length, patternMatch.className);
        } else if (
          text.startsWith("->", i) ||
          text.startsWith("=>", i) ||
          text.startsWith("//", i)
        )
          appendToken(i + 2, "operator");
        else if ("%*/-+\\".indexOf(text[i]) >= 0)
          appendToken(i + 1, "operator");
        else i++;
      }
    }

    appendMacaulay2Token(fragment, text.substring(plainStart));
    return fragment;
  };

  const highlightMacaulay2Element = function (el: HTMLElement) {
    const originalNodes = Array.from(el.childNodes);
    const hasContinuationIndent = originalNodes.some(
      (node) =>
        node instanceof HTMLElement &&
        node.classList.contains(continuationIndentClass),
    );
    const text = el.textContent || "";
    el.textContent = "";
    if (!hasContinuationIndent) {
      el.appendChild(highlightedMacaulay2Text(text));
      return;
    }

    originalNodes.forEach((node) => {
      if (
        node instanceof HTMLElement &&
        node.classList.contains(continuationIndentClass)
      ) {
        el.appendChild(node);
      } else {
        el.appendChild(highlightedMacaulay2Text(node.textContent || ""));
      }
    });
  };

  const highlightMacaulay2CodeElements = function (container: HTMLElement) {
    Array.from(container.querySelectorAll("code") as NodeListOf<HTMLElement>)
      .filter((code) => language(code) == "Macaulay2")
      .forEach((code) => {
        if (code.classList.contains("M2HighlightedCode")) return;
        const codeText = code.dataset.m2code || code.textContent || "";
        code.dataset.m2code = codeText;
        highlightMacaulay2Element(code);
        code.classList.add("M2HighlightedCode");
      });
  };
  let completionMenu: HTMLUListElement | null = null;
  let completionMatches: CompletionItem[] = [];
  let completionStart = 0;
  let completionSelected = 0;
  let completionSelectionExplicit = false;

  const completionMenuIsVisible = function () {
    return completionMenu !== null && completionMenu.style.display != "none";
  };

  const ensureCompletionMenu = function () {
    if (completionMenu) return completionMenu;

    completionMenu = document.createElement("ul");
    completionMenu.className = "M2CompletionMenu";
    completionMenu.style.display = "none";
    document.body.appendChild(completionMenu);
    return completionMenu;
  };

  const getCompletionContext = function (allowEmptyPrefix = false) {
    if (!inputSpan || document.activeElement != inputSpan) return null;

    const caret = getCaret(inputSpan);
    if (caret === null) return null;

    const text = htmlToM2(inputSpan);
    const beforeCaret = text.substring(0, caret);
    const match = /(?:^|[^\w])(\w*)$/.exec(beforeCaret);
    if (!match) return null;

    const prefix = match[1];
    if (!allowEmptyPrefix && prefix.length == 0) return null;

    return {
      caret,
      prefix,
      start: caret - prefix.length,
      text,
    };
  };

  const hideCompletionMenu = function () {
    if (completionMenu) completionMenu.style.display = "none";
    completionMatches = [];
    completionSelectionExplicit = false;
  };

  const getCompletionMatches = function (prefix: string) {
    if (uniqueCompletionItems.length == 0) return [];

    const matches: CompletionItem[] = [];
    for (const item of uniqueCompletionItems) {
      if (item.label.startsWith(prefix)) {
        matches.push(item);
        if (matches.length >= maxCompletionItems) break;
      }
    }
    return matches;
  };

  const getCompletionAnchorRect = function (caret: number) {
    const nodeOffset = locateOffset(inputSpan, caret);
    if (nodeOffset) {
      const range = document.createRange();
      range.setStart(nodeOffset[0], nodeOffset[1]);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      if (rect.width || rect.height || rect.left || rect.top) return rect;
    }
    return inputSpan.getBoundingClientRect();
  };

  const positionCompletionMenu = function (caret: number) {
    const menu = ensureCompletionMenu();
    const rect = getCompletionAnchorRect(caret);
    const margin = 4;
    const width = menu.offsetWidth || 260;
    const height = menu.offsetHeight || 0;
    const left = Math.max(
      margin,
      Math.min(rect.left, window.innerWidth - width - margin),
    );
    const below = rect.bottom + margin;
    const above = rect.top - height - margin;
    const top =
      below + height <= window.innerHeight || above < margin ? below : above;

    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
  };

  const setCompletionSelection = function (index: number) {
    if (!completionMenu || completionMatches.length == 0) return;

    completionSelected =
      (index + completionMatches.length) % completionMatches.length;
    completionSelectionExplicit = true;
    Array.from(completionMenu.children).forEach((child, childIndex) => {
      child.classList.toggle("selected", childIndex == completionSelected);
    });
    completionMenu.children[completionSelected]?.scrollIntoView({
      block: "nearest",
    });
  };

  const applyCompletion = function (index: number) {
    const item = completionMatches[index];
    const context = getCompletionContext(true);
    if (!item || !context) return false;

    inputSpan.textContent =
      context.text.substring(0, completionStart) +
      item.label +
      context.text.substring(context.caret);
    setCaret(inputSpan, completionStart + item.label.length);
    hideCompletionMenu();
    scrollDown(terminal);
    return true;
  };

  const renderCompletionMenu = function () {
    const menu = ensureCompletionMenu();
    menu.textContent = "";

    completionMatches.forEach((item, index) => {
      const option = document.createElement("li");
      option.className = "M2CompletionItem";
      if (index == completionSelected) option.classList.add("selected");
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        applyCompletion(index);
      });

      const label = document.createElement("span");
      label.className = "M2CompletionLabel";
      label.textContent = item.label;
      option.appendChild(label);

      const kind = document.createElement("span");
      kind.className = "M2CompletionKind";
      kind.textContent = item.kind;
      option.appendChild(kind);

      menu.appendChild(option);
    });
  };

  const showCompletionMenu = function (
    allowEmptyPrefix = false,
    selectionExplicit = false,
  ) {
    const context = getCompletionContext(allowEmptyPrefix);
    if (!context) {
      hideCompletionMenu();
      return false;
    }

    const matches = getCompletionMatches(context.prefix);
    if (matches.length == 0) {
      hideCompletionMenu();
      return false;
    }

    completionMatches = matches;
    completionStart = context.start;
    completionSelected = 0;
    completionSelectionExplicit = selectionExplicit;
    renderCompletionMenu();
    ensureCompletionMenu().style.display = "block";
    positionCompletionMenu(context.caret);
    return true;
  };

  const completionKeyHandling = function (e: KeyboardEvent) {
    if (!inputSpan || document.activeElement != inputSpan) return false;

    if ((e.ctrlKey || e.metaKey) && e.code == "Space") {
      showCompletionMenu(true, true);
      e.preventDefault();
      e.stopPropagation();
      return true;
    }

    if (!completionMenuIsVisible()) return false;

    switch (e.key) {
      case "ArrowDown":
        setCompletionSelection(completionSelected + 1);
        e.preventDefault();
        return true;
      case "ArrowUp":
        setCompletionSelection(completionSelected - 1);
        e.preventDefault();
        return true;
      case "Enter":
        if (e.shiftKey) return false;
        if (!completionSelectionExplicit) return false;
        if (applyCompletion(completionSelected)) {
          e.preventDefault();
          return true;
        }
        return false;
      case "Tab":
        if (applyCompletion(completionSelected)) {
          e.preventDefault();
          return true;
        }
        return false;
      case "Escape":
        hideCompletionMenu();
        e.preventDefault();
        return true;
      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End":
        hideCompletionMenu();
        return false;
      default:
        return false;
    }
  };

  const inputFollowsStandardPrompt = function () {
    return (
      outputMode === "standard" &&
      inputSpan.previousElementSibling &&
      inputSpan.previousElementSibling.classList.contains(standardPromptClass)
    );
  };

  const createProcessingInputSpan = function () {
    const isStandardInput = outputMode === "standard";
    if (isStandardInput && !inputFollowsStandardPrompt())
      insertStandardContinuationIndent();
    const span = document.createElement(isStandardInput ? "span" : "div");
    if (isStandardInput)
      span.className = "M2Text M2PastInput " + standardSubmittedInputClass;
    inputSpan.parentElement.insertBefore(span, inputSpan);
    return span;
  };

  const isStandardSubmittedInput = function (el: HTMLElement) {
    return el.classList.contains(standardSubmittedInputClass);
  };

  const appendSubmittedInput = function (clean: string) {
    if (procInputSpan === null) {
      // it'd be nicer to use ::before on inputSpan but sadly caret issues... cf https://stackoverflow.com/questions/60843694/cursor-position-in-an-editable-div-with-a-before-pseudo-element
      procInputSpan = createProcessingInputSpan();
    }

    if (isStandardSubmittedInput(procInputSpan)) {
      procInputSpan.appendChild(highlightedMacaulay2Text(clean));
      pendingStandardEcho += standardEchoText(clean);
      inputSpan.parentElement.insertBefore(
        document.createTextNode("\n"),
        inputSpan,
      );
      insertStandardContinuationIndent();
      procInputSpan = null;
    } else procInputSpan.textContent += clean + returnSymbol + "\n";
  };

  const suppressPendingStandardEcho = function (msg: string) {
    if (pendingStandardEcho.length == 0) {
      if (
        outputMode === "standard" &&
        msg === " ".repeat(inputPromptIndentColumns)
      )
        return "";
      return msg;
    }

    if (pendingStandardEcho.startsWith(msg)) {
      pendingStandardEcho = pendingStandardEcho.substring(msg.length);
      return "";
    }

    if (msg.startsWith(pendingStandardEcho)) {
      const result = msg.substring(pendingStandardEcho.length);
      pendingStandardEcho = "";
      if (
        outputMode === "standard" &&
        result === " ".repeat(inputPromptIndentColumns)
      )
        return "";
      return result;
    }

    pendingStandardEcho = "";
    return msg;
  };

  obj.postMessage = function (msg) {
    hideCompletionMenu();
    // send input, adding \n if necessary
    const clean = sanitizeInput(msg);
    appendSubmittedInput(clean);
    inputSpan.textContent = "";
    scrollDownLeft(terminal);
    emit("input", clean + "\n");
  };

  obj.recordSubmittedInput = function (msg) {
    if (!inputFollowsStandardPrompt()) return;
    const clean = sanitizeInput(msg);
    if (clean.length == 0) return;
    appendSubmittedInput(clean);
    inputSpan.textContent = "";
    scrollDownLeft(terminal);
  };

  const focusElement = function () {
    const foc = window.getSelection().focusNode;
    return foc && foc.nodeType == 3 ? foc.parentElement : foc;
  };

  const downArrowKeyHandling = function () {
    if (
      focusElement() == inputSpan &&
      inputSpan.textContent.substring(getCaret(inputSpan) || 0).indexOf("\n") <
        0 &&
      cmdHistory.index < cmdHistory.length
    ) {
      cmdHistory.index++;
      inputSpan.textContent =
        cmdHistory.index === cmdHistory.length
          ? cmdHistory.current
          : cmdHistory[cmdHistory.index];
      return true;
    } else return false;
  };

  const upArrowKeyHandling = function () {
    if (
      focusElement() == inputSpan &&
      inputSpan.textContent
        .substring(0, getCaret(inputSpan) || 0)
        .indexOf("\n") < 0 &&
      cmdHistory.index > 0
    ) {
      if (cmdHistory.index === cmdHistory.length)
        cmdHistory.current = htmlToM2(inputSpan);
      cmdHistory.index--;
      inputSpan.textContent = cmdHistory[cmdHistory.index];
      return true;
    } else return false;
  };

  terminal.onpaste = function (e) {
    if (!shouldHandlePlainTextPaste(e.target)) return;
    e.preventDefault();
    if (hasPlainText(e.clipboardData)) {
      insertPlainText(clipboardText(e.clipboardData));
    } else {
      requestClipboardPaste();
    }
  };

  terminal.addEventListener("beforeinput", function (e: InputEvent) {
    if (
      e.inputType !== "insertFromPaste" &&
      e.inputType !== "insertFromDrop"
    )
      return;
    if (
      !shouldHandlePlainTextPaste(e.target) ||
      document.activeElement != inputSpan
    )
      return;
    e.preventDefault();
    if (hasPlainText(e.dataTransfer)) {
      insertPlainText(clipboardText(e.dataTransfer));
    } else if (e.inputType == "insertFromPaste") {
      requestClipboardPaste();
    }
  });

  obj.receivePaste = function (txt: string) {
    if (!inputSpan) return;
    insertPlainText(normalizePlainText(txt));
  };

  terminal.onclick = function (e) {
    if (!inputSpan) return;
    let t = e.target as HTMLElement;
    while (t != terminal) {
      if (
        ((t.tagName == "CODE" && language(t) == "Macaulay2") ||
          t.dataset.m2code || // allows to emulate code pasting from arbitrary html element
          t.classList.contains("M2PastInput")) &&
        t.ownerDocument.getSelection().isCollapsed
      ) {
        e.stopPropagation();
        obj.codeInputAction(t);
        return;
      } else if (t instanceof HTMLAnchorElement) {
        const href = t.getAttribute("href");
        if (!href) return;
        const [name, rowcols] = parseLocation(href);
        if (rowcols && name == "stdio") {
          obj.selectPastInput(document.activeElement, rowcols);
          e.preventDefault();
        } else if (isHtmlHelpLink(href)) {
          e.preventDefault();
          e.stopPropagation();
          openHelp(href);
        } else if (!t.host || t.host == window.location.host) {
          e.preventDefault();
          e.stopPropagation();
          emit("open", href); // calls to local files are redirected to editor
        }
        return;
      }
      if (t.classList.contains("M2CellBar")) return;
      t = t.parentElement;
    }
    if (
      window.getSelection().toString().length == 0 &&
      document.activeElement != inputSpan
    ) {
      inputSpan.focus({ preventScroll: true });
      setCaret(inputSpan, inputSpan.textContent.length);
    }
  };

  let savepos = null;
  terminal.onkeydown = function (e: KeyboardEvent) {
    if (!inputSpan) return;
    if (
      (e.target as HTMLElement).classList.contains("M2CellBar") ||
      (e.target as HTMLElement).tagName == "INPUT"
    )
      return;
    if (completionKeyHandling(e)) return;
    if (
      ((e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        e.key.toLowerCase() == "v") ||
      (e.shiftKey && e.key == "Insert")
    ) {
      if (shouldHandlePlainTextPaste(e.target)) {
        e.preventDefault();
        requestClipboardPaste();
        return;
      }
    }
    if (e.key == "Enter") {
      if (!e.shiftKey) {
        obj.postMessage(htmlToM2(inputSpan));
        setCaret(inputSpan, 0);
        e.preventDefault(); // no crappy <div></div> added
      }
      e.stopPropagation(); // in case of shift-enter, don't want it to kick in
      return;
    }

    if ((e.key == "ArrowDown" || e.key == "ArrowUp") && !e.shiftKey) {
      if (
        e.key == "ArrowDown" ? downArrowKeyHandling() : upArrowKeyHandling()
      ) {
        hideCompletionMenu();
        e.preventDefault();
        setCaretAtEndMaybe(inputSpan);
        scrollDown(terminal);
        //
        return;
      }
    }

    if (
      e.ctrlKey ||
      e.altKey ||
      e.metaKey ||
      e.key == "Shift" || // subtly different: shift key pressed (no combo)
      e.key == "PageUp" ||
      e.key == "PageDown" ||
      e.key == "F1"
    ) {
      // do not move caret on Ctrl/Command combos, PageUp/Down, etc
      if (e.key == "PageUp" && document.activeElement == inputSpan) {
        savepos = getCaret(inputSpan);
        // this prevents the annoying behavior of page up going to start of inputSpan => weird horiz scrolling
        setCaret(inputSpan, 0);
      }
      if (e.key == "PageDown" && document.activeElement == inputSpan) {
        // this prevents the annoying behavior of page down going to end of inputSpan => weird horiz scrolling
        setCaret(inputSpan, inputSpan.textContent.length);
      }
      return;
    }

    if (e.key == "Home") {
      setCaret(inputSpan, 0); // the default would sometimes use this for vertical scrolling
      scrollDownLeft(terminal);
      return;
    }

    if (e.key == "End") {
      setCaretAtEndMaybe(inputSpan); // the default would sometimes use this for vertical scrolling
      scrollDown(terminal);
      return;
    }

    setCaretAtEndMaybe(inputSpan, true);
    const pos = getCaret(inputSpan);
    if (pos == 0) scrollLeft(terminal);
  };

  terminal.oninput = function (e: InputEvent) {
    if (!inputSpan) return;
    if (document.activeElement == inputSpan && getCaret(inputSpan) == 0)
      scrollLeft(terminal);
    if (document.activeElement == inputSpan) showCompletionMenu(false);
    else hideCompletionMenu();
  };

  terminal.onkeyup = function (e: KeyboardEvent) {
    if (!inputSpan) return;
    if (savepos !== null) {
      setCaret(inputSpan, savepos);
      savepos = null;
    }
  };

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
          } else container.replaceChild(el, sub);
          if (rest.length > 0)
            container.insertBefore(document.createTextNode(rest), next);
          return true;
        }
      } else if (sub.nodeType === 1) {
        if (recurseReplace(sub, str, el)) return true;
      }
    }
    return false;
  };

  const isTrueInput = function () {
    // test if input is from user or from e.g. examples
    if (!createInputSpan) return false;
    let el = htmlSec;
    while (el && el != terminal && !el.classList.contains("M2Html"))
      el = el.parentElement; // TODO better
    return el == terminal;
  };

  const isOpenInputSection = function () {
    return htmlSec && htmlSec.classList.contains("M2Input");
  };

  const isOpenBufferedOutputSection = function () {
    return htmlSec && htmlSec.dataset && htmlSec.dataset.code !== undefined;
  };

  const shouldDeferErrorOutput = function () {
    // stdout/stderr arrive on separate pipes, so stderr can beat M2's input
    // echo or arrive while a tagged HTML/URL/position payload is still buffered.
    return (
      createInputSpan &&
      (procInputSpan !== null ||
        inputEndFlag ||
        isOpenInputSection() ||
        isOpenBufferedOutputSection())
    );
  };

  const flushPendingErrorOutput = function (force = false) {
    if (pendingErrorOutput.length == 0) return;
    if (!force && shouldDeferErrorOutput()) return;
    const msg = pendingErrorOutput;
    pendingErrorOutput = "";
    displayText(msg);
  };

  const sessionCell = function (el: HTMLElement) {
    while (el && el.parentElement != terminal) {
      el = el.parentElement;
    }
    return el;
  };

  const closeHtml = function () {
    const closingInput = htmlSec.classList.contains("M2Input");
    let anc = htmlSec.parentElement;

    if (htmlSec.classList.contains("M2Input"))
      anc.appendChild(document.createElement("br")); // this first for spacing purposes

    if (htmlSec.contains(inputSpan)) attachElement(inputSpan, anc);
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
          } else {
            interpreterDepth++;
            createHtml(webAppClasses[webAppTags.Cell]);
          }
          htmlSec.appendChild(saveAnc);
          htmlSec = saveHtmlSec;
          anc = saveAnc;
        }
      }
    } else if (htmlSec.classList.contains("M2Position") && isTrueInput()) {
      if (!htmlSec.parentElement.dataset.positions)
        htmlSec.parentElement.dataset.positions = " ";
      htmlSec.parentElement.dataset.positions += htmlSec.dataset.code + " ";
    } else if (htmlSec.classList.contains("M2Input")) {
      if (isTrueInput()) {
        // add input to history
        let txt = htmlSec.textContent;
        if (txt[txt.length - 1] == "\n") txt = txt.substring(0, txt.length - 1); // should be true
        if (htmlSec.classList.contains("M2InputContd"))
          // rare case where input is broken -- e.g.  I=ideal 0; x=(\n   1)
          cmdHistory[cmdHistory.length - 1] += "\n" + txt;
        else cmdHistory.index = cmdHistory.push(txt);
        txt.split("\n").forEach((line) => {
          line = line.trim();
          if (line.length > 0) cmdHistory.sorted.sortedPush(line);
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
      highlightMacaulay2Element(htmlSec);
    } else if (htmlSec.classList.contains("M2Html")) {
      // first things first: make sure we don't mess with input (interrupts, tasks, etc, can display unexpectedly)
      if (anc.classList.contains("M2Input")) {
        anc.parentElement.insertBefore(htmlSec, anc);
      }
      htmlSec.appendChild(sanitizedHtmlFragment(htmlSec.dataset.code || ""));
      // KaTeX rendering // TODO reinstate bundled version
      // autoRender(htmlSec);
      // instead we use the non-bundled katex
      renderMathInHtml(htmlSec);
      highlightMacaulay2CodeElements(htmlSec);
      initializeVectorGraphics(htmlSec);
      linkifyM2FileLocations(htmlSec);
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
      // auto opening links
      Array.from(
        htmlSec.querySelectorAll("a.auto") as NodeListOf<HTMLAnchorElement>,
      ).forEach((x) => {
        let url = x.getAttribute("href") || x.href;
        console.log("Opening URL " + url);
        openHelp(url);
      });
      // error highlighting
      Array.from(
        htmlSec.querySelectorAll(
          ".M2ErrorLocation a",
        ) as NodeListOf<HTMLAnchorElement>,
      ).forEach((x) => {
        const [name, rowcols] = parseLocation(x.getAttribute("href"));
        if (rowcols) {
          // highlight error
          if (name == "stdio") {
            const nodeOffset = obj.locateStdio(
              sessionCell(htmlSec),
              rowcols[0],
              rowcols[1],
            );
            if (nodeOffset) {
              addMarkerPos(nodeOffset[0], nodeOffset[1]).classList.add(
                "error-marker",
              );
            }
          }
          // TODO other cases
        }
      });
      // putting pieces back together
      if (htmlSec.dataset.idList) {
        htmlSec.dataset.idList.split(" ").forEach(function (id) {
          const el = document.getElementById("sub" + id);
          if (el) {
            if (el.style.color == "transparent") subList[+id][1].remove();
            // e.g. inside \vphantom{}
            else {
              el.style.display = "contents"; // could put in css but don't want to overreach
              el.style.fontSize = "0.826446280991736em"; // to compensate for katex's 1.21 factor
              el.innerHTML = "";
              el.appendChild(subList[+id][1]);
            }
          } else {
            // more complicated
            if (!recurseReplace(htmlSec, subList[+id][0], subList[+id][1]))
              console.log("Error restoring html element");
          }
        });
        htmlSec.removeAttribute("data-id-list");
      }
    } else if (htmlSec.classList.contains("M2Url")) {
      const url = htmlSec.dataset.code;
      if (url) openHelp(url);
    }
    htmlSec.removeAttribute("data-code");
    if (
      htmlSec.classList.contains("M2Html") &&
      anc.classList.contains("M2Cell")
    ) {
      const output = outputScrollContainer(anc, htmlSec);
      output.appendChild(htmlSec);
      queueOutputScrollStateUpdate(output);
    }
    if (anc.classList.contains("M2Html") && anc.dataset.code != "") {
      // stack
      // in case it's inside TeX, we compute dimensions
      // 18mu= 1em * mathfont size modifier, here 1.21 factor of KaTeX
      const unitName = "em"; // TEMP replace with "ce" eventually
      const fontSize: number =
        +window
          .getComputedStyle(htmlSec, null)
          .getPropertyValue("font-size")
          .split("px", 1)[0] * 1.21;
      const baseline: number = baselinePosition(htmlSec);
      const str =
        "\\htmlId{sub" +
        subList.length +
        "}{\\vphantom{" + // the vphantom ensures proper horizontal space
        "\\raisebox{" +
        baseline / fontSize +
        unitName +
        "}{}" +
        "\\raisebox{" +
        (baseline - htmlSec.offsetHeight) / fontSize +
        unitName +
        "}{}" +
        "}\\hspace{" +
        htmlSec.offsetWidth / fontSize +
        unitName +
        "}" + // the hspace is really just for debugging
        "}";
      anc.dataset.code += str;
      if (!anc.dataset.idList) anc.dataset.idList = subList.length;
      else anc.dataset.idList += " " + subList.length;
      subList.push([str, htmlSec]);
    }
    htmlSec = anc;
    if (closingInput) flushPendingErrorOutput(true);
  };

  obj.displayOutput = function (msg: string, isErrorOutput = false) {
    obj.openedHelp = false;
    if (isErrorOutput && shouldDeferErrorOutput()) {
      pendingErrorOutput += msg;
      scrollDownLeft(terminal);
      return;
    }
    if (procInputSpan !== null) {
      if (!isStandardSubmittedInput(procInputSpan)) procInputSpan.remove();
      procInputSpan = null;
    }
    msg = msg.replace(/\r/g, "");
    if (!isErrorOutput) msg = suppressPendingStandardEcho(msg);
    const txt = msg.split(webAppRegex);
    for (let i = 0; i < txt.length; i += 2) {
      //console.log(i+"-"+(i+1)+"/"+txt.length+": ",i==0?"":webAppClasses[txt[i-1]]," : ",txt[i].replace("\n",returnSymbol));
      // if we are at the end of an input section
      if (
        inputEndFlag &&
        ((i == 0 && txt[i].length > 0) ||
          (i > 0 && txt[i - 1] !== webAppTags.InputContd))
      ) {
        closeHtml();
        inputEndFlag = false;
      }
      if (i > 0) {
        leaveStandardMode();
        const tag = txt[i - 1];
        if (tag == webAppTags.End || tag == webAppTags.CellEnd) {
          if (htmlSec != terminal || !createInputSpan) {
            // htmlSec == terminal should only happen at very start
            // or at the very end for rendering help -- then it's OK
            while (htmlSec.classList.contains("M2Input")) closeHtml(); // M2Input is *NOT* closed by end tag but rather by \n
            // but in rare circumstances (ctrl-C interrupt) it may be missing its \n
            const oldHtmlSec = htmlSec;
            closeHtml();
          }
        } else if (tag === webAppTags.InputContd && inputEndFlag) {
          // continuation of input section
          insertContinuationIndent();
          inputEndFlag = false;
        } else {
          // new section
          if (tag === webAppTags.Input) rememberInputPromptIndent();
          createHtml(webAppClasses[tag]);
          if (
            inputSpan &&
            (tag === webAppTags.Input || tag === webAppTags.InputContd)
          ) {
            // input section: a bit special (ends at first \n)
            attachElement(inputSpan, htmlSec); // !!! we move the input inside the current span to get proper indentation !!!
            if (tag === webAppTags.InputContd) insertContinuationIndent();
          }
        }
      }

      if (txt[i].length > 0) {
        // for next round, check if we're nearing the end of an input section
        if (htmlSec.classList.contains("M2Input")) {
          const ii = txt[i].indexOf("\n");
          if (ii >= 0) {
            const inputLine = txt[i].substring(0, ii + 1);
            const switchesToStandardMode = inputSwitchesToStandardMode(
              htmlSec.textContent + inputLine,
            );
            if (ii < txt[i].length - 1 || switchesToStandardMode) {
              // need to do some surgery
              displayText(inputLine);
              if (switchesToStandardMode) enterStandardMode();
              closeHtml();
              txt[i] = txt[i].substring(ii + 1, txt[i].length);
            } else inputEndFlag = true;
            // can't tell for sure if it's the end of input or not (could be a InputContd), so set a flag to remind us
          }
        }

        if (txt[i].length > 0) {
          if (htmlSec.dataset.code !== undefined) htmlSec.dataset.code += txt[i];
          else displayText(txt[i]);
        }
        //          if (l.contains("M2Html")) htmlSec.innerHTML = htmlSec.dataset.code; // used to update in real time
        // all other states are raw text -- don't rewrite htmlSec.textContent+=txt[i] in case of input
      }
    }
    flushPendingErrorOutput();
    scrollDownLeft(terminal);
  };

  const parseTrailingStandardPrompt = function (
    txt: string,
  ): {
    before: string;
    separator: string;
    prompt: string;
    suffix: string;
  } | null {
    // Standard topLevelMode prints terminal-style prompts with no WebApp tags.
    // Keep only the prompt label underlined; the surrounding separators are text.
    const match = /(^|\n+)(i+\d+)( : )$/.exec(txt);
    if (!match) return null;
    return {
      before: txt.substring(0, match.index),
      separator: match[1],
      prompt: match[2],
      suffix: match[3],
    };
  };

  const displayText = function (msg) {
    const standardPrompt =
      inputSpan && inputSpan.parentElement == htmlSec
        ? parseTrailingStandardPrompt(msg)
        : null;
    if (standardPrompt) {
      enterStandardMode();
      inputPromptIndentColumns =
        standardPrompt.prompt.length + standardPrompt.suffix.length;
      removeStandardContinuationIndent();
      if (standardPrompt.before.length > 0) displayText(standardPrompt.before);
      if (standardPrompt.separator.length > 0)
        htmlSec.insertBefore(
          document.createTextNode(standardPrompt.separator),
          inputSpan,
        );
      const promptSpan = document.createElement("span");
      promptSpan.className = webAppClasses[webAppTags.Prompt];
      promptSpan.classList.add(standardPromptClass);
      promptSpan.appendChild(document.createTextNode(standardPrompt.prompt));
      htmlSec.insertBefore(promptSpan, inputSpan);
      if (standardPrompt.suffix.length > 0)
        htmlSec.insertBefore(
          document.createTextNode(standardPrompt.suffix),
          inputSpan,
        );
      return;
    }

    openStandardViewHelpLinks(msg);

    const displayTarget = function (txt: string) {
      if (!htmlSec.classList.contains("M2Cell")) return htmlSec;
      if (/^[\s:=]*$/.test(txt)) {
        const beforeNode =
          inputSpan && inputSpan.parentElement == htmlSec ? inputSpan : null;
        const previous =
          beforeNode instanceof Element
            ? beforeNode.previousElementSibling
            : htmlSec.lastElementChild;
        if (
          previous &&
          shouldAppendProtocolNewlineToPreviousOutput(
            txt,
            previous.classList.contains(outputScrollClass),
            previous.classList.contains(standardOutputClass),
            outputMode,
          )
        )
          return previous as HTMLElement;
        return htmlSec;
      }
      return outputScrollContainer(
        htmlSec,
        inputSpan && inputSpan.parentElement == htmlSec ? inputSpan : null,
        outputMode === "standard",
      );
    };
    const target = displayTarget(msg);
    // Multiline plain output can precede rich output in the same WebApp cell.
    // Keep it from pushing later SVG/HTML results horizontally off-screen.
    if (
      target != htmlSec &&
      outputMode !== "standard" &&
      shouldPromoteWebappOutputToBlock(msg)
    ) {
      target.style.display = "block";
    }
    const appendNode = function (node: Node) {
      if (target == htmlSec && inputSpan && inputSpan.parentElement == htmlSec)
        htmlSec.insertBefore(node, inputSpan);
      else target.appendChild(node);
    };

    const node = document.createTextNode(msg);
    appendNode(node);
    linkifyM2FileLocationTextNodeWithPreviousTail(node);
    if (target != htmlSec) queueOutputScrollStateUpdate(target);
  };

  obj.reset = function () {
    console.log("Reset");
    outputMode = initialOutputMode;
    pendingStandardEcho = "";
    pendingErrorOutput = "";
    if (procInputSpan !== null) procInputSpan.remove();
    procInputSpan = null;
    emit("reset");
    createInputEl(); // recreate the input area
    interpreterDepth = 1;
  };
  const resetBtn = document.getElementById("resetBtn");
  if (resetBtn) resetBtn.onclick = obj.reset;

  obj.interrupt = function () {
    inputSpan.textContent = "";
    emit("interrupt");
    setCaretAtEndMaybe(inputSpan);
  };
  const interruptBtn = document.getElementById("interruptBtn");
  if (interruptBtn) interruptBtn.onclick = obj.interrupt;

  obj.locateStdio = function (cel: HTMLElement, row: number, column: number) {
    // find relevant input from stdio:row:column
    const query = '.M2PastInput[data-positions*=" ' + row + ':"]';
    const pastInputs = Array.from(
      cel.querySelectorAll(query) as NodeListOf<HTMLElement>,
    );
    if (pastInputs.length == 0) return null;

    const m = pastInputs.map((p) => p.dataset.positions.match(/ (\d+):(\d+) /));
    let i = 0;
    while (
      i + 1 < pastInputs.length &&
      (+m[i + 1][1] < row || (+m[i + 1][1] == row && +m[i + 1][2] <= column))
    )
      i++;
    const m1 = m[i];
    const txt = pastInputs[i].textContent;
    const offset = locateRowColumn(
      txt,
      row - +m1[1] + 1,
      row == +m1[1] ? column - +m1[2] : column,
    );
    if (offset === null) return null;
    const nodeOffset = locateOffset(pastInputs[i], offset);
    if (nodeOffset)
      // should always be true
      return [nodeOffset[0], nodeOffset[1], pastInputs[i], offset]; // node, offset in node, element, offset in element
  };

  obj.selectPastInput = function (el: HTMLElement, rowcols) {
    const cel = sessionCell(el);
    if (!cel) return;
    const nodeOffset1 = obj.locateStdio(cel, rowcols[0], rowcols[1]);
    if (!nodeOffset1) return;
    const nodeOffset2 = obj.locateStdio(cel, rowcols[2], rowcols[3]);
    if (!nodeOffset2 || nodeOffset2[2] != nodeOffset1[2]) return;
    const sel = window.getSelection();
    sel.setBaseAndExtent(
      nodeOffset1[0],
      nodeOffset1[1],
      nodeOffset2[0],
      nodeOffset2[1],
    );
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

  if (inputSpan && focusInputOnLoad)
    window.addEventListener("load", function () {
      inputSpan.focus();
    });
};

export { Shell };
