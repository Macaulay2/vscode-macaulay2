import { Uri } from "vscode";
import type { LanguageClientOptions } from "vscode-languageclient/node";
import {
  CommandExecutableResolution,
  windowsPathToWslPath,
  wslPathToWindowsPath,
} from "./executablePath";

/** Translate file locations at the Windows/WSL language-server boundary. */
export function createLanguageServerUriConverters(
  resolution: CommandExecutableResolution,
): LanguageClientOptions["uriConverters"] {
  if (!resolution.wslExecutablePath) return undefined;

  return {
    code2Protocol(uri) {
      if (uri.scheme !== "file") return uri.toString();

      if (/^(?:wsl\$|wsl\.localhost)$/i.test(uri.authority)) {
        const match = /^\/([^/]+)(\/.*)?$/.exec(uri.path);
        if (
          !match ||
          !resolution.wslDistroName ||
          match[1].toLowerCase() !== resolution.wslDistroName.toLowerCase()
        ) {
          return uri.toString();
        }
        return uri.with({ authority: "", path: match[2] || "/" }).toString();
      }

      // Leave other UNC hosts and non-Windows paths alone. Work from URI
      // components instead of fsPath so conversion is independent of the host
      // running these tests and preserves escaped characters, query and fragment.
      if (uri.authority || !/^\/[a-zA-Z]:\//.test(uri.path))
        return uri.toString();
      return uri
        .with({ path: windowsPathToWslPath(uri.path.substring(1)) })
        .toString();
    },
    protocol2Code(value) {
      const uri = Uri.parse(value);
      if (
        uri.scheme !== "file" ||
        uri.authority ||
        !uri.path.startsWith("/") ||
        /^\/[a-zA-Z]:\//.test(uri.path)
      ) {
        return uri;
      }

      // With a known distro this is a pure conversion. If distro discovery
      // failed, wslpath can still resolve a definition on explicit navigation.
      const windowsPath = wslPathToWindowsPath(
        uri.path,
        resolution.wslDistroName,
        resolution.wslDistroName ? undefined : resolution.executablePath,
      );
      if (!windowsPath) return uri;
      const normalized = windowsPath.replace(/\\/g, "/");
      const unc = /^\/\/([^/]+)(\/.*)$/.exec(normalized);
      return unc
        ? uri.with({ authority: unc[1], path: unc[2] })
        : uri.with({ authority: "", path: `/${normalized}` });
    },
  };
}
