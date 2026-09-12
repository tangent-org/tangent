# 部署到服务器(盒子/NAS)

目标:agent 全程跑在服务器上,笔记本只用浏览器/ssh 零负载访问。

## 前提

- 服务器:Linux(arm64/x64 均可)+ Node.js ≥ 20 + git
- 网络:与笔记本同局域网(或 EasyTier/Tailscale 隧道)

## 1. 装 Node(盒子若没有)

```bash
# arm64 盒子示例(Ubuntu/Debian 系):
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs git
node --version   # ≥ 20
```

## 2. 拉代码 + 构建

```bash
git clone https://github.com/tangent-org/tangent.git ~/tangent
cd ~/tangent
npm install --ignore-scripts
npm run build
```

构建产物:`packages/coding-agent/dist/bundle/cli.js`(自包含 bundle)。

## 3. 配置

```bash
mkdir -p ~/.wtangent-server
cat > ~/.wtangent-server/config.json <<'EOF'
{
  "port": 8890,
  "host": "0.0.0.0",
  "token": "<生成一个随机 token>",
  "projectsDir": "~/wtangent-projects"
}
EOF
# token 生成:python3 -c "import secrets;print(secrets.token_urlsafe(18))"
```

- `host: "0.0.0.0"` = 监听所有网卡(LAN + 隧道可达)
- LLM key:复制笔记本的 `~/.pi/agent/auth.json` → `~/.tangent/agent/auth.json`(或后续 /login)

## 4. 试跑

```bash
WTANGENT_TOKEN=<上面的token> node packages/coding-agent/dist/bundle/cli.js --mode rpc
# 看到 [wtangent] server listening on http://0.0.0.0:8890 即成功
```

笔记本验证:

```bash
curl "http://<盒子IP>:8890/health?token=<token>"
tangent attach http://<盒子IP>:8890   # 或配了 remote 后:tangent attach <名>
```

## 5. 常驻(systemd)

```bash
sudo tee /etc/systemd/system/wtangent.service <<EOF
[Unit]
Description=wtangent server (tangent LAN/Web)
After=network-online.target

[Service]
User=$USER
WorkingDirectory=$HOME/tangent/packages/coding-agent
Environment=WTANGENT_TOKEN=<token>
ExecStart=$(which node) dist/bundle/cli.js --mode rpc
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now wtangent
systemctl status wtangent
```

服务器重启后自动拉起;日志:`journalctl -u wtangent -f`。

## 6. 随时随地(内网穿透 + server code)

- EasyTier/Tailscale 任选:笔记本与盒子同网后,`remote add` 的 host 换成隧道 IP
- server code:`tangent remote add <名> <隧道IP:端口> <token> <code>`——隧道地址变了 code 不变,`tangent attach <code>` 永远可达

## 7. 笔记本侧

```bash
tangent remote add nas <盒子IP>:8890 <token>
tangent attach nas        # 流式聊天(agent 在盒子跑)
浏览器: http://<盒子IP>:8890/?token=<token>   # WUI(待 dist)
```
