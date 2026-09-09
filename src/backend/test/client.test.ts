import * as assert from "assert";
import * as path from "path";
import type { ChildProcess } from "child_process";
import { languages, window } from "vscode";
import type { Disposable } from "vscode";
import type { MessageTransports } from "vscode-languageclient/node";

import {
  CancellableLanguageClient,
  createGuardedOutputChannel,
  manageLanguageClient,
} from "../client";
import { createLanguageServerController } from "../languageServer";

function deferred() {
  let resolve: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve: () => resolve() };
}

async function waitForStartupStage(
  stage: Promise<void>,
  starting: Promise<void>,
  reportedErrors: unknown[],
  description: string,
) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      stage,
      starting.then(() => {
        throw new Error(
          `Startup finished before ${description}: ${reportedErrors.map(String).join("; ")}`,
        );
      }),
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          7_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Run a real protocol peer in a child process, so closing its pipes exercises
// vscode-languageclient's initialization, connection-close, and restart paths.
const serverScript = `
const rpc = require(process.argv[1]);
const mode = process.argv[2];
const connection = rpc.createMessageConnection(
  new rpc.StreamMessageReader(process.stdin),
  new rpc.StreamMessageWriter(process.stdout),
);
connection.onRequest("initialize", () => {
  if (mode === "hang") return new Promise(() => {});
  if (mode === "fail") throw new rpc.ResponseError(-32001, "Test server initialization failure");
  return { capabilities: {} };
});
connection.onRequest("shutdown", () => new Promise(resolve => setTimeout(() => resolve(null), 50)));
connection.onNotification("exit", () => process.exit());
connection.listen();
`;

class ObservedLanguageClient extends CancellableLanguageClient {
  readonly initializeSent = deferred();
  readonly initializedWriting = deferred();
  readonly releaseInitialized = deferred();
  readonly stopRequested = deferred();
  readonly children: ChildProcess[] = [];
  feature: Disposable | undefined;

  constructor(mode: "success" | "hang" | "fail", pauseInitialized: boolean) {
    const outputChannel = createGuardedOutputChannel(
      window.createOutputChannel("Macaulay2 client lifecycle test"),
    );
    super(
      "macaulay2-lifecycle-test",
      "Macaulay2 lifecycle test",
      {
        command: process.execPath,
        args: [
          "-e",
          serverScript,
          path.join(
            path.dirname(require.resolve("vscode-jsonrpc/package.json")),
            "node.js",
          ),
          mode,
        ],
        options: {
          env: { ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ASAR: "1" },
        },
      },
      { documentSelector: [{ language: "macaulay2" }], outputChannel },
    );
    if (!pauseInitialized) this.releaseInitialized.resolve();
    this.registerFeature({
      fillClientCapabilities() {},
      initialize: () => {
        this.feature = languages.registerHoverProvider(
          { language: "macaulay2" },
          { provideHover: () => undefined },
        );
      },
      clear: () => this.clearObservedFeature(),
      getState: () => ({ kind: "static" }),
    });
  }

  clearObservedFeature() {
    this.feature?.dispose();
    this.feature = undefined;
  }

  stop(timeout?: number): Promise<void> {
    this.stopRequested.resolve();
    return super.stop(timeout);
  }

  protected async createMessageTransports(
    encoding: string,
  ): Promise<MessageTransports> {
    const transports = await super.createMessageTransports(encoding);
    const child = (this as unknown as { _serverProcess: ChildProcess })
      ._serverProcess;
    assert.ok(child, "the Node language client must own the test server");
    this.children.push(child);
    const write = transports.writer.write.bind(transports.writer);
    transports.writer.write = async (message) => {
      if ("method" in message && message.method === "initialize") {
        this.initializeSent.resolve();
      }
      if ("method" in message && message.method === "initialized") {
        this.initializedWriting.resolve();
        await this.releaseInitialized.promise;
      }
      return write(message);
    };
    return transports;
  }
}

