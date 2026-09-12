// -R 瘦客户端:连接 remote wtangent 服务器(流式聊天,行式渲染)。
// 由 bin/tangent.js 调用:runRemoteChat(base, token)。

import readline from "node:readline";
import WebSocket from "ws";

export function runRemoteChat(base, token) {
  const wsUrl = `${base.replace(/^http/, "ws")}/ws${token ? `?token=${token}` : ""}`;
  console.log(`连接 ${base} …(Ctrl-C 退出)`);

  const ws = new WebSocket(wsUrl);
  let open = false;
  const queue = [];
  const send = env => {
    const msg = JSON.stringify(env);
    if (open) ws.send(msg);
    else queue.push(msg);
  };

  ws.on("open", () => {
    for (const m of queue) ws.send(m);
    queue.length = 0;
    console.log("已连接。输入消息回车发送:");
    process.stdout.write("❯ ");
  });

  ws.on("message", raw => {
    let env;
    try { env = JSON.parse(String(raw)); } catch { return; }
    render(env);
  });

  ws.on("error", e => {
    console.error(`\x1b[31m连接错误: ${e.message}\x1b[0m`);
    process.exit(1);
  });

  const rl = readline.createInterface({ input: process.stdin, terminal: true });
  rl.on("line", input => {
    const text = input.trim();
    if (text) send({ type: "ask", text });
  });
  rl.on("SIGINT", () => {
    ws.close();
    process.exit(0);
  });
}

function render(env) {
  switch (env.type) {
    case "message_delta":
      process.stdout.write(env.text ?? "");
      break;
    case "reasoning_delta":
      process.stdout.write(`\x1b[2m${(env.text ?? "").split("\n").slice(-1)[0]}\x1b[0m\n`);
      break;
    case "tool_start":
      process.stdout.write(`\x1b[33m⚙ ${env.name}\x1b[0m\n`);
      break;
    case "tool_end":
      process.stdout.write(`\x1b[2m  ${(env.result ?? "").split("\n")[0].slice(0, 120)}\x1b[0m\n`);
      break;
    case "confirm_req":
      process.stdout.write(`\x1b[31m? 确认: ${env.prompt ?? ""}(回执待客户端支持)\x1b[0m\n`);
      break;
    case "question_req": {
      let opts = [];
      try { opts = JSON.parse(env.options ?? "[]"); } catch { /* 忽略 */ }
      process.stdout.write(
        `\x1b[36m? ${env.text ?? ""}(选项: ${opts.map(o => o.label).join(", ")};回执待客户端支持)\x1b[0m\n`,
      );
      break;
    }
    case "turn_end":
      if (env.finalText) process.stdout.write(`\x1b[1m${env.finalText}\x1b[0m\n`);
      process.stdout.write("\n❯ ");
      break;
    case "error":
      process.stdout.write(`\x1b[31m✗ ${env.error ?? ""}\x1b[0m\n`);
      break;
    default:
      break;
  }
}
