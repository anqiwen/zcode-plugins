#!/usr/bin/env node
import { AppError, describeError } from "./server/errors.js";
import { resolveDataDir } from "./server/paths.js";
import { UsageService } from "./server/service.js";

const HELP = `OpenCode Go Usage — 主机凭据与账号管理 CLI

用法:
  node cli.mjs --data-dir <插件数据目录> <命令> [参数]

命令:
  add [--label 名称]          添加账号（API Key 从终端隐藏输入或 stdin 读取）
  list                        列出账号（只显示指纹，不显示 Key）
  test [账号ID]               立即请求用量接口验证
  rename <账号ID> <新名称>    重命名
  remove <账号ID|指纹前缀>    删除账号及其凭据
  import-env                  导入 OPENCODE_GO_API_KEY 等环境变量账号
  path                        打印当前使用的数据目录

安全说明:
  Key 只通过 stdin/隐藏输入进入进程，不接受 --key 参数（避免出现在命令行与进程列表）。
  保存时使用 Windows DPAPI（当前用户）或其他平台的 AES-256-GCM 加密文件。
`;

interface Parsed {
  dataDir?: string;
  label?: string;
  positional: string[];
}

function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--data-dir" || arg === "--data") {
      parsed.dataDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--data-dir=")) {
      parsed.dataDir = arg.slice("--data-dir=".length);
      continue;
    }
    if (arg === "--label") {
      parsed.label = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--label=")) {
      parsed.label = arg.slice("--label=".length);
      continue;
    }
    parsed.positional.push(arg);
  }
  return parsed;
}

async function readAllStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

/** Read a secret without echoing it. Works for typed input and pasted input. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return readAllStdin();
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (fn: () => void) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      fn();
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          finish(() => {
            process.stdout.write("\n");
            reject(new AppError("cancelled", "已取消"));
          });
          return;
        }
        if (char === "\r" || char === "\n") {
          finish(() => {
            process.stdout.write("\n");
            resolve(value.trim());
          });
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " ") value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

function matchAccount(
  list: Array<{ id: string; fingerprint: string; label: string }>,
  needle: string,
) {
  const exact = list.find((item) => item.id === needle);
  if (exact) return exact;
  const cleaned = needle.startsWith("sha256:") ? needle.slice(7) : needle;
  const matches = list.filter((item) =>
    item.fingerprint.replace(/^sha256:/, "").startsWith(cleaned),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new AppError("ambiguous_account", `指纹前缀匹配到 ${matches.length} 个账号`);
  }
  throw new AppError("account_not_found", "找不到该账号");
}

function fail(error: unknown): never {
  const { message } = describeError(error);
  process.stderr.write(`错误：${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    return;
  }
  if (argv[0] === "help") {
    process.stdout.write(HELP);
    return;
  }

  const parsed = parseArgs(argv);
  const command = parsed.positional[0];
  const dataDir = resolveDataDir(parsed.dataDir);
  const service = new UsageService(dataDir);

  switch (command) {
    case "path": {
      await service.init();
      process.stdout.write(`${dataDir}\n`);
      return;
    }
    case "list": {
      const accounts = await service.listAccountInfo();
      if (accounts.length === 0) {
        process.stdout.write("没有账号。运行 add 命令添加。\n");
        return;
      }
      const rows = accounts.map((account) => [
        account.id,
        account.label,
        account.source === "env" ? "环境变量" : "本地",
        account.enabled ? "启用" : "停用",
        account.fingerprint,
      ]);
      const headers = ["ID", "名称", "来源", "状态", "指纹"];
      const widths = headers.map((header, column) =>
        Math.max(header.length, ...rows.map((row) => [...row[column]].length)),
      );
      const pad = (value: string, width: number) =>
        value + " ".repeat(Math.max(0, width - [...value].length));
      process.stdout.write(
        `${headers.map((header, index) => pad(header, widths[index])).join("  ")}\n`,
      );
      for (const row of rows) {
        process.stdout.write(
          `${row.map((value, index) => pad(value, widths[index])).join("  ")}\n`,
        );
      }
      process.stdout.write(`\n数据目录：${dataDir}\n`);
      return;
    }
    case "add": {
      await service.init();
      const key = await readSecret("OpenCode Go API Key（输入不回显）：");
      if (!key) throw new AppError("invalid_key", "未读取到 API Key");
      const record = await service.accounts.add(parsed.label || "OpenCode Go", key);
      await service.credentials.set(record.id, key);
      process.stdout.write(
        `已保存账号「${record.label}」(${record.id})\n指纹：${record.fingerprint}\n凭据后端：${service.credentials.backendName}\n`,
      );
      process.stdout.write("正在验证 Key…\n");
      try {
        const state = await service.testAccount(record.id);
        process.stdout.write(`${service.formatText(state)}\n`);
      } catch (error) {
        process.stdout.write(
          `验证失败，但账号已保存：${describeError(error).message}\n可稍后运行 test 重试，或用 remove 删除。\n`,
        );
      }
      return;
    }
    case "test": {
      const target = parsed.positional[1];
      if (target) {
        const accounts = await service.listAccountInfo();
        const account = matchAccount(accounts, target);
        const state = await service.testAccount(account.id);
        process.stdout.write(`${service.formatText(state)}\n`);
      } else {
        const state = await service.forceRefresh();
        process.stdout.write(`${service.formatText(state)}\n`);
      }
      return;
    }
    case "rename": {
      const target = parsed.positional[1];
      const label = parsed.positional.slice(2).join(" ") || parsed.label;
      if (!target || !label) {
        throw new AppError("bad_arguments", "用法：rename <账号ID> <新名称>");
      }
      const accounts = await service.listAccountInfo();
      const account = matchAccount(accounts, target);
      const state = await service.renameAccount(account.id, label);
      process.stdout.write(`已重命名。\n${service.formatText(state)}\n`);
      return;
    }
    case "remove": {
      const target = parsed.positional[1];
      if (!target) throw new AppError("bad_arguments", "用法：remove <账号ID|指纹前缀>");
      const accounts = await service.listAccountInfo();
      const account = matchAccount(accounts, target);
      await service.removeAccount(account.id);
      process.stdout.write(`已删除账号「${account.label}」(${account.id})。\n`);
      return;
    }
    case "import-env": {
      const result = await service.importEnvAccounts();
      process.stdout.write(`导入 ${result.imported} 个，跳过 ${result.skipped} 个。\n`);
      process.stdout.write(`${service.formatText(result.state)}\n`);
      return;
    }
    default:
      throw new AppError("unknown_command", `未知命令：${command}\n\n${HELP}`);
  }
}

main().catch(fail);
