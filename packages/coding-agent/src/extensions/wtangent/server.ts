// wtangent server 扩展:LAN/Web 会话服务(spike)。
// 激活即起 HTTP(0.0.0.0:8890):/health、/prompt?text=(sendUserMessage 注入验证)。
// 事件桥:pi 会话事件 → WS 广播(spike 先打印计数;/ws 升级下一步)。
// token 鉴权:env WTANGENT_TOKEN 或默认 dev-token(Bearer / ?token=)。

interface WsLike {
  send: (data: string) => void;
}

const clients = new Set<WsLike>();
let capturedCtx: any = null;
let degraded = false;

const TOKEN = process.env.WTANGENT_TOKEN ?? "dev-token";

function authOk(url: string, auth: string | undefined): boolean {
  if (auth === `Bearer ${TOKEN}`) return true;
  try {
    return new URL(url, "http://x").searchParams.get("token") === TOKEN;
  } catch {
    return false;
  }
}

function broadcast(data: unknown): void {
  const msg = JSON.stringify(data);
  for (const c of clients) {
    try { c.send(msg); } catch { clients.delete(c); }
  }
}

export default async function (pi: any): Promise<void> {
  const http = await import("node:http");

  // —— 事件桥:捕获 ctx + 计数(spike 观测) ——
  const counts: Record<string, number> = {};
  const on = (type: string, map?: (e: any) => Record<string, unknown>): void => {
    pi.on(type, async (event: any, ctx: any) => {
      if (!capturedCtx) capturedCtx = ctx;
      counts[type] = (counts[type] ?? 0) + 1;
      const env = map?.(event);
      if (env && env.type !== "__ignore__") broadcast(env);
    });
  };
  on("session_start");
  on("agent_start");
  on("turn_start");
  on("turn_end");
  on("message_update", e => {
    const d = e?.assistantMessageEvent ?? {};
    if (d.type === "text_delta") return { type: "message_delta", text: d.delta };
    if (d.type === "thinking_delta") return { type: "reasoning_delta", text: d.delta };
    return { type: "__ignore__" };
  });
  on("tool_execution_start", e => ({ type: "tool_start", name: e?.toolName, arguments: JSON.stringify(e?.input ?? {}) }));
  on("tool_execution_end", e => ({ type: "tool_end", name: e?.toolName, result: String(e?.output ?? "").slice(0, 500) }));

  // —— HTTP ——
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (!authOk(url, req.headers.authorization)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (url.startsWith("/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        degraded,
        ctxCaptured: capturedCtx !== null,
        canInject: typeof pi.sendUserMessage === "function",
        clients: clients.size,
        events: counts,
        piKeys: Object.keys(pi),
        hasSUM: typeof (pi as any).sendUserMessage,
      }));
      return;
    }
    if (url.startsWith("/prompt")) {
      const text = new URL(url, "http://x").searchParams.get("text") ?? "";
      if (typeof pi.sendUserMessage !== "function") {
        degraded = true;
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no prompt channel (degraded)" }));
        return;
      }
      void pi.sendUserMessage(text).then(
        () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        },
        (e: unknown) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(e) }));
        },
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>(resolve => server.listen(8890, "0.0.0.0", resolve));
  console.error(`[wtangent] LAN 服务已启动 :8890(token=${TOKEN === "dev-token" ? "dev 默认" : "env 配置"})`);
}
