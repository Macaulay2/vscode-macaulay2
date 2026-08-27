import * as path from "path";
import * as vscode from "vscode";

import {
  getM2ExecutableResolutionDetail,
  M2ExecutableResolution,
  resolveM2Executable,
} from "./executablePath";

const CONFIG_SECTION = "macaulay2";
const EXECUTABLE_PATH_SETTING = "executablePath";
const EXECUTABLE_PATH_ALTERNATIVES_SETTING = "executablePathAlternatives";
const SHOW_EXECUTABLE_SWITCHER_SETTING = "showExecutableSwitcher";

interface M2ExecutableQuickPickItem extends vscode.QuickPickItem {
  executablePath?: string;
  browse?: boolean;
}

export function registerM2ExecutableSwitcher(
  context: vscode.ExtensionContext,
  onExecutableChanged: () => void | Promise<void>,
) {
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBarItem.command = "macaulay2.selectExecutablePath";
  context.subscriptions.push(statusBarItem);

  // This resolves the M2 executable, which is a synchronous, blocking probe:
  // it can spawn a login shell, or Cygwin bash and wsl.exe on Windows.  It is
  // cheap enough to leave uncached only because the triggers below are rare
  // and user-initiated.  Wiring it to a frequent event -- with
  // onDidChangeActiveTextEditor the tempting one -- would stall the extension
  // host on every tab switch, which is the bug language server discovery had.
  const updateStatusBarItem = () =>
    updateM2ExecutableSwitcherStatus(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "macaulay2.selectExecutablePath",
      async () => {
        const changed = await selectM2ExecutablePath();
        updateStatusBarItem();
        if (changed) {
          await onExecutableChanged();
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(
          `${CONFIG_SECTION}.${EXECUTABLE_PATH_SETTING}`,
        ) ||
        event.affectsConfiguration(
          `${CONFIG_SECTION}.${EXECUTABLE_PATH_ALTERNATIVES_SETTING}`,
        ) ||
        event.affectsConfiguration(
          `${CONFIG_SECTION}.${SHOW_EXECUTABLE_SWITCHER_SETTING}`,
        )
      ) {
        updateStatusBarItem();
      }
    }),
  );

  updateStatusBarItem();
}

function updateM2ExecutableSwitcherStatus(statusBarItem: vscode.StatusBarItem) {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  if (!config.get<boolean>(SHOW_EXECUTABLE_SWITCHER_SETTING, false)) {
    statusBarItem.hide();
    return;
  }

  const configuredPath = normalizeExecutablePath(
    config.get<string>(EXECUTABLE_PATH_SETTING),
  );
  const resolution = resolveM2Executable(configuredPath);

  statusBarItem.text = getM2ExecutableStatusText(configuredPath, resolution);
  statusBarItem.tooltip = getM2ExecutableStatusTooltip(
    configuredPath,
    resolution,
  );
  statusBarItem.show();
}

async function selectM2ExecutablePath(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const currentPath = normalizeExecutablePath(
    config.get<string>(EXECUTABLE_PATH_SETTING),
  );
  const alternatives = getConfiguredExecutablePathAlternatives(config);
  const selected = await vscode.window.showQuickPick(
    getM2ExecutableQuickPickItems(currentPath, alternatives),
    {
      placeHolder: "Select the Macaulay2 executable for new M2 sessions",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );

  if (!selected) {
    return false;
  }

  if (selected.browse) {
    const browsedPath = await browseForM2Executable();
    if (!browsedPath) {
      return false;
    }
    return updateM2ExecutablePath(browsedPath, true);
  }

  return updateM2ExecutablePath(selected.executablePath || "", false);
}

function getConfiguredExecutablePathAlternatives(
  config: vscode.WorkspaceConfiguration,
): string[] {
  const alternatives = config.get<string[]>(
    EXECUTABLE_PATH_ALTERNATIVES_SETTING,
    [],
  );
  return alternatives.map(normalizeExecutablePath).filter(Boolean);
}

function getM2ExecutableQuickPickItems(
  currentPath: string | undefined,
  alternatives: string[],
): M2ExecutableQuickPickItem[] {
  const autoResolution = resolveM2Executable("");
  const items: M2ExecutableQuickPickItem[] = [
    {
      label: "$(search) Auto-detect M2",
      description: currentPath ? "" : "Current",
      detail: autoResolution
        ? `Currently resolves to ${getM2ExecutableResolutionDetail(
            autoResolution,
          )}`
        : "No M2 executable found automatically",
      executablePath: "",
      picked: !currentPath,
    },
  ];

  for (const executablePath of getM2ExecutablePathOptions(
    currentPath,
    alternatives,
  )) {
    items.push({
      label: `$(file-binary) ${formatM2ExecutablePathForStatusBar(
        executablePath,
      )}`,
      description: executablePath === currentPath ? "Current" : "",
      detail: executablePath,
      executablePath,
      picked: executablePath === currentPath,
    });
  }

  items.push({
    label: "$(folder-opened) Browse...",
    description: "Select another M2 executable",
    browse: true,
  });

  return items;
}

export function getM2ExecutablePathOptions(
  currentPath: string | undefined,
  alternatives: string[],
): string[] {
  return dedupeExecutablePaths([
    normalizeExecutablePath(currentPath),
    ...alternatives.map(normalizeExecutablePath),
  ]);
}

async function browseForM2Executable(): Promise<string | undefined> {
  const selectedUris = await vscode.window.showOpenDialog({
    title: "Select M2 executable",
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
  });

  return selectedUris && selectedUris.length > 0
    ? selectedUris[0].fsPath
    : undefined;
}

async function updateM2ExecutablePath(
  executablePath: string,
  addToAlternatives: boolean,
): Promise<boolean> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const normalizedPath = normalizeExecutablePath(executablePath) || "";
  const currentPath =
    normalizeExecutablePath(config.get<string>(EXECUTABLE_PATH_SETTING)) || "";
  const changed = normalizedPath !== currentPath;

  if (changed) {
    await config.update(
      EXECUTABLE_PATH_SETTING,
      normalizedPath,
      vscode.ConfigurationTarget.Global,
    );
  }

  if (addToAlternatives && normalizedPath) {
    await addExecutablePathAlternative(config, normalizedPath);
  }

  return changed;
}

