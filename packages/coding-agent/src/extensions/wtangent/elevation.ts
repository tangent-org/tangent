// wtangent 权限模式 + 管理员提权:
// 五档(对齐 ZCode):plan(编辑前先出计划) / confirm(变更前确认) / autoedit(自动编辑) /
// full(完全访问) / admin(管理员 = full + shell 命令走提权 helper,无 UAC 弹窗)
//
// 管理员实现(方案 A:提权 helper + RPC):
// - Windows:helper 进程以管理员启动(一次 UAC,Start-Process -Verb RunAs),
//   监听命名管道 \\.\pipe\tangent-elevated;调用方发 {command, cwd, token} JSON 行,收 {output, exitCode}
// - Linux/服务器:无 UAC;admin 模式 = 命令前缀 sudo(helper 路线后续按需)
// - helper 空闲 30 分钟自动退出;普通模式下不启动

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const BS = String.fromCharCode(92);

export type PermissionMode = "plan" | "confirm" | "autoedit" | "full" | "admin";

const MODES: PermissionMode[] = ["plan", "confirm", "autoedit", "full", "admin"];
const PIPE_NAME = "\\\\.\\pipe\\tangent-elevated";
const SESSION_TOKEN = process.env.WTANGENT_SESSION_TOKEN ?? os.hostname();

let currentMode: PermissionMode = "full";
let helperAlive = false;

export function getMode(): PermissionMode {
	return currentMode;
}

export function setMode(mode: string): PermissionMode | null {
	if (!MODES.includes(mode as PermissionMode)) return null;
	currentMode = mode as PermissionMode;
	return currentMode;
}

/** admin 模式 = shell 走提权隧道 */
export function usesElevatedShell(): boolean {
	return currentMode === "admin" && process.platform === "win32";
}

// —— 提权 helper 管道客户端 ——
function helperRequest(command: string, cwd: string, timeoutMs = 300_000): Promise<{ output: string; exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		const sock = net.connect(PIPE_NAME);
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error("elevated helper 超时"));
		}, timeoutMs);
		let data = "";
		sock.on("connect", () => {
			sock.write(JSON.stringify({ command, cwd, token: SESSION_TOKEN }) + "\n");
		});
		sock.on("data", chunk => {
			data += chunk;
			if (data.includes("\n")) {
				clearTimeout(timer);
				try {
					resolve(JSON.parse(data.split("\n")[0]));
				} catch (e) {
					reject(e);
				}
				sock.end();
			}
		});
		sock.on("error", e => {
			clearTimeout(timer);
			reject(e);
		});
	});
}

/** 弹一次 UAC 启动提权 helper(Windows);已存活则跳过 */
export async function ensureElevatedHelper(): Promise<boolean> {
	if (helperAlive) return true;
	if (process.platform !== "win32") return false;
	// 探测:管道可连 = helper 已在
	try {
		await helperRequest("echo probe", process.cwd(), 3000);
		helperAlive = true;
		return true;
	} catch { /* 未在,继续启动 */ }

	// helper 脚本写入临时目录,PowerShell -Verb RunAs 启动(一次 UAC)
	const helperScript = path.join(os.tmpdir(), "tangent-elevated-helper.mjs");
	fs.writeFileSync(
		helperScript,
		[
			'import net from "node:net";',
			'import { spawn } from "node:child_process";',
			`const TOKEN = ${JSON.stringify(SESSION_TOKEN)};`,
			`const PIPE = ${JSON.stringify(PIPE_NAME)};`,
			'const srv = net.createServer(sock => {',
			'  let buf = "";',
			'  sock.on("data", c => {',
			'    buf += c;',
			'    if (!buf.includes("\\n")) return;',
			'    const line = buf.split("\\n")[0]; buf = "";',
			'    try {',
			'      const req = JSON.parse(line);',
			'      if (req.command === "__shutdown__") { sock.write(JSON.stringify({output:"bye",exitCode:0})+"' + BS + 'n"); srv.close(); process.exit(0); }',
			'      if (req.token !== TOKEN) { sock.write(JSON.stringify({output:"denied",exitCode:126})+"\\n"); return; }',
			'      const proc = spawn(req.command, { cwd: req.cwd, shell: true });',
			'      let out = "";',
			'      proc.stdout.on("data", c => (out += c));',
			'      proc.stderr.on("data", c => (out += c));',
			'      proc.on("close", code => sock.write(JSON.stringify({output: out, exitCode: code})+"\\n"));',
			'    } catch (e) { sock.write(JSON.stringify({output: String(e), exitCode: 127})+"\\n"); }',
			'  });',
			'});',
			'net.createServer; ',
			'// 空闲 30 分钟自退',
			'let idle = setTimeout(() => process.exit(0), 30*60*1000);',
			'srv.on("connection", () => { clearTimeout(idle); idle = setTimeout(() => process.exit(0), 30*60*1000); });',
			'srv.listen(PIPE, () => console.error("[tangent-elevated] ready"));',
		].join("\n"),
	);
	const { execSync } = await import("node:child_process");
	try {
		execSync(
			`powershell -NoProfile -Command "Start-Process node -ArgumentList '${helperScript.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden"`,
			{ stdio: "ignore" },
		);
	} catch {
		// 用户拒绝 UAC(或系统策略阻止):静默返回,由上层轮询超时给出"未启动"提示
		return false;
	}
	// 轮询等管道就绪(最多 15 秒:用户点 UAC)
	for (let i = 0; i < 30; i++) {
		await new Promise(r => setTimeout(r, 500));
		try {
			await helperRequest("echo probe", process.cwd(), 2000);
			helperAlive = true;
			return true;
		} catch { /* 等 */ }
	}
	return false;
}

/** admin 模式下经提权隧道执行;失败返回 null(调用方回退普通执行) */
export async function execElevated(command: string, cwd: string): Promise<{ output: string; exitCode: number | null } | null> {
	if (!usesElevatedShell()) return null;
	try {
		if (!(await ensureElevatedHelper())) return null;
		return await helperRequest(command, cwd);
	} catch (e) {
		console.error(`[wtangent] 提权执行失败(回退普通): ${e instanceof Error ? e.message : e}`);
		return null;
	}
}

/** 离开 admin 模式:通知 helper 自毁(提权状态真回退,而非闲置遗留) */
export function shutdownElevatedHelper(): void {
	if (!helperAlive) return;
	try {
		const sock = net.connect(PIPE_NAME);
		sock.on("connect", () => {
			sock.write(JSON.stringify({ command: "__shutdown__", token: SESSION_TOKEN }) + "\n");
			sock.end();
		});
		sock.on("error", () => {});
	} catch {
		/* helper 已死,无需处理 */
	}
	helperAlive = false;
}
