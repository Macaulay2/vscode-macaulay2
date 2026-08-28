import * as fs from "fs";
import * as path from "path";

import { execFileSync } from "child_process";

export interface M2ExecutableResolution {
  executablePath: string;
  source: string;
  wslExecutablePath?: string;
  wslDistroName?: string;
}

export interface M2LaunchConfiguration {
  executablePath: string;
  args: string[];
  cwd?: string;
}

export interface CommandExecutableResolution {
  executablePath: string;
  source: string;
  args?: string[];
}

export type M2LaunchArgsConfiguration = string | undefined;

export interface CommandProbe {
  resolution?: CommandExecutableResolution;
  timedOut: boolean;
}

interface ShellProbe {
  executablePath?: string;
  timedOut: boolean;
}

export interface ShellCommandResult {
  output?: string;
  timedOut: boolean;
}

interface ShellCommandExecutionOptions {
  encoding: "utf8";
  stdio: ["ignore", "pipe", "ignore"];
  timeout?: number;
  killSignal: "SIGKILL";
}

export type ShellCommandExecutor = (
  executablePath: string,
  args: string[],
  options: ShellCommandExecutionOptions,
) => string;

export type ShellCommandRunner = (
  executablePath: string,
  args: string[],
  timeout?: number,
) => ShellCommandResult;

export interface CachedCommandResolver {
  // Returns the probe rather than just the resolution: callers that stop
  // asking after a negative answer need to know whether it was conclusive.
  resolve(): CommandProbe;
  forget(): void;
}

// Every shell probe below runs synchronously on the extension host thread, so
// none of them may wait indefinitely.  A login shell that sources nvm, conda,
// or pyenv is routinely a few hundred milliseconds, and a misconfigured one can
// block outright.  Same budget the WSL probes use.
const shellProbeTimeoutMilliseconds = 5000;

/**
 * Resolve a command once and remember the answer, "not found" included.
 *
 * Resolution is expensive: on Windows it shells out to Cygwin bash and wsl.exe,
 * and elsewhere it may spawn a login shell.  Callers driven by editor events
 * would otherwise pay that cost on every tab switch, and the "not installed"
 * case is the one that pays it every single time -- there is no successful
 * lookup to stop the retries.
 *
 * Timeouts are remembered too.  Retrying a synchronous probe from every editor
 * event would replace one unlucky delay with a five-second stall on every tab
 * switch.  `forget` is the explicit retry path, both for a timeout and for an
 * executable installed after the extension activated.
 */
export function createCachedCommandResolver(
  command: string,
  probe: (command: string) => CommandProbe = probeCommandExecutable,
): CachedCommandResolver {
  // The box distinguishes "looked, found nothing" from "not looked yet".
  let cached: { probe: CommandProbe } | undefined;

  return {
    resolve() {
      if (cached) {
        return cached.probe;
      }

      const result = probe(command);
      cached = { probe: result };
      return result;
    },
    forget() {
      cached = undefined;
    },
  };
}

export function resolveCommandExecutable(
  command: string,
): CommandExecutableResolution | undefined {
  return probeCommandExecutable(command).resolution;
}

/**
 * Resolve a command, reporting whether a shell probe ran out of time.
 *
 * A timeout is not the same answer as "not installed" -- the command may well
 * be there behind a shell that was merely slow -- so callers need to preserve
 * that distinction even when they cache the result until an explicit retry.
 */
export function probeCommandExecutable(command: string): CommandProbe {
  const fromPath = findCommandOnPath(command);
  if (fromPath) {
    return {
      resolution: { executablePath: fromPath, source: "PATH" },
      timedOut: false,
    };
  }

  if (process.platform === "win32") {
    return probeWindowsCommandExecutable(command);
  }

  const fromLoginShell = resolveCommandWithLoginShell(command);
  if (fromLoginShell.executablePath) {
    return {
      resolution: {
        executablePath: fromLoginShell.executablePath,
        source: "login shell PATH",
      },
      timedOut: false,
    };
  }

  return { timedOut: fromLoginShell.timedOut };
}

export function probeWindowsCommandExecutable(
  command: string,
  probeCygwin: (command: string) => ShellProbe = resolveCommandWithCygwinShell,
  probeWsl: (command: string) => CommandProbe = probeCommandWithWsl,
): CommandProbe {
  const fromCygwinShell = probeCygwin(command);
  if (fromCygwinShell.executablePath) {
    return {
      resolution: {
        executablePath: fromCygwinShell.executablePath,
        source: "Cygwin shell",
      },
      timedOut: false,
    };
  }

  const fromWsl = probeWsl(command);
  if (fromWsl.resolution) {
    return fromWsl;
  }

  return { timedOut: fromCygwinShell.timedOut || fromWsl.timedOut };
}

