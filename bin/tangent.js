#!/usr/bin/env node
// tangent — wtangent CLI:
//   tangent                    交互 TUI(pi 自带;LAN 服务默认回环 127.0.0.1:8890)
//   tangent serve [-R|-U]      headless LAN/Web 服务(服务器常驻;注册后续版本)
//   tangent attach <URL|名> [-c] [-p pass] [-u user]   瘦客户端:连远端服务器流式聊天(-c 续当前会话)
//   tangent remote add|list|remove   管理 remote(存 ~/.tangent/remotes.json)
// remote 条目:{name, host, port, token, code};code 解析优先(隧道地址变,code 不变)

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";

const [sub, ...args] = process.argv.slice(2);

function log(msg) {
  console.log(`[tangent] ${msg}`);
}
function err(msg) {
  console.error(`[tangent] ${msg}`);
}

function findPi() {
  for (const name of process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"]) {
    const r = spawnSync(name, ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
    if (r.status === 0) return name;
  }
  return null;
}

// —— remote 注册表:~/.tangent/remotes.json ——
function remotesFile() {
  return path.join(os.homedir(), ".tangent", "remotes.json");
}
function loadRemotes() {
  try {
    return JSON.parse(readFileSync(remotesFile(), "utf8")); // [{name,host,port,token,code}]
  } catch {
    return [];
  }
}
function saveRemotes(list) {
  const dir = path.dirname(remotesFile());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(remotesFile(), JSON.stringify(list, null, 2));
}

/** 解析 remote:code 优先 → 名字 → URL 直填 */
function resolveRemote(target) {
  if (/^https?:\/\//.test(target)) return { base: target.replace(/\/+$/, ""), token: null };
  const hit = loadRemotes().find(r => (r.code && r.code === target) || r.name === target);
  if (hit) return { base: `http://${hit.host}:${hit.port ?? 8890}`, token: hit.token ?? null };
  return null;
}

// ================= serve:headless 起 pi + LAN 服务 =================
async function serve(args) {
  const register = args.some(a => a === "-R" || a === "--register");
  const unregister = args.some(a => a === "-U" || a === "--unregister");
  if (register || unregister) {
    log(`服务注册(${register ? "register" : "unregister"}):systemd/NSSM 支持将在后续版本提供;当前用 tmux/计划任务常驻`);
    return;
  }
  const pi = findPi();
  if (!pi) {
    err("找不到 pi(先安装:@tangent-ai/tangent-coding-agent 或上游 pi)");
    process.exit(1);
  }
  log("启动 wtangent server(headless pi + LAN 服务)…");
  const quoted = `"${pi}" --mode rpc -e "${path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w):/, "$1:")), "..")}"`;
  const child = spawn(quoted, { stdio: ["pipe", "inherit", "inherit"], shell: process.platform === "win32" });
  child.on("exit", code => process.exit(code ?? 0));
}

// ================= -R 瘦客户端 =================
async function remoteChat(target, opts = {}) {
  const resolved = resolveRemote(target);
  if (!resolved) {
    err(`未找到 remote "${target}"(tangent remote add 添加,或直接给 URL)`);
    process.exit(1);
  }
  if (opts.user && opts.pass) resolved.basic = { user: opts.user, pass: opts.pass };
  const { runRemoteChat } = await import("./remote-chat.js");
  runRemoteChat(resolved);
}

// ================= remote 管理 =================
function remoteManage(rest) {
  const [cmd, ...rargs] = rest;
  const list = loadRemotes();
  switch (cmd) {
    case "add": {
      const [name, hostPort, token, code] = rargs;
      if (!name || !hostPort) {
        err("用法:tangent remote add <名> <host[:port]> [token] [code]");
        process.exit(1);
      }
      const [host, port] = hostPort.split(":");
      saveRemotes([...list.filter(r => r.name !== name), { name, host, port: Number(port) || 8890, token: token || null, code: code || null }]);
      log(`已添加 ${name} → ${host}:${Number(port) || 8890}${code ? ` (code=${code})` : ""}`);
      break;
    }
    case "list":
      for (const r of list) console.log(`  ${r.name.padEnd(12)} ${r.host}:${r.port}${r.code ? ` code=${r.code}` : ""}`);
      if (list.length === 0) log("(空;tangent remote add 添加)");
      break;
    case "remove": {
      const name = rargs[0];
      saveRemotes(list.filter(r => r.name !== name));
      log(`已移除 ${name}`);
      break;
    }
    default:
      err("用法:tangent remote add|list|remove");
  }
}

// ================= 分发 =================
if (sub === "serve") {
  void serve(args);
} else if (sub === "remote") {
  remoteManage(args);
} else if (sub === "attach") {
  void remoteChat(args[0], {
    pass: args.includes("-p") ? args[args.indexOf("-p") + 1] : args.includes("--password") ? args[args.indexOf("--password") + 1] : undefined,
    user: args.includes("-u") || args.includes("--username") ? args[(args.indexOf("-u") >= 0 ? args.indexOf("-u") : args.indexOf("--username")) + 1] : undefined,
    continueLast: args.includes("-c"),
  });
} else if (sub === "-R" || sub === "--remote") {
  void remoteChat(args[0]);
} else if (sub === undefined) {
  log("用法:tangent [TUI] | tangent serve [-R|-U] | tangent -R <名|code|URL> | tangent remote add|list|remove");
} else {
  // `tangent <名/URL>` 命中 remote 或 URL → 瘦客户端;否则提示
  if (resolveRemote(sub)) {
    void remoteChat(sub);
  } else {
    log(`未知命令 "${sub}"。用法:tangent [TUI] | tangent serve | tangent -R <remote> | tangent remote ...`);
  }
}
