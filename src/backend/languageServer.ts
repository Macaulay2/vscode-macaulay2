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
  /** Maximum time to wait for the LSP initialize handshake. */
  startTimeoutMilliseconds?: number;
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

interface OperationCancellation {
  readonly cancelled: boolean;
  readonly whenCancelled: Promise<void>;
  cancel(): void;
}

function createOperationCancellation(): OperationCancellation {
  let cancelled = false;
  let resolveCancellation: () => void;
  const whenCancelled = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });

  return {
    get cancelled() {
      return cancelled;
    },
    whenCancelled,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      resolveCancellation();
    },
  };
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
    startTimeoutMilliseconds = 30_000,
  } = options;

  let client: LanguageServerClient | undefined;
  let started = false;
  // A configuration change should only start a server after an editor event or
  // explicit restart has asked for one.  This keeps global settings changes
  // from launching a server in every window activated by onStartupFinished.
  let demanded = false;
  // A conclusive miss suppresses editor-driven starts until an explicit
  // restart or configuration change invalidates the resolution.
  let missing = false;
  let pending: Promise<void> | undefined;
  let pendingStart: Promise<void> | undefined;
  let pendingToken = 0;
  const cancellableOperations = new Set<OperationCancellation>();

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

  const trackCancellation = () => {
    const cancellation = createOperationCancellation();
    cancellableOperations.add(cancellation);
    return cancellation;
  };

  const cancelCancellableOperations = () => {
    for (const cancellation of cancellableOperations) {
      cancellation.cancel();
    }

    // A later start must queue behind the interrupting operation rather than
    // coalescing with the start that operation just cancelled.
    pendingStart = undefined;
  };

  const runCancellable = (
    cancellation: OperationCancellation,
    work: () => Promise<void>,
  ) =>
    run(async () => {
      try {
        if (!cancellation.cancelled) await work();
      } catch (error) {
        if (!cancellation.cancelled) throw error;
      } finally {
        cancellableOperations.delete(cancellation);
      }
    });

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

  const disposeUnusedClient = async (candidate: LanguageServerClient) => {
    try {
      await candidate.dispose();
    } catch {
      // Preserve the lifecycle result that made this candidate unused.
    }
  };

  // Cancelling a start is different from stopping a running client.  The real
  // vscode-languageclient rejects stop()/dispose() while it is Starting, but
  // its node adapter still uses those calls to terminate the child process.
  // Try both operations, suppressing the expected state error; the managed
  // client returned by client.ts guarantees its VS Code resources are released.
  const abandonStartingClient = async (candidate: LanguageServerClient) => {
    if (client === candidate) client = undefined;
    started = false;

    try {
      await candidate.stop();
    } catch {
      // Starting clients cannot be stopped through the base client API.
    }

    await disposeUnusedClient(candidate);
  };

  const startClient = async (
    candidate: LanguageServerClient,
    cancellation: OperationCancellation,
  ) => {
    if (cancellation.cancelled) {
      await disposeUnusedClient(candidate);
      return;
    }

    client = candidate;
    const completion = (async () => {
      try {
        await candidate.start();
        return { state: "started" } as const;
      } catch (error) {
        return { state: "failed", error } as const;
      }
    })();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ state: "timedOut" }>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve({ state: "timedOut" }),
        Math.max(0, startTimeoutMilliseconds),
      );
    });
    const outcome = await Promise.race([
      completion,
      cancellation.whenCancelled.then(() => ({ state: "cancelled" }) as const),
      timeout,
    ]);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

    const stopLateSuccessfulStart = () => {
      void completion.then(async (lateOutcome) => {
        if (lateOutcome.state !== "started") return;
        try {
          await candidate.stop();
        } catch {
          // The process termination scheduled during abandonment is the
          // fallback when a late client cannot be stopped gracefully.
        }
        await disposeUnusedClient(candidate);
      });
    };

    if (outcome.state === "cancelled" || outcome.state === "timedOut") {
      stopLateSuccessfulStart();
      await abandonStartingClient(candidate);
      if (outcome.state === "timedOut" && !cancellation.cancelled) {
        throw new Error(
          `Macaulay2 Language Server did not finish starting within ${startTimeoutMilliseconds} ms.`,
        );
      }
      return;
    }

    if (outcome.state === "failed") {
      client = undefined;
      started = false;
      await disposeUnusedClient(candidate);
      if (!cancellation.cancelled) throw outcome.error;
      return;
    }

    if (cancellation.cancelled) {
      await abandonStartingClient(candidate);
      return;
    }

    started = true;
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
  const replaceClient = async (
    announceMissing: boolean,
    cancellation: OperationCancellation,
  ) => {
    const resolved = await resolveClient();
    if (cancellation.cancelled) {
      if (resolved.state === "resolved") {
        await disposeUnusedClient(resolved.client);
      }
      return;
    }

    if (resolved.state === "timedOut") return;

    if (resolved.state === "missing") {
      if (!(await discardClientAndReport())) return;
      if (!cancellation.cancelled && announceMissing) reportNotFound();
      return;
    }

    if (!(await discardClientAndReport())) {
      // Resolution creates a candidate before touching the healthy client so
      // load failures preserve it.  If old-client teardown fails, the unused
      // candidate still needs to be released.
      await disposeUnusedClient(resolved.client);
      return;
    }

    if (cancellation.cancelled) {
      await disposeUnusedClient(resolved.client);
      return;
    }
    await startClient(resolved.client, cancellation);
  };

  const start = () => {
    demanded = true;
    if (pendingStart) return pendingStart;

    const cancellation = trackCancellation();
    const task = runCancellable(cancellation, async () => {
      if (started || missing || !isEnabled()) return;

      const resolved = await resolveClient();
      if (cancellation.cancelled) {
        if (resolved.state === "resolved") {
          await disposeUnusedClient(resolved.client);
        }
        return;
      }
      if (resolved.state !== "resolved") return;
      await startClient(resolved.client, cancellation);
    });
    pendingStart = task;
    const clearPendingStart = () => {
      if (pendingStart === task) pendingStart = undefined;
    };
    void task.then(clearPendingStart, clearPendingStart);
    return task;
  };

  const restart = () => {
    demanded = true;
    cancelCancellableOperations();
    const cancellation = trackCancellation();
    return runCancellable(cancellation, async () => {
      if (!isEnabled()) {
        reportDisabled();
        return;
      }

      resolver.forget();
      missing = false;
      await replaceClient(true, cancellation);
    });
  };

  const configurationChanged = () => {
    cancelCancellableOperations();
    const cancellation = trackCancellation();
    return runCancellable(cancellation, async () => {
      // Either setting can make the cached resolution stale.  Clearing it here
      // also lets re-enabling discover a server installed while disabled.
      resolver.forget();
      missing = false;

      if (!isEnabled()) {
        await discardClientAndReport();
        return;
      }

      if (!demanded) return;

      // Setting changes are already visible user actions, but a missing server
      // remains silent here just as it is for editor-driven start().
      await replaceClient(false, cancellation);
    });
  };

  const stop = () => {
    demanded = false;
    cancelCancellableOperations();
    return run(discardClient, reportStopError);
  };

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
