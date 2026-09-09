//
// Construction of the Macaulay2 language client.
//
// This module is loaded through a dynamic import, so that the extension does
// not pull vscode-languageclient into activation for the many users who have
// no M2-language-server installed, or who have turned the setting off.
//
// Each client is built from one resolution and never mutated afterwards.  The
// server options are read when the client starts, so mutating them in place
// happens to work, but it leaves the client's configuration and the executable
// it was resolved from able to drift apart.  Building a fresh client when the
// resolution changes keeps them the same thing.
//

import {
  CloseAction,
  ErrorAction,
  ErrorHandler,
  Executable,
  LanguageClient,
  LanguageClientOptions,
  MessageTransports,
  ServerOptions,
} from "vscode-languageclient/node";
import { execFileSync, spawnSync } from "child_process";
import type { ChildProcess } from "child_process";
import { window } from "vscode";
import type { OutputChannel, ViewColumn } from "vscode";

import { CommandExecutableResolution } from "./executablePath";
import type { LanguageServerClient } from "./languageServer";
import { createLanguageServerUriConverters } from "./languageServerUris";

interface DisposableResource {
  dispose(): unknown;
}

interface RawLanguageClient {
  readonly diagnostics: DisposableResource | undefined;
  start(): Thenable<void>;
  stop(timeout?: number): Thenable<void>;
  dispose(timeout?: number): Thenable<void>;
  cancelStart?(): void;
}

const PROCESS_TERMINATION_GRACE_MILLISECONDS = 2_500;

function terminatePosixProcessTree(pid: number, visited = new Set<number>()) {
  if (visited.has(pid)) return;
  visited.add(pid);

  try {
    const descendants = spawnSync("pgrep", ["-P", pid.toString()], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    });
    if (typeof descendants.stdout === "string") {
      for (const line of descendants.stdout.split(/\s+/)) {
        if (!/^\d+$/.test(line)) continue;
        terminatePosixProcessTree(Number(line), visited);
      }
    }
  } catch {
    // Killing the known process is still better than abandoning cleanup when
    // process enumeration is unavailable.
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // A process can exit while its tree is being enumerated.
  }
}

function terminateChildProcess(child: ChildProcess) {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }

  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/T", "/F", "/PID", child.pid.toString()], {
        stdio: "ignore",
        timeout: 2_000,
      });
    } else if (process.platform === "darwin" || process.platform === "linux") {
      terminatePosixProcessTree(child.pid);
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already have exited between the checks above.
    }
  }
}

export class CancellableLanguageClient extends LanguageClient {
  private cancellationRequested = false;
  private ownedServerProcess: ChildProcess | undefined;
  private pendingStartup: Promise<void> | undefined;
  private readonly pendingWrites = new Set<Promise<void>>();

  constructor(
    id: string,
    name: string,
    serverOptions: ServerOptions,
    clientOptions: LanguageClientOptions,
  ) {
    super(id, name, serverOptions, {
      ...clientOptions,
      // Let start() reject to the controller instead of showing a separate
      // initialization notification (including during intentional cancellation).
      initializationFailedHandler: () => false,
    });
  }

  start(): Promise<void> {
    if (this.cancellationRequested) {
      return Promise.reject(new Error("Language server start was cancelled."));
    }
    const startup = super.start();
    this.pendingStartup = startup;
    return startup.finally(async () => {
      if (this.pendingStartup === startup) this.pendingStartup = undefined;
      if (this.cancellationRequested && this.isRunning()) {
        // A transport can finish starting after the bounded stop below has
        // returned. Its registrations still need a final graceful cleanup.
        try {
          await super.stop();
        } catch {
          this.terminateServerProcess();
        }
      }
    });
  }

  async stop(timeout?: number): Promise<void> {
    const startup = this.pendingStartup;
    if (startup) {
      // v9 reports Running before its initialized notification has finished
      // writing. Stopping at that point clears features too early: initialize
      // can still install providers and listeners afterwards.
      let graceHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([
          startup.then(
            () => true,
            () => true,
          ),
          new Promise<boolean>((resolve) => {
            graceHandle = setTimeout(
              () => resolve(false),
              PROCESS_TERMINATION_GRACE_MILLISECONDS,
            );
          }),
        ]);
        if (!settled) {
          this.terminateServerProcess();
          return;
        }
      } finally {
        if (graceHandle !== undefined) clearTimeout(graceHandle);
      }

      // doInitialize also calls stop() without observing its promise when
      // initialization fails. A failed or still-pending start cannot use the
      // library's normal stop API; disposal owns forced process cleanup.
      if (!this.isRunning()) return;
    }