function createHarness(
  mode: "success" | "hang" | "fail",
  pauseInitialized = false,
) {
  const client = new ObservedLanguageClient(mode, pauseInitialized);
  const managed = manageLanguageClient(client, client.outputChannel, 150);
  const reportedErrors: unknown[] = [];
  let enabled = true;
  const controller = createLanguageServerController({
    createClient: async () => managed,
    resolver: {
      resolve: () => ({
        resolution: {
          executablePath: process.execPath,
          args: [],
          source: "test fixture",
        },
        timedOut: false,
      }),
      forget() {},
    },
    isEnabled: () => enabled,
    reportDisabled() {},
    reportNotFound: () => assert.fail("the fixture server is available"),
    reportStartError: (error) => reportedErrors.push(error),
    reportStopError: (error) => reportedErrors.push(error),
    startTimeoutMilliseconds: 5_000,
  });
  return {
    client,
    controller,
    reportedErrors,
    disable() {
      enabled = false;
      return controller.configurationChanged();
    },
    async dispose() {
      client.releaseInitialized.resolve();
      client.cancelStart();
      await controller.stop();
      await managed.dispose();
      client.clearObservedFeature();
      for (const child of client.children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }
    },
  };
}

suite("Language client cancellation integration", function () {
  this.timeout(15_000);

  let notifications: string[];
  let unhandledRejections: unknown[];
  let originalShowErrorMessage: typeof window.showErrorMessage;
  const recordRejection = (error: unknown) => unhandledRejections.push(error);

  setup(() => {
    notifications = [];
    unhandledRejections = [];
    originalShowErrorMessage = window.showErrorMessage;
    window.showErrorMessage = ((message: string) => {
      notifications.push(message);
      return Promise.resolve(undefined);
    }) as typeof window.showErrorMessage;
    process.on("unhandledRejection", recordRejection);
  });

  teardown(() => {
    window.showErrorMessage = originalShowErrorMessage;
    process.removeListener("unhandledRejection", recordRejection);
  });

  test("disable during the initialized notification removes late providers and listeners", async () => {
    const harness = createHarness("success", true);
    try {
      const starting = harness.controller.start();
      await waitForStartupStage(
        harness.client.initializedWriting.promise,
        starting,
        harness.reportedErrors,
        "the initialized notification",
      );
      const disabling = harness.disable();
      await harness.client.stopRequested.promise;
      harness.client.releaseInitialized.resolve();
      await Promise.all([starting, disabling]);

      assert.strictEqual(harness.client.feature, undefined);
      // This private library field is intentionally checked by an integration
      // test: stop() used to clear it before initialization added a listener.
      const listeners = (harness.client as unknown as { _listeners: unknown[] })
        ._listeners;
      assert.strictEqual(listeners.length, 0);
      assert.deepStrictEqual(harness.reportedErrors, []);
      assert.deepStrictEqual(notifications, []);
      assert.deepStrictEqual(unhandledRejections, []);
    } finally {
      await harness.dispose();
    }
  });

  test("disabling a hung initialize does not notify, reject unhandled, or restart", async () => {
    const harness = createHarness("hang");
    try {
      const starting = harness.controller.start();
      await waitForStartupStage(
        harness.client.initializeSent.promise,
        starting,
        harness.reportedErrors,
        "the initialize request",
      );
      await Promise.all([starting, harness.disable()]);
      // Let close events and detached promise rejections reach their handlers.
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.strictEqual(harness.client.children.length, 1);
      assert.ok(
        harness.client.children.every(
          (child) => child.exitCode !== null || child.signalCode !== null,
        ),
        "cancellation must terminate the initializing child process",
      );
      assert.deepStrictEqual(harness.reportedErrors, []);
      assert.deepStrictEqual(notifications, []);
      assert.deepStrictEqual(unhandledRejections, []);
    } finally {
      await harness.dispose();
    }
  });

  test("an actual initialize failure still reports the server error", async () => {
    const harness = createHarness("fail");
    try {
      await harness.controller.start();

      assert.strictEqual(harness.reportedErrors.length, 1);
      assert.ok(
        String(harness.reportedErrors[0]).includes(
          "Test server initialization failure",
        ),
        harness.reportedErrors.map(String).join("; "),
      );
      assert.ok(
        notifications.length > 0,
        "a real initialization error must remain visible",
      );
      assert.deepStrictEqual(unhandledRejections, []);
    } finally {
      await harness.dispose();
    }
  });
});