export function resolveM2Executable(
  configuredPath?: string,
): M2ExecutableResolution | undefined {
  const manualPath = normalizeConfiguredPath(configuredPath);
  if (manualPath) {
    const manualWslResolution = resolveManualWslExecutable(manualPath);
    if (manualWslResolution) {
      return manualWslResolution;
    }

    return { executablePath: manualPath, source: "setting" };
  }

  const fromPath = findCommandOnPath("M2");
  if (fromPath) {
    return { executablePath: fromPath, source: "PATH" };
  }

  if (process.platform === "win32") {
    const fromCygwinShell = resolveWithCygwinShell();
    if (fromCygwinShell) {
      return {
        executablePath: fromCygwinShell,
        source: "Cygwin shell",
      };
    }

    const fromKnownLocation = firstExistingExecutable(getWindowsCandidates());
    if (fromKnownLocation) {
      return {
        executablePath: fromKnownLocation,
        source: "common Windows install location",
      };
    }

    const fromWsl = resolveWithWsl();
    if (fromWsl) {
      return fromWsl;
    }

    return undefined;
  }

  const fromLoginShell = resolveWithLoginShell();
  if (fromLoginShell) {
    return {
      executablePath: fromLoginShell,
      source: "login shell PATH",
    };
  }

  const fromKnownLocation = firstExistingExecutable(getUnixCandidates());
  if (fromKnownLocation) {
    return {
      executablePath: fromKnownLocation,
      source: "common install location",
    };
  }

  return undefined;
}

export function getM2LaunchConfiguration(
  resolution: M2ExecutableResolution,
  args: string[],
  workingDir: string,
  additionalArgs: M2LaunchArgsConfiguration = "",
): M2LaunchConfiguration {
  const m2Args = [...args, ...normalizeM2LaunchArgs(additionalArgs)];

  if (resolution.wslExecutablePath) {
    return {
      executablePath: resolution.executablePath,
      args: [
        "--cd",
        windowsPathToWslPath(workingDir) || "~",
        "--exec",
        resolution.wslExecutablePath,
        ...m2Args,
      ],
    };
  }

  return {
    executablePath: resolution.executablePath,
    args: m2Args,
    cwd: workingDir,
  };
}

export function normalizeM2LaunchArgs(
  args: M2LaunchArgsConfiguration,
): string[] {
  if (!args?.trim()) {
    return [];
  }

  return splitM2LaunchArgs(args);
}

