# SSH AI Chat

A mobile-first **AI Chat + SSH Remote Control PWA** designed for iPhone and mobile browsers. Interact with **Codex CLI**, **Antigravity CLI (`agy`)**, and **Shell** running on remote SSH hosts (such as InstaBox, Linux servers, or your own Mac/PC) with a native ChatGPT/Claude-style mobile experience.

专为手机端（iPhone / Android PWA）打造的 **AI 对话 + SSH 远程终端工具**，让你像使用原生 AI 聊天软件一样，通过 SSH 驱动远端主机上的 **Codex CLI**、**Antigravity CLI (`agy`)** 与 **Shell**。

---

## Features / 核心特性

* **Mobile-Native AI Chat UX（类 ChatGPT 手机端交互）**
  * Streaming responses, Markdown/table rendering, one-tap code copy, collapsible Thinking blocks & Tool/Shell execution cards, and one-tap Stop/Abort.
  * Light & dark themes, iOS safe-area & dynamic viewport (`100dvh`) support, PWA installable via Safari **"Add to Home Screen"**.
* **Multi-Host SSH Manager（多主机 SSH 连接管理）**
  * One-click paste parsing for SSH commands (e.g. `ssh -p 2222 ibssh_xxx@ssh.instabox.sh`).
  * Supports **SSH Token (passwordless)**, **Password**, **SSH Private Key**, and **Local Host** mode.
  * Built-in connection probe that checks latency and detects installed `codex` / `agy` binaries.
* **Model & Reasoning Effort Picker（模型与推理强度选择）**
  * Dynamically fetches available models from the target host (`~/.codex/models_cache.json` + `agy models`).
  * Per-conversation model and reasoning effort (`low` / `medium` / `high` / `xhigh` / `max` / `ultra`) switching.
* **Usage & Quota Dashboard（用量与配额面板）**
  * Displays Codex account 5-hour & 7-day quota bars, reset countdowns, context window utilization, and cache hit rates.
  * Aggregates Antigravity CLI token usage across sessions (24h, all-time, and per-model breakdown).
* **Bidirectional File & Image Transfer（双向图片与文档传输）**
  * Upload photos, screenshots, or arbitrary documents (up to 50MB) over SFTP/local directly from the chat composer (`+` button) or clipboard paste.
  * Images are natively attached to Codex via `-i <file>`.
  * **Auto-detected output download cards**: newly created/modified documents (`.docx`, `.pdf`, `.md`, images, etc.) automatically appear below AI replies with one-tap preview & download (UTF-8 filename safe).
  * Built-in remote **File Manager** tab (`对话 | 文件 | 终端`).
* **Computer CLI Session Sync & Resume（电脑端会话一键同步与续聊）**
  * Scans existing **Codex CLI / Desktop** (`~/.codex/sessions`) and **Antigravity CLI** (`~/.gemini/antigravity-cli/brain`) sessions on the host.
  * Import full history and seamlessly resume the exact same `thread_id` / `conversation_id` from your phone.
* **One-Tap Interactive SSH Terminal（内置交互式终端）**
  * Full `xterm.js` PTY terminal with mobile shortcut keys (`Esc`, `Tab`, `Ctrl+C`, `Ctrl+D`, arrow keys, font zoom `A-`/`A+`).
* **Zero External CDN & Password Protection**
  * All frontend libraries are bundled and served locally; optional `APP_PASSWORD` cookie authentication protects public deployments.

---

## Quick Start / 快速开始

### Requirements
* Node.js `>= 20`
* Python 3 on target hosts (used for fast model/usage/session metadata probing)
* Optional: `codex` and/or `agy` installed on your local or remote SSH hosts

### Install & Run

```bash
git clone https://github.com/elyar1124/ssh-ai-chat.git
cd ssh-ai-chat
npm install

# Copy and edit environment variables
cp .env.example .env
# Edit .env and set a strong APP_PASSWORD

# Start server
PORT=3456 APP_PASSWORD=your-strong-password npm start
```

Open `http://localhost:3456` in your browser (or your LAN/Tailscale/HTTPS URL on iPhone Safari, then tap **Share → Add to Home Screen**).

---

## Deployment Tips / 公网部署建议

### 1. Run as a `systemd` Service (Linux)
```ini
[Unit]
Description=SSH AI Chat Mobile PWA Server
After=network.target

[Service]
Type=simple
User=root
Environment=HOME=/root
WorkingDirectory=/path/to/ssh-ai-chat
EnvironmentFile=/path/to/ssh-ai-chat/.env
ExecStart=/usr/local/bin/node /path/to/ssh-ai-chat/server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

### 2. Expose via HTTPS
* **Cloudflare Tunnel**: Point a public hostname in Cloudflare Zero Trust to `http://127.0.0.1:3456`.
* **InstaBox**: Run `instabox port publish <machine-name> 3456` (also automatically wakes sleeping InstaBox instances on visit).
* **Tailscale**: Access securely over your private Tailscale network without exposing public ports.

---

## Security Notes / 安全说明

* Always set a strong `APP_PASSWORD` before exposing the service to the public internet, and serve over **HTTPS** (Cloudflare Tunnel / Caddy / Nginx / InstaBox HTTPS).
* Host credentials and conversation history are stored locally in `data/state.json` (mode `0600`, ignored by Git). Never commit `.env` or `data/`.

---

## License

[MIT](./LICENSE)
