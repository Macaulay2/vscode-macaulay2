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

import {
  CachedCommandResolver,
  CommandExecutableResolution,
} from "./executablePath";

// The slice of vscode-languageclient's LanguageClient this needs, so tests do
// not have to construct one.
export interface LanguageServerClient {
  start(): Thenable<void>;
  stop(): Thenable<void>;
  restart(): Thenable<void>;
}

export interface LanguageServerControllerOptions {
  client: LanguageServerClient;
  resolver: CachedCommandResolver;
  configure(resolution: CommandExecutableResolution): void;
  isEnabled(): boolean;
  reportDisabled(): void;
  reportNotFound(): void;
  reportStartError(error: unknown): void;
}

export interface LanguageServerController {
  /** Idempotent and cheap to call from an editor event. */
  start(): Promise<void>;
  /** The "Macaulay2: Restart Language Server" command. */
  restart(): Promise<void>;
}

export function createLanguageServerController(
  options: LanguageServerControllerOptions,
): LanguageServerController {
  const {
    client,
    resolver,
    configure,
    isEnabled,
    reportDisabled,
    reportNotFound,
    reportStartError,
  } = options;

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
  const run = (work: () => Promise<void>): Promise<void> => {
    const token = ++pendingToken;
    const task = (async () => {
      try {
        await work();
      } catch (error) {
        reportStartError(error);
      } finally {
        // A restart that took the slot over while this was settling must keep
        // it, or a concurrent start would see an idle controller.
        if (pendingToken === token) pending = undefined;
      }
    })();

    pending = task;
    return task;
  };

  // Returns whether the language server is ready to be launched, and records a
  // conclusive "not installed" so the editor events stop asking.  A timeout is
  // kept distinct so restart() never tears down a healthy client because one
  // fresh lookup was inconclusive.
  const configureResolved = () => {
    const probe = resolver.resolve();
    if (!probe.resolution) {
      if (probe.timedOut) {
        missing = false;
        return "timedOut" as const;
      }

      missing = true;
      return "missing" as const;
    }

    missing = false;
    configure(probe.resolution);
    return "resolved" as const;
  };

  const start = () => {
    if (started || missing || !isEnabled()) return Promise.resolve();
    if (pending) return pending;

    return run(async () => {
      if (configureResolved() !== "resolved") return;

      await client.start();
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

      const resolutionState = configureResolved();
      if (resolutionState === "timedOut") {
        // A timeout says nothing about whether the executable still exists.
        // Keep a running client alive, and let the next explicit restart retry.
        return;
      }

      if (resolutionState === "missing") {
        // The executable has gone since it was last resolved.  Leaving the old
        // client running while telling the user it was not found would be a
        // lie, and start() would then short-circuit on `started` forever.
        if (started) {
          await client.stop();
          started = false;
        }
        reportNotFound();
        return;
      }

      try {
        if (started) {
          await client.restart();
        } else {
          await client.start();
          started = true;
        }
      } catch (error) {
        // A failed restart leaves the client in no state to be reused, so let
        // a later start() try again from scratch rather than assuming it runs.
        started = false;
        throw error;
      }
    });
  };

  return { start, restart };
}
