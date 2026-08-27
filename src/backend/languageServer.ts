//
// Start/restart logic for the Macaulay2 language server, kept apart from
// activate() so it can be tested against fakes.
//
// The shape of the problem: start() is driven by editor events -- every opened
// document and every switch of the active editor -- while restart() is a user
// command, and resolving the executable is a synchronous, expensive probe.  So
// the rules are that the probe happens at most once, that a negative answer
// stops the editor events from asking again, and that the user command is the
// way back from either.
//
// The client is created here rather than handed in, and only once a resolution
// has actually succeeded.  That keeps vscode-languageclient out of activation
// for anyone without a language server installed, and it means a client is
// only ever paired with the executable it was built from: restart discards the
// old one instead of pointing it at a new path.
//

import {
  CachedCommandResolver,
  CommandExecutableResolution,
} from "./executablePath";

// The slice of vscode-languageclient's LanguageClient this needs, so tests do
// not have to construct one.
export interface LanguageServerClient {
  start(): Thenable<void>;
  stop(): Thenable<void>;
  dispose(): Thenable<void> | void;
}

export interface LanguageServerControllerOptions {
  createClient(
    resolution: CommandExecutableResolution,
  ): Thenable<LanguageServerClient>;
  resolver: CachedCommandResolver;
  isEnabled(): boolean;
  reportDisabled(): void;
  reportNotFound(): void;
  reportStartError(error: unknown): void;
  reportStopError(error: unknown): void;
}

export interface LanguageServerController {
  /** Idempotent and cheap to call from an editor event. */
  start(): Promise<void>;
  /** The "Macaulay2: Restart Language Server" command. */
  restart(): Promise<void>;
  /** Shut the server down, for deactivate(). */
  stop(): Promise<void>;
  /** For context.subscriptions. */
  dispose(): void;
}

export function createLanguageServerController(
  options: LanguageServerControllerOptions,
): LanguageServerController {
  const {
    createClient,
    resolver,
    isEnabled,
    reportDisabled,
    reportNotFound,
    reportStartError,
    reportStopError,
  } = options;

  // Undefined until a resolution succeeds and a client is built for it.
  let client: LanguageServerClient | undefined;
  let started = false;
  // Set once a probe has conclusively come back empty, so the editor events
  // stop asking.  Only restart() clears it, which is how a language server
  // installed after activation gets picked up.
  let missing = false;
  let pending: Promise<void> | undefined;
  let pendingToken = 0;

  // Everything that touches the client goes through here, so that at most one
  // operation is ever in flight and callers can await whatever is running.
  // Errors are reported once and never propagate: every caller discards the
  // result, and an unhandled rejection out of an editor event is not useful.
  const run = (
    work: () => Promise<void>,
    report: (error: unknown) => void = reportStartError,
  ): Promise<void> => {
    const token = ++pendingToken;
    const task = (async () => {
      try {
        await work();
      } catch (error) {
        report(error);
      } finally {
        // A restart that took the slot over while this was settling must keep
        // it, or a concurrent start would see an idle controller.
        if (pendingToken === token) pending = undefined;
      }
    })();

    pending = task;
    return task;
  };

  // Resolves the executable and builds a client for it, recording a conclusive
  // "not installed" so the editor events stop asking.  A probe that merely
  // timed out is not conclusive: the next attempt should look again.
  const resolveClient = async () => {
    const probe = resolver.resolve();
    if (!probe.resolution) {
      missing = !probe.timedOut;
      return undefined;
    }

    return await createClient(probe.resolution);
  };

  // Tear down whatever is running, leaving the controller as if it had never
  // started.  Used before building a client for a new resolution, and by
  // stop() on deactivate.
  const discardClient = async () => {
    const running = client;
    client = undefined;
    started = false;
    if (!running) return;

    await running.stop();
    await running.dispose();
  };

  const start = () => {
    if (started || missing || !isEnabled()) return Promise.resolve();
    if (pending) return pending;

    return run(async () => {
      const resolved = await resolveClient();
      if (!resolved) return;

      client = resolved;
      await resolved.start();
      started = true;
    });
  };

  const restart = () => {
    if (!isEnabled()) {
      reportDisabled();
      return Promise.resolve();
    }

    const previous = pending;
    return run(async () => {
      // run() never rejects, so this cannot throw.
      if (previous) await previous;

      // The one place worth paying for a fresh probe: it is how someone who
      // has just installed the language server gets it running without
      // reloading the window.
      resolver.forget();
      missing = false;

      // Drop the old client before resolving.  Its executable path is baked
      // in, so it cannot be reused if the resolution has moved, and leaving it
      // running while reporting "not found" would be a lie.
      await discardClient();

      const resolved = await resolveClient();
      if (!resolved) {
        reportNotFound();
        return;
      }

      client = resolved;
      await resolved.start();
      started = true;
    });
  };

  // Goes through run() like the others, so it queues behind an in-flight start
  // instead of tearing the client out from under it, and so a failure to shut
  // down is reported rather than left as an unhandled rejection.
  const stop = () => {
    const previous = pending;
    return run(async () => {
      if (previous) await previous;
      await discardClient();
    }, reportStopError);
  };

  return {
    start,
    restart,
    stop,
    dispose() {
      void stop();
    },
  };
}
