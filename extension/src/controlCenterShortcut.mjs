// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

const exec = promisify(execFile);
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
export function shortcutScript({ installDir, directory, desktop = false, remove = false }) {
  const target = join(installDir, "weft.cmd");
  return `$ErrorActionPreference='Stop'
$directory=${directory ? quote(directory) : `[Environment]::GetFolderPath('${desktop ? "Desktop" : "Programs"}')`}
$link=Join-Path $directory 'Weft Control Center.lnk'
$target=${quote(target)}
$shell=New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $link) {
  $existing=$shell.CreateShortcut($link)
  if ($existing.TargetPath -ne $env:ComSpec -or $existing.Arguments -ne ('/c ""'+$target+'" ui"')) {
    throw 'An unrelated shortcut uses this name. It was not modified.'
  }
}
${remove ? "if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link }" : `New-Item -ItemType Directory -Force -Path $directory | Out-Null
$shortcut=$shell.CreateShortcut($link)
$shortcut.TargetPath=$env:ComSpec
$shortcut.Arguments='/c ""'+$target+'" ui"'
$shortcut.WorkingDirectory=${quote(installDir)}
$shortcut.Description='Open the local Weft Control Center. Workloads remain independent.'
$shortcut.WindowStyle=7
$icon=Join-Path ${quote(installDir)} 'weft-control-center.ico'
if (Test-Path -LiteralPath $icon) { $shortcut.IconLocation=$icon }
$shortcut.Save()`}
`;
}
export async function installControlCenterShortcut({
  installDir, desktop = false,
  directory,
  execute = exec,
} = {}) {
  if (process.platform !== "win32") return { supported: false };
  if (typeof __WEFT_CONTROL_ICON__ === "string") {
    const png = Buffer.from(__WEFT_CONTROL_ICON__, "base64");
    const header = Buffer.alloc(22);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    header[6] = header[7] = 192;
    header.writeUInt16LE(1, 10);
    header.writeUInt16LE(32, 12);
    header.writeUInt32LE(png.length, 14);
    header.writeUInt32LE(22, 18);
    await writeFile(join(installDir, "weft-control-center.ico"), Buffer.concat([header, png]));
  }
  const script = shortcutScript({ installDir, directory, desktop });
  await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 10_000 });
  return { supported: true };
}