    try {
      await super.stop(timeout);
    } catch (error) {
      if (!this.cancellationRequested) throw error;
      this.terminateServerProcess();
    }
  }

  createDefaultErrorHandler(maxRestartCount?: number): ErrorHandler {
    const handler = super.createDefaultErrorHandler(maxRestartCount);
    return {
      error: (error, message, count) =>
        this.cancellationRequested
          ? { action: ErrorAction.Continue, handled: true }
          : handler.error(error, message, count),
      closed: async () => {
        if (!this.cancellationRequested) return handler.closed();

        // The base close handler has already disposed the connection, allowing
        // initialize to reject. Wait before it clears _onStart, otherwise v9
        // can orphan that rejected promise and attempt an unwanted restart.
        await this.pendingStartup?.catch(() => {});
        return { action: CloseAction.DoNotRestart, handled: true };
      },
    };
  }

  error(message: string, data?: unknown, showNotification?: boolean | "force") {
    super.error(
      message,
      data,
      this.cancellationRequested ? false : showNotification,
    );
  }

  cancelStart() {
    this.cancellationRequested = true;
    this.captureServerProcess();
    // Once initialize has replied, allow the initialized write to finish so
    // stop can clean up its registrations. A hung handshake is killed now;
    // a hung initialized write is killed by stop's bounded wait above.
    if (!this.pendingStartup || !this.isRunning()) {
      this.terminateAfterWrites();
    }
  }

  private terminateAfterWrites() {
    if (this.pendingWrites.size === 0) {
      this.terminateServerProcess();
      return;
    }

    // JSON-RPC 8 can leak a rejection if the initialize request's write fails.
    // Let queued bytes flush before closing the pipes; stop's grace period
    // still bounds termination if a write never completes.
    void Promise.allSettled([...this.pendingWrites]).then(() => {
      this.terminateAfterWrites();
    });
  }

  protected async createMessageTransports(
    encoding: string,
  ): Promise<MessageTransports> {
    try {
      const transports = await super.createMessageTransports(encoding);
      this.captureServerProcess();
      if (this.cancellationRequested) {
        this.terminateServerProcess();
        throw new Error("Language server start was cancelled.");
      }
      const write = transports.writer.write.bind(transports.writer);
      transports.writer.write = (message) => {
        const pending = write(message);
        this.pendingWrites.add(pending);
        const remove = () => this.pendingWrites.delete(pending);
        void pending.then(remove, remove);
        return pending;
      };
      return transports;
    } catch (error) {
      this.captureServerProcess();
      if (this.cancellationRequested) this.terminateServerProcess();
      throw error;
    }
  }

  private captureServerProcess() {
    const spawned = (this as unknown as { _serverProcess?: ChildProcess })
      ._serverProcess;
    if (!spawned || this.ownedServerProcess === spawned) return;

    this.ownedServerProcess = spawned;
    spawned.once("exit", () => {
      if (this.ownedServerProcess === spawned) {
        this.ownedServerProcess = undefined;
      }
    });
  }

  private terminateServerProcess() {
    if (this.ownedServerProcess) {
      terminateChildProcess(this.ownedServerProcess);
    }
  }
}

class GuardedOutputChannel implements OutputChannel {
  readonly name: string;
  private closed = false;

  constructor(private readonly channel: OutputChannel) {
    this.name = channel.name;
  }

  append(value: string) {
    if (!this.closed) this.channel.append(value);
  }

  appendLine(value: string) {
    if (!this.closed) this.channel.appendLine(value);
  }

  replace(value: string) {
    if (!this.closed) this.channel.replace(value);
  }

  clear() {
    if (!this.closed) this.channel.clear();
  }

  show(preserveFocus?: boolean): void;
  show(column?: ViewColumn, preserveFocus?: boolean): void;
  show(columnOrPreserveFocus?: ViewColumn | boolean, preserveFocus?: boolean) {
    if (this.closed) return;
    if (typeof columnOrPreserveFocus === "number") {
      this.channel.show(columnOrPreserveFocus, preserveFocus);
    } else {
      this.channel.show(columnOrPreserveFocus);
    }
  }

  hide() {
    if (!this.closed) this.channel.hide();
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.channel.dispose();
  }
}

