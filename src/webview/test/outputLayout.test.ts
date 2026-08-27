import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import {
  shouldAppendProtocolNewlineToPreviousOutput,
  shouldPromoteWebappOutputToBlock,
  splitTrailingProtocolNewline,
} from "../outputLayout";

suite("Webview Output Layout", function () {
  test("keeps protocol newlines from separating output labels and values", function () {
    const webviewTemplate = fs.readFileSync(
      path.join(__dirname, "../../media/webview.html"),
      "utf8",
    );

    assert.ok(
      /\.M2Cell\s*{[^}]*white-space:\s*normal;[^}]*}/.test(webviewTemplate),
    );
    assert.ok(
      /\.M2Cell\s*>\s*\.M2Input,\s*\.M2Cell\s*>\s*\.M2OutputScroll,\s*\.M2Cell\s*>\s*\.M2StandardOutput\s*{[^}]*white-space:\s*pre;[^}]*}/.test(
        webviewTemplate,
      ),
    );
    assert.ok(
      /\.M2OutputSeparator\s*{[^}]*white-space:\s*pre;[^}]*}/.test(
        webviewTemplate,
      ),
    );
  });

  test("keeps protocol newlines with preceding rich output", function () {
    assert.equal(
      shouldAppendProtocolNewlineToPreviousOutput("\n", true, false, "webapp"),
      true,
    );
    assert.equal(
      shouldAppendProtocolNewlineToPreviousOutput("\n", true, true, "webapp"),
      false,
    );
    assert.equal(
      shouldAppendProtocolNewlineToPreviousOutput("\n", true, true, "standard"),
      true,
    );
    assert.equal(
      shouldAppendProtocolNewlineToPreviousOutput(
        "\n\n",
        true,
        false,
        "webapp",
      ),
      true,
    );
    assert.equal(
      shouldAppendProtocolNewlineToPreviousOutput(" \n", true, false, "webapp"),
      false,
    );
  });

  test("does not make newline-only WebApp output a block", function () {
    assert.equal(shouldPromoteWebappOutputToBlock("\n"), false);
    assert.equal(shouldPromoteWebappOutputToBlock("\n\n"), false);
    assert.equal(shouldPromoteWebappOutputToBlock("first\nsecond"), true);
    assert.equal(shouldPromoteWebappOutputToBlock("single line"), false);
  });

  test("separates a trailing protocol newline from output content", function () {
    assert.deepEqual(splitTrailingProtocolNewline("value\n\n"), {
      content: "value",
      newline: "\n\n",
    });
    assert.deepEqual(splitTrailingProtocolNewline("\n"), {
      content: "",
      newline: "\n",
    });
    assert.equal(splitTrailingProtocolNewline("value"), null);
  });

  test("lets simple string fragments participate in preformatted flow", function () {
    const webviewTemplate = fs.readFileSync(
      path.join(__dirname, "../../media/webview.html"),
      "utf8",
    );

    assert.ok(
      /\.M2OutputScroll\s*>\s*\.M2Html:has\(>\s*samp\.token\.string:only-child\)\s*{[^}]*display:\s*inline;[^}]*}/.test(
        webviewTemplate,
      ),
    );
  });

  test("keeps eigenvector value lists compact and bullet-free", function () {
    const webviewTemplate = fs.readFileSync(
      path.join(__dirname, "../../media/webview.html"),
      "utf8",
    );

    assert.ok(
      /\.M2Html\s+\.katex\s+\.M2Html\s*>\s*ul\[style\*="display:inline-table"\],\s*\.M2Html\s+\.katex\s+\.M2Html\s*>\s*ul\[style\*="display: inline-table"\]\s*{[^}]*line-height:\s*1\.2;[^}]*list-style:\s*none;[^}]*margin:\s*0;[^}]*padding-left:\s*0;[^}]*vertical-align:\s*middle;[^}]*}/.test(
        webviewTemplate,
      ),
    );
  });
});
