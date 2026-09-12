// wtangent server 扩展(完整版):LAN/Web 会话服务。
// - HTTP:REST(/health /sessions /prompt /reply /git-exec)+ WUI 静态托管
// - WS:/ws?token= envelope 协议(ask/cancel/confirm/answer ↔ 流式事件)
// - token 鉴权(Bearer / ?token=)全路由;config ~/.wtangent-server/config.json
// - 会话桥:pi.sendUserMessage 注入(void,fire-and-forget);pi 事件 → WS 广播

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

interface WsEnvelope {
	type: string;
	text?: string;
	name?: string;
	arguments?: string;
	result?: string;
	id?: string;
	allow?: boolean;
	selected?: string;
	prompt?: string;
	finalText?: string;
	error?: string;
}

interface ServerConfig {
	port: number;
	host: string;
	token: string;
	projectsDir: string;
	webDist?: string;
}

const DEFAULT_PORT = 8890;

function loadConfig(): ServerConfig {
	const file = path.join(os.homedir(), ".wtangent-server", "config.json");
	try {
		const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ServerConfig>;
		return {
			port: cfg.port ?? DEFAULT_PORT,
			host: cfg.host ?? "127.0.0.1",   // 默认回环;LAN/隧道场景显式配 "0.0.0.0"
			token: cfg.token ?? "dev-token",
			projectsDir: cfg.projectsDir ?? path.join(os.homedir(), "wtangent-projects"),
			webDist: cfg.webDist,
		};
	} catch {
		return { port: DEFAULT_PORT, host: "127.0.0.1", token: "dev-token", projectsDir: path.join(os.homedir(), "wtangent-projects") };
	}
}

