//
// Start/restart logic for the Macaulay2 language server, kept apart from
// activate() so it can be tested against fakes.
//
// Editor events may call start() repeatedly, configuration changes can stop or
// replace the client, and explicit restarts must re-run executable discovery.
// Every operation is serialized below so the final requested state wins without
// overlapping vscode-languageclient lifecycle calls.
//
// The client is created here rather than handed in, and only once a resolution
// has actually succeeded.  That keeps vscode-languageclient out of activation
// for anyone without a language server installed, and it means a client is
// always paired with the executable resolution it was built from.
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
  /** Apply the current enable/path settings without reloading the window. */
  configurationChanged(): Promise<void>;
  /** Shut the server down, for deactivate(). */
  stop(): Promise<void>;
  /** For context.subscriptions. */
  dispose(): void;
}

type ClientResolution =
  | { state: "resolved"; client: LanguageServerClient }
  | { state: "missing" }
  | { state: "timedOut" };

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

  let client: LanguageServerClient | undefined;
  let started = false;
  // A conclusive miss suppresses editor-driven starts until an explicit
  // restart or configuration change invalidates the resolution.
  let missing = false;
  let pending: Promise<void> | undefined;
  let pendingToken = 0;

  // Queue every lifecycle operation.  In particular, a start requested while
  // stop() is awaiting the language client's shutdown must run afterwards; it
  // cannot merely return the stop promise.
  const run = (
    work: () => Promise<void>,
    report: (error: unknown) => void = reportStartError,
  ): Promise<void> => {
    const previous = pending;
    const token = ++pendingToken;
    const task = (async () => {
      try {
        if (previous) await previous;
        await work();
      } catch (error) {
        report(error);
      } finally {
        if (pendingToken === token) pending = undefined;
      }
    })();

    pending = task;
    return task;
  };

  const resolveClient = async (): Promise<ClientResolution> => {
    const probe = resolver.resolve();
    if (!probe.resolution) {
      if (probe.timedOut) {
        missing = false;
        return { state: "timedOut" };
      }

      missing = true;
      return { state: "missing" };
    }

    missing = false;
    return {
      state: "resolved",
      client: await createClient(probe.resolution),
    };
  };

  const discardClient = async () => {
    const running = client;
    client = undefined;
    started = false;
    if (!running) return;

    let failure: { error: unknown } | undefined;
    try {
      await running.stop();
    } catch (error) {
      failure = { error };
    }

    try {
      await running.dispose();
    } catch (error) {
      // Preserve the stop failure when both cleanup operations fail.
      failure ??= { error };
    }

    if (failure) throw failure.error;
  };

  const startClient = async (candidate: LanguageServerClient) => {
    client = candidate;
    try {
      await candidate.start();
      started = true;
    } catch (error) {
      client = undefined;
      started = false;
      try {
        await candidate.dispose();
      } catch {
        // Preserve the start failure for the user; disposal is best effort.
      }
      throw error;
    }
  };

  const discardClientAndReport = async (): Promise<boolean> => {
    try {
      await discardClient();
      return true;
    } catch (error) {
      reportStopError(error);
      return false;
    }
  };

  // Build the replacement before stopping a healthy client.  A timeout (or a
  // failure to load/build the new client) therefore leaves the running server
  // alone.  A conclusive miss still tears it down before reporting the result.
  const replaceClient = async (announceMissing: boolean) => {
    const resolved = await resolveClient();
    if (resolved.state === "timedOut") return;

    if (resolved.state === "missing") {
      if (!(await discardClientAndReport())) return;
      if (announceMissing) reportNotFound();
      return;
    }

    if (!(await discardClientAndReport())) {
      // Resolution creates a candidate before touching the healthy client so
      // load failures preserve it.  If old-client teardown fails, the unused
      // candidate still needs to be released.
      try {
        await resolved.client.dispose();
      } catch {
        // Preserve the shutdown failure already reported above.
      }
      return;
    }
    await startClient(resolved.client);
  };

  const start = () =>
    run(async () => {
      if (started || missing || !isEnabled()) return;

      const resolved = await resolveClient();
      if (resolved.state !== "resolved") return;
      await startClient(resolved.client);
    });

  const restart = () =>
    run(async () => {
      if (!isEnabled()) {
        reportDisabled();
        return;
      }

      resolver.forget();
      missing = false;
      await replaceClient(true);
    });

  const configurationChanged = () =>
    run(async () => {
      // Either setting can make the cached resolution stale.  Clearing it here
      // also lets re-enabling discover a server installed while disabled.
      resolver.forget();
      missing = false;

      if (!isEnabled()) {
        await discardClientAndReport();
        return;
      }

      // Setting changes are already visible user actions, but a missing server
      // remains silent here just as it is for editor-driven start().
      await replaceClient(false);
    });

  const stop = () => run(discardClient, reportStopError);

  return {
    start,
    restart,
    configurationChanged,
    stop,
    dispose() {
      void stop();
    },
  };
}
