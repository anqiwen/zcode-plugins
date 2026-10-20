import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceError, resolveExternalFile } from "./workspace.js";

const PICK_TIMEOUT_MS = 5 * 60 * 1000;

function run(
  command: string,
  args: string[],
  timeout = PICK_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const message =
            (stderr || error.message || String(error)).toString().trim();
          reject(
            new WorkspaceError(
              "picker_failed",
              message || "系统文件选择器打开失败",
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

async function pickWindows(): Promise<string | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "document-reviewer-pick-"));
  const scriptPath = path.join(dir, "pick.ps1");
  const outPath = path.join(dir, "picked.txt");
  const script = `param([string]$OutPath)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '选择要批注的文档'
$dialog.Filter = '支持的文档|*.md;*.markdown;*.txt;*.pdf;*.docx|所有文件|*.*'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
$dialog.RestoreDirectory = $true
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [System.IO.File]::WriteAllText($OutPath, $dialog.FileName, [System.Text.Encoding]::UTF8)
} else {
  [System.IO.File]::WriteAllText($OutPath, '', [System.Text.Encoding]::UTF8)
}
`;
  try {
    await fs.writeFile(scriptPath, `\uFEFF${script}`, "utf8");
    try {
      await run("powershell.exe", [
        "-STA",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        outPath,
      ]);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      // Some installations only expose PowerShell 7 as pwsh.exe.
      await run("pwsh.exe", [
        "-STA",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        outPath,
      ]);
    }
    const picked = (await fs.readFile(outPath, "utf8")).trim();
    return picked || null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function pickMac(): Promise<string | null> {
  const { stdout } = await run("osascript", [
    "-e",
    'POSIX path of (choose file with prompt "选择要批注的文档")',
  ]);
  return stdout.trim() || null;
}

async function pickLinux(): Promise<string | null> {
  try {
    const { stdout } = await run("zenity", [
      "--file-selection",
      "--title=选择要批注的文档",
      "--file-filter=支持的文档 | *.md *.markdown *.txt *.pdf *.docx",
    ]);
    return stdout.trim() || null;
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "picker_failed") {
      const { stdout } = await run("kdialog", [
        "--getopenfilename",
        ".",
        "*.md *.markdown *.txt *.pdf *.docx",
      ]);
      return stdout.trim() || null;
    }
    throw error;
  }
}

/**
 * Opens the host OS file picker. The returned path is canonical (realpath)
 * and validated as a supported document. Returns null when the user cancels.
 */
export async function pickExternalDocument(): Promise<string | null> {
  const testPath = process.env.ZCODE_TEST_PICK_FILE;
  if (testPath) {
    const real = await resolveExternalFile(testPath);
    return real.replace(/\\/g, "/");
  }

  let picked: string | null = null;
  if (process.platform === "win32") picked = await pickWindows();
  else if (process.platform === "darwin") picked = await pickMac();
  else picked = await pickLinux();

  if (!picked) return null;
  const real = await resolveExternalFile(picked);
  return real.replace(/\\/g, "/");
}