async function addExecutablePathAlternative(
  config: vscode.WorkspaceConfiguration,
  executablePath: string,
) {
  const alternatives = getConfiguredExecutablePathAlternatives(config);
  if (alternatives.includes(executablePath)) {
    return;
  }

  await config.update(
    EXECUTABLE_PATH_ALTERNATIVES_SETTING,
    dedupeExecutablePaths([...alternatives, executablePath]),
    vscode.ConfigurationTarget.Global,
  );
}

export function getM2ExecutableStatusText(
  configuredPath: string | undefined,
  resolution: M2ExecutableResolution | undefined,
): string {
  if (resolution?.wslExecutablePath) {
    return configuredPath
      ? `$(terminal) M2: WSL:${resolution.wslExecutablePath}`
      : `$(terminal) M2 auto: WSL:${resolution.wslExecutablePath}`;
  }

  const executablePath = configuredPath || resolution?.executablePath;
  if (!executablePath) {
    return "$(terminal) M2: not found";
  }

  const label = formatM2ExecutablePathForStatusBar(executablePath);
  return configuredPath
    ? `$(terminal) M2: ${label}`
    : `$(terminal) M2 auto: ${label}`;
}

function getM2ExecutableStatusTooltip(
  configuredPath: string | undefined,
  resolution: M2ExecutableResolution | undefined,
): string {
  if (configuredPath) {
    if (resolution?.wslExecutablePath) {
      return `Macaulay2 executable from ${resolution.source}: ${getM2ExecutableResolutionDetail(
        resolution,
      )}`;
    }

    return `Macaulay2 executable: ${configuredPath}`;
  }

  if (resolution) {
    return `Macaulay2 executable auto-detected from ${
      resolution.source
    }: ${getM2ExecutableResolutionDetail(resolution)}`;
  }

  return "Macaulay2 executable was not found. Click to choose an executable.";
}

export function formatM2ExecutablePathForStatusBar(executablePath: string) {
  const basename = path.basename(executablePath);
  if (!basename) {
    return executablePath;
  }

  const parentDir = path.dirname(executablePath);
  const parentName = path.basename(parentDir);
  if (!parentName || parentName === ".") {
    return basename;
  }

  const grandparentName = path.basename(path.dirname(parentDir));
  if (parentName.toLowerCase() === "bin" && grandparentName) {
    return `${grandparentName}/${parentName}/${basename}`;
  }

  return `${parentName}/${basename}`;
}

function normalizeExecutablePath(executablePath?: string): string | undefined {
  const trimmed = executablePath?.trim();
  return trimmed ? trimmed : undefined;
}

function dedupeExecutablePaths(
  executablePaths: Array<string | undefined>,
): string[] {
  const result: string[] = [];
  for (const executablePath of executablePaths) {
    if (!executablePath || result.includes(executablePath)) {
      continue;
    }
    result.push(executablePath);
  }
  return result;
}