function splitM2LaunchArgs(args: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: string | undefined;
  let escaping = false;
  let tokenStarted = false;

  for (const char of args.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      tokenStarted = true;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        result.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (escaping) {
    current += "\\";
  }
  if (tokenStarted) {
    result.push(current);
  }

  return result;
}

export function getM2ExecutableResolutionDetail(
  resolution: M2ExecutableResolution,
): string {
  if (resolution.wslExecutablePath) {
    return `${resolution.executablePath} --exec ${resolution.wslExecutablePath}`;
  }

  return resolution.executablePath;
}

export function windowsPathToWslPath(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const wslUncMatch = normalizedPath.match(
    /^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(\/.*)?$/i,
  );
  if (wslUncMatch) {
    return wslUncMatch[1] || "/";
  }

  const driveMatch = normalizedPath.match(/^([a-zA-Z]):\/?(.*)$/);
  if (!driveMatch) {
    return normalizedPath;
  }

  const [, drive, rest] = driveMatch;
  const suffix = rest ? `/${rest.replace(/^\/+/, "")}` : "";
  return `/mnt/${drive.toLowerCase()}${suffix}`;
}

export function wslPathToWindowsPath(
  filePath: string,
  distroName?: string,
  wslHostExecutablePath?: string,
): string | undefined {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const driveMatch = normalizedPath.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (driveMatch) {
    const [, drive, rest] = driveMatch;
    return `${drive.toUpperCase()}:\\${rest ? rest.replace(/\//g, "\\") : ""}`;
  }

  if (!isUnixAbsolutePath(normalizedPath)) {
    return undefined;
  }

  const wslPath = wslHostExecutablePath
    ? resolveWslWindowsPath(wslHostExecutablePath, normalizedPath)
    : undefined;
  if (wslPath) {
    return wslPath;
  }

  if (!distroName) {
    return undefined;
  }

  const suffix =
    normalizedPath === "/" ? "\\" : normalizedPath.replace(/\//g, "\\");
  return `\\\\wsl$\\${distroName}${suffix}`;
}

function normalizeConfiguredPath(configuredPath?: string): string | undefined {
  const trimmed = configuredPath?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveManualWslExecutable(
  configuredPath: string,
): M2ExecutableResolution | undefined {
  if (process.platform !== "win32" || !isUnixAbsolutePath(configuredPath)) {
    return undefined;
  }

  const wslPath = findWslExecutable();
  if (!wslPath) {
    return undefined;
  }

  return {
    executablePath: wslPath,
    source: "setting via WSL",
    wslExecutablePath: configuredPath,
    wslDistroName: resolveWslDistroName(wslPath),
  };
}

function resolveWithLoginShell(): string | undefined {
  return resolveCommandWithLoginShell("M2").executablePath;
}

function resolveCommandWithLoginShell(command: string): ShellProbe {
  const shell = getEnv("SHELL");
  if (!shell || !path.isAbsolute(shell) || !fs.existsSync(shell)) {
    return { timedOut: false };
  }

  const result = runShellCommand(
    shell,
    ["-l", "-c", `command -v ${quoteShellWord(command)}`],
    shellProbeTimeoutMilliseconds,
  );
  if (result.output && isExecutableFile(result.output)) {
    return { executablePath: result.output, timedOut: false };
  }

  return { timedOut: result.timedOut };
}

function resolveWithCygwinShell(): string | undefined {
  return resolveCommandWithCygwinShell("M2").executablePath;
}

function resolveCommandWithCygwinShell(command: string): ShellProbe {
  const bashCandidates = [
    findCommandOnPath("bash"),
    ...getWindowsCandidateRoots().map((root) =>
      path.join(root, "bin", "bash.exe"),
    ),
  ];

  // The timeout bounds one spawn, and there can be a dozen candidates here, so
  // budget the loop as a whole rather than letting the worst case add up.
  const deadline = Date.now() + shellProbeTimeoutMilliseconds;

  for (const bashPath of dedupe(bashCandidates)) {
    if (!bashPath || !isExecutableFile(bashPath)) {
      continue;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { timedOut: true };
    }

    const quotedCommand = quoteShellWord(command);
    const result = runShellCommand(
      bashPath,
      [
        "-lc",
        `if command -v ${quotedCommand} >/dev/null 2>&1; then cygpath -wa "$(command -v ${quotedCommand})"; fi`,
      ],
      remaining,
    );
    if (result.output && isExecutableFile(result.output)) {
      return { executablePath: result.output, timedOut: false };
    }
    if (result.timedOut) {
      return { timedOut: true };
    }
  }

  return { timedOut: false };
}

function resolveWithWsl(): M2ExecutableResolution | undefined {
  const resolved = probeCommandWithWsl("M2").resolution;
  if (!resolved?.args || resolved.args.length < 2) {
    return undefined;
  }

  return {
    executablePath: resolved.executablePath,
    source: resolved.source,
    wslExecutablePath: resolved.args[1],
    wslDistroName: resolveWslDistroName(resolved.executablePath),
  };
}

export function probeCommandWithWsl(
  command: string,
  findWsl: () => string | undefined = findWslExecutable,
  run: ShellCommandRunner = runShellCommand,
): CommandProbe {
  const wslPath = findWsl();
  if (!wslPath) {
    return { timedOut: false };
  }

  const result = run(
    wslPath,
    ["--exec", "sh", "-lc", `command -v ${quoteShellWord(command)}`],
    shellProbeTimeoutMilliseconds,
  );
  const wslExecutablePath = normalizeShellOutputPath(result.output);
  if (!wslExecutablePath || !isUnixAbsolutePath(wslExecutablePath)) {
    return { timedOut: result.timedOut };
  }

  return {
    resolution: {
      executablePath: wslPath,
      source: "WSL",
      args: ["--exec", wslExecutablePath],
    },
    timedOut: false,
  };
}

function resolveWslDistroName(wslPath: string): string | undefined {
  const envDistroName = normalizeShellOutputPath(
    runShellCommandOutput(
      wslPath,
      ["--exec", "sh", "-lc", 'printf "%s" "$WSL_DISTRO_NAME"'],
      shellProbeTimeoutMilliseconds,
    ),
  );
  if (envDistroName) {
    return envDistroName;
  }

  const windowsRoot = resolveWslWindowsPath(wslPath, "/");
  const rootMatch = windowsRoot?.match(
    /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\|$)/i,
  );
  return rootMatch?.[1];
}

function resolveWslWindowsPath(
  wslHostExecutablePath: string,
  filePath: string,
): string | undefined {
  return normalizeShellOutputPath(
    runShellCommandOutput(
      wslHostExecutablePath,
      ["--exec", "wslpath", "-w", filePath],
      shellProbeTimeoutMilliseconds,
    ),
  );
}

function findWslExecutable(): string | undefined {
  return firstExistingExecutable([
    findCommandOnPath("wsl"),
    getWindowsSystemExecutable("wsl.exe"),
  ]);
}

const defaultShellCommandExecutor: ShellCommandExecutor = (
  executablePath,
  args,
  options,
) => execFileSync(executablePath, args, options);

export function runShellCommand(
  shellPath: string,
  args: string[],
  timeout?: number,
  execute: ShellCommandExecutor = defaultShellCommandExecutor,
): ShellCommandResult {
  try {
    const output = execute(shellPath, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
      // execFileSync waits after a timeout until the child actually exits.
      // SIGTERM can be trapped or ignored, so it does not impose a hard bound
      // on this synchronous extension-host work.
      killSignal: "SIGKILL",
    }).trim();
    return { output: output || undefined, timedOut: false };
  } catch (error) {
    return { timedOut: isTimeoutError(error) };
  }
}

function runShellCommandOutput(
  shellPath: string,
  args: string[],
  timeout?: number,
): string | undefined {
  return runShellCommand(shellPath, args, timeout).output;
}

// A probe that ran out of time is not the same answer as a probe that came
// back empty, and callers that cache their result need to tell them apart.
// execFileSync kills the child and rethrows on expiry; Node reports that as
// ETIMEDOUT, or as the kill signal.
function isTimeoutError(error: unknown): boolean {
  const failure = error as
    | (NodeJS.ErrnoException & { signal?: NodeJS.Signals | null })
    | undefined;
  return failure?.code === "ETIMEDOUT" || failure?.signal === "SIGKILL";
}

function normalizeShellOutputPath(
  output: string | undefined,
): string | undefined {
  return output
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function quoteShellWord(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function findCommandOnPath(command: string): string | undefined {
  for (const candidate of getPathCandidates(command)) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function getPathCandidates(command: string): string[] {
  if (isPathLike(command)) {
    return expandWindowsExecutableNames(command);
  }

  const pathValue = getEnv("PATH");
  if (!pathValue) {
    return [];
  }

  const candidates: string[] = [];
  for (const dir of pathValue.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) {
      continue;
    }

    for (const name of expandWindowsExecutableNames(command)) {
      candidates.push(path.join(trimmed, name));
    }
  }

  return dedupe(candidates);
}

function getUnixCandidates(): string[] {
  if (process.platform === "darwin") {
    return ["/opt/homebrew/bin/M2", "/usr/local/bin/M2"];
  }

  return [];
}

function getWindowsCandidates(): string[] {
  const candidates: string[] = [];
  for (const root of getWindowsCandidateRoots()) {
    candidates.push(path.join(root, "bin", "M2.exe"));
  }

  return dedupe(candidates);
}

function getWindowsCandidateRoots(): string[] {
  const roots = new Set<string>();
  const systemDrive = getEnv("SystemDrive") || "C:";
  const baseRoots = [
    systemDrive,
    getEnv("ProgramFiles"),
    getEnv("ProgramFiles(x86)"),
  ];

  for (const baseRoot of baseRoots) {
    if (!baseRoot) {
      continue;
    }

    roots.add(path.join(baseRoot, "cygwin64"));
    roots.add(path.join(baseRoot, "cygwin"));
    roots.add(path.join(baseRoot, "tools", "cygwin64"));
    roots.add(path.join(baseRoot, "tools", "cygwin"));
  }

  return Array.from(roots);
}

function getWindowsSystemExecutable(
  executableName: string,
): string | undefined {
  const systemRoot =
    getEnv("SystemRoot") || path.join(getEnv("SystemDrive") || "C:", "Windows");
  return path.join(systemRoot, "System32", executableName);
}

function expandWindowsExecutableNames(command: string): string[] {
  if (process.platform !== "win32") {
    return [command];
  }

  const extension = path.extname(command);
  if (extension) {
    return [command];
  }

  const pathext = getEnv("PATHEXT");
  const extensions = pathext
    ? pathext
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean)
    : [".COM", ".EXE", ".BAT", ".CMD"];

  const candidates = [command];
  for (const ext of extensions) {
    candidates.push(command + ext.toLowerCase());
    candidates.push(command + ext.toUpperCase());
  }

  return dedupe(candidates);
}

function firstExistingExecutable(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stats = fs.statSync(candidate);
    if (!stats.isFile()) {
      return false;
    }

    if (process.platform === "win32") {
      return true;
    }

    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isPathLike(value: string): boolean {
  return path.isAbsolute(value) || /[\\/]/.test(value);
}

function isUnixAbsolutePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}

function getEnv(name: string): string | undefined {
  if (process.platform !== "win32") {
    return process.env[name];
  }

  const lowerName = name.toLowerCase();
  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase() === lowerName) {
      return process.env[key];
    }
  }

  return undefined;
}

function dedupe(values: Array<string | undefined>): string[] {
  const result = new Set<string>();
  for (const value of values) {
    if (value) {
      result.add(value);
    }
  }
  return Array.from(result);
}