/// Windows 下 pi 进程 PATH 可能缺 Git;显式探测常见安装位
function resolveGit(): string {
	const candidates =
		process.platform === "win32"
			? ["git", "C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files (x86)\\Git\\cmd\\git.exe"]
			: ["git"];
	for (const c of candidates) {
		try {
			const r = spawnSync(c, ["--version"], { encoding: "utf8" });
			if (r.status === 0) return c;
		} catch {
			/* 下一个 */
		}
	}
	return "git";
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

interface WsEnv {
	type: string;
	text?: string;
	name?: string;
	arguments?: string;
	result?: string;
	id?: string;
	allow?: boolean;
	selected?: string;
	prompt?: string;
	finalText?: string;
	error?: string;
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const config = loadConfig();
	let ctxRef: any = null;
	let degraded = false;
	const pending = new Map<string, (answer: any) => void>();
	const clients = new Set<WebSocket>();
	const eventCounts: Record<string, number> = {};

	function broadcast(env: WsEnv): void {
		if (env.type === "__ignore__") return;
		const msg = JSON.stringify(env);
		for (const ws of clients) {
			try {
				if (ws.readyState === ws.OPEN) ws.send(msg);
				else clients.delete(ws);
			} catch {
				clients.delete(ws);
			}
		}
	}

	function onPiEvent(type: string, map: (e: any) => WsEnv): void {
		pi.on(type as any, async (event: any, ctx: any) => {
			ctxRef = ctx;
			broadcast(map(event));
		});
	}

	onPiEvent("session_start", () => ({ type: "__ignore__" }));
	onPiEvent("agent_start", () => ({ type: "__ignore__" }));
	onPiEvent("turn_start", () => ({ type: "__ignore__" }));
	onPiEvent("turn_end", () => ({ type: "turn_end", finalText: undefined }));
	onPiEvent("message_update", e => {
		const d = e?.assistantMessageEvent ?? {};
		if (d.type === "text_delta") return { type: "message_delta", text: d.delta };
		if (d.type === "thinking_delta") return { type: "reasoning_delta", text: d.delta };
		return { type: "__ignore__" };
	});
	onPiEvent("tool_execution_start", e => ({
		type: "tool_start",
		name: e?.toolName,
		arguments: JSON.stringify(e?.input ?? {}),
	}));
	onPiEvent("tool_execution_end", e => ({
		type: "tool_end",
		name: e?.toolName,
		result: String(e?.output ?? "").slice(0, 4000),
	}));

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const p = url.pathname;
		const tokenOk =
			req.headers.authorization === `Bearer ${config.token}` ||
			url.searchParams.get("token") === config.token;
		if (!tokenOk) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}

		const body = (): Promise<string> =>
			new Promise(resolve => {
				let data = "";
				req.on("data", c => (data += c));
				req.on("end", () => resolve(data));
			});

		if (p === "/health") {
			const canInject = typeof pi.sendUserMessage === "function";
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, degraded, canInject, clients: clients.size, eventCounts }));
			return;
		}

		if (p === "/sessions") {
			const entries: unknown[] = ctxRef?.sessionManager?.getEntries?.() ?? [];
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ sessions: [{ id: "current", entries: entries.length }] }));
			return;
		}

		if (p === "/prompt") {
			void body().then(raw => {
				const text = JSON.parse(raw || "{}").text ?? url.searchParams.get("text") ?? "";
				pi.sendUserMessage(text);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			});
			return;
		}

		if (p === "/reply") {
			void body().then(raw => {
				try {
					const { id, selected, allow } = JSON.parse(raw || "{}");
					const fn = id ? pending.get(id) : undefined;
					if (!fn) {
						res.writeHead(404, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "pending id not found" }));
						return;
					}
					pending.delete(id);
					fn(selected ?? allow);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
				} catch (e) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: String(e) }));
				}
			});
			return;
		}

		if (p === "/git-exec" && req.method === "POST") {
			void body().then(async raw => {
				const { args = [], cwd } = JSON.parse(raw || "{}");
				if (!Array.isArray(args) || args.some(a => /[\r\n]/.test(String(a)))) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "bad args" }));
					return;
				}
				const workDir = cwd ? path.resolve(config.projectsDir, cwd) : config.projectsDir;
				if (!fs.existsSync(workDir)) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: `目录不存在: ${workDir}` }));
					return;
				}
				let proc: ChildProcess;
				try {
					proc = spawn(resolveGit(), args, { cwd: workDir, shell: false });
				} catch (e) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: String(e) }));
					return;
				}
				let out = "";
				proc.stdout?.on("data", c => (out += c));
				proc.stderr?.on("data", c => (out += c));
				proc.on("error", e => {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: e.message }));
				});
				proc.on("close", code => {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ exit_code: code, output: out }));
				});
			});
			return;
		}

		if (config.webDist && req.method === "GET") {
			const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
			const file = path.resolve(config.webDist, rel);
			if (file.startsWith(path.resolve(config.webDist)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
				res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
				res.end(fs.readFileSync(file));
				return;
			}
			const index = path.join(config.webDist, "index.html");
			if (fs.existsSync(index)) {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(fs.readFileSync(index));
				return;
			}
		}

		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	});

	// —— WS 升级:/ws?token= ——
	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		if (!url.pathname.startsWith("/ws") || url.searchParams.get("token") !== config.token) {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, ws => {
			clients.add(ws);
			ws.on("close", () => clients.delete(ws));
			ws.on("message", raw => {
				let env: WsEnv;
				try {
					env = JSON.parse(String(raw)) as WsEnv;
				} catch {
					return;
				}
				const ctx: any = ctxRef ?? {};
				switch (env.type) {
					case "ask": {
						pi.sendUserMessage(env.text ?? "");
						break;
					}
					case "cancel": {
						ctx?.abort?.();
						break;
					}
					case "confirm": {
						const id = env.id;
						if (!id) break;
						const fn = pending.get(id);
						if (!fn) break;
						pending.delete(id);
						fn(env.allow ?? false);
						break;
					}
					case "answer": {
						const id = env.id;
						if (!id) break;
						const fn = pending.get(id);
						if (!fn) break;
						pending.delete(id);
						fn(env.selected ?? "");
						break;
					}
				}
			});
		});
	});

	// projectsDir 启动即建(git-exec 的 cwd 前提)
	fs.mkdirSync(config.projectsDir, { recursive: true });

	// 优雅处理:端口被占(另一个 tangent 实例/旧进程)只提示,绝不让 TUI 崩溃
	server.on("error", (err: NodeJS.ErrnoException) => {
		const msg = err.code === "EADDRINUSE"
			? `端口 ${config.port} 已被占用(另一个 tangent 实例在跑?),LAN 服务未启动`
			: `LAN 服务启动失败: ${err.message}`;
		console.error(`[wtangent] ${msg}`);
	});
	server.listen(config.port, config.host, () => {
		console.error(`[wtangent] LAN 服务 http://${config.host}:${config.port}`);
	});

	pi.registerCommand("server", {
		description: "wtangent 服务状态",
		handler: async (_args: string, ctx: any) => {
			ctx.ui.notify(
				`wtangent: :${config.port} · 客户端 ${clients.size} · 注入 ${typeof pi.sendUserMessage === "function" ? "可用" : "降级"}`,
				"info",
			);
		},
	});

	pi.registerCommand("token", {
		description: "显示 wtangent token",
		handler: async (_args: string, ctx: any) => {
			ctx.ui.notify(`token: ${config.token}`, "info");
		},
	});
}