export function createGuardedOutputChannel(
  channel: OutputChannel,
): OutputChannel {
  return new GuardedOutputChannel(channel);
}

function disposeQuietly(resource: DisposableResource | undefined) {
  try {
    resource?.dispose();
  } catch {
    // Cleanup is best effort, and must not hide the lifecycle error that led
    // here.
  }
}

// vscode-languageclient 9 rejects dispose() while a client is Starting or
// StartFailed, before releasing the diagnostic collection and output channel.
// Own those resources outside the client so every failed or cancelled start
// has an idempotent cleanup path.
export function manageLanguageClient(
  client: RawLanguageClient,
  outputChannel: DisposableResource,
  processTerminationGraceMilliseconds = PROCESS_TERMINATION_GRACE_MILLISECONDS,
): LanguageServerClient {
  let disposal: Promise<void> | undefined;
  let disposalRequested = false;
  let startPending = false;
  let startCleanup: Promise<void> | undefined;
  let stopFailed = false;

  return {
    start() {
      startPending = true;
      try {
        const result = client.start();
        startCleanup = Promise.resolve(result).then(
          async () => {
            startPending = false;
            if (!disposalRequested) return;
            try {
              await client.stop();
            } catch {
              // dispose(0) already scheduled forced process termination.
            }
          },
          () => {
            startPending = false;
            // The controller reports the original start failure.
          },
        );
        return result;
      } catch (error) {
        startPending = false;
        throw error;
      }
    },
    async stop() {
      // Mark cancellation before stop waits for initialize. Waiting until
      // dispose would leave a hung handshake blocking the controller's queue.
      if (startPending) client.cancelStart?.();
      try {
        await client.stop();
      } catch (error) {
        stopFailed = true;
        throw error;
      }
    },
    dispose() {
      disposalRequested = true;
      if (!disposal) {
        client.cancelStart?.();
        const diagnostics = client.diagnostics;
        const pendingStart = startPending ? startCleanup : undefined;
        disposal = (async () => {
          let rawDisposeFailed = false;
          try {
            // Zero makes the library's own shutdown race return immediately.
            // Its Node adapter still schedules termination of a child process
            // that was created by an incomplete start.
            await client.dispose(0);
          } catch {
            // StartFailed and Starting are expected to reject here.
            rawDisposeFailed = true;
          }

          if (rawDisposeFailed || stopFailed || pendingStart) {
            // The Node client schedules forced child termination two seconds
            // after stop() rejects in Starting state.  Wait for a late start
            // to be stopped, or just beyond that bounded termination window,
            // before a replacement can launch.
            let graceHandle: ReturnType<typeof setTimeout> | undefined;
            const grace = new Promise<void>((resolve) => {
              graceHandle = setTimeout(
                resolve,
                Math.max(0, processTerminationGraceMilliseconds),
              );
            });
            if (rawDisposeFailed || stopFailed) {
              // StartFailed settles its start promise before dispose() gets
              // here, but its child termination is still only scheduled.  Do
              // not let that rejection shorten the process grace period.
              await grace;
            } else if (pendingStart) {
              await Promise.race([pendingStart, grace]);
            }
            if (graceHandle !== undefined) clearTimeout(graceHandle);
          }

          // A normal stop clears diagnostics itself.  A failed start leaves
          // the same collection installed, so release it explicitly.
          if (client.diagnostics === diagnostics) {
            disposeQuietly(diagnostics);
          }
          disposeQuietly(outputChannel);
        })();
      }

      return disposal;
    },
  };
}

export function createLanguageClient(
  resolution: CommandExecutableResolution,
): LanguageServerClient {
  const serverOptions: Executable = {
    command: resolution.executablePath,
    args: resolution.args,
  };
  const outputChannel = createGuardedOutputChannel(
    window.createOutputChannel("Macaulay2 Language Server"),
  );
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "macaulay2" },
      { scheme: "untitled", language: "macaulay2" },
    ],
    outputChannel,
    uriConverters: createLanguageServerUriConverters(resolution),
  };

  try {
    const client = new CancellableLanguageClient(
      "macaulay2-language-server",
      "Macaulay2 Language Server",
      serverOptions as ServerOptions,
      clientOptions,
    );
    return manageLanguageClient(client, outputChannel);
  } catch (error) {
    disposeQuietly(outputChannel);
    throw error;
  }
}
