import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { store } from './store.js';
import { testHost, openPtyShell, parseSshCommand } from './sshManager.js';
import { runAgentTurn } from './agentRunner.js';
import {
  listDirectory,
  uploadFile,
  streamFileToResponse,
  deleteFile
} from './fileManager.js';
import {
  fetchHostModels,
  fetchRemoteUsage,
  summarizeAppUsage
} from './metaManager.js';
import {
  listRemoteSessions,
  fetchRemoteSessionDetail
} from './sessionSync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const NM_DIR = path.join(ROOT_DIR, 'node_modules');

const PORT = Number(process.env.PORT) || 3456;
const HOST = process.env.HOST || '0.0.0.0';
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();

const validSessions = new Set();

function parseCookies(cookieHeader = '') {
  const out = {};
  for (const part of String(cookieHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isAuthenticated(req) {
  if (!APP_PASSWORD) return true;
  const cookies = parseCookies(req.headers.cookie);
  return Boolean(cookies.ssh_ai_sid && validSessions.has(cookies.ssh_ai_sid));
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---- Auth Routes ----
app.get('/api/auth/status', (req, res) => {
  res.json({
    required: Boolean(APP_PASSWORD),
    authenticated: isAuthenticated(req)
  });
});

app.post('/api/auth/login', (req, res) => {
  if (!APP_PASSWORD) {
    return res.json({ ok: true });
  }
  const password = String(req.body?.password || '');
  if (!safeEqual(password, APP_PASSWORD)) {
    return res.status(401).json({ error: '访问密码不正确' });
  }
  const sid = crypto.randomBytes(24).toString('hex');
  validSessions.add(sid);
  res.setHeader(
    'Set-Cookie',
    `ssh_ai_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`
  );
  return res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.ssh_ai_sid) validSessions.delete(cookies.ssh_ai_sid);
  res.setHeader('Set-Cookie', 'ssh_ai_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

// ---- Auth Middleware for /api/* ----
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: '未登录或会话已过期' });
  }
  next();
});

// ---- Host APIs ----
app.get('/api/hosts', (_req, res) => {
  res.json({ hosts: store.listHosts() });
});

app.post('/api/hosts/parse-ssh', (req, res) => {
  const parsed = parseSshCommand(req.body?.command);
  if (!parsed) {
    return res.status(400).json({ error: '无法解析 SSH 命令，请检查格式（例如 ssh -p 2222 user@host）' });
  }
  res.json({ parsed });
});

app.post('/api/hosts', (req, res) => {
  const body = req.body || {};
  if (body.type !== 'local' && (!body.host || !body.username)) {
    return res.status(400).json({ error: '请填写主机地址和用户名' });
  }
  const host = store.createHost(body);
  res.status(201).json({ host });
});

app.put('/api/hosts/:id', (req, res) => {
  const host = store.updateHost(req.params.id, req.body || {});
  if (!host) return res.status(404).json({ error: '主机不存在' });
  res.json({ host });
});

app.delete('/api/hosts/:id', (req, res) => {
  const ok = store.deleteHost(req.params.id);
  if (!ok) return res.status(404).json({ error: '主机不存在' });
  res.json({ ok: true });
});

app.post('/api/hosts/test-raw', async (req, res) => {
  try {
    const body = req.body || {};
    let config = { ...body };
    // If editing an existing host and password/key left empty, fall back to saved credentials
    if (body.id) {
      const saved = store.getHost(body.id);
      if (saved) {
        if (!config.password) config.password = saved.password;
        if (!config.privateKey) config.privateKey = saved.privateKey;
        if (!config.passphrase) config.passphrase = saved.passphrase;
      }
    }
    const result = await testHost(config);
    res.json({ result });
  } catch (err) {
    res.status(400).json({ error: err.message || '连接失败' });
  }
});

app.post('/api/hosts/:id/test', async (req, res) => {
  const host = store.getHost(req.params.id);
  if (!host) return res.status(404).json({ error: '主机不存在' });
  try {
    const result = await testHost(host);
    res.json({ result });
  } catch (err) {
    res.status(400).json({ error: err.message || '连接失败' });
  }
});

// ---- File Transfer & Remote Browser APIs ----
app.get('/api/hosts/:id/files', async (req, res) => {
  const host = store.getHost(req.params.id);
  if (!host) return res.status(404).json({ error: '主机不存在' });
  try {
    const targetPath = req.query.path ? String(req.query.path) : (host.defaultCwd || '~');
    const listing = await listDirectory(host, targetPath);
    res.json(listing);
  } catch (err) {
    res.status(400).json({ error: err.message || '读取目录失败' });
  }
});

app.post(
  '/api/hosts/:id/files/upload',
  express.raw({ type: '*/*', limit: '50mb' }),
  async (req, res) => {
    const host = store.getHost(req.params.id);
    if (!host) return res.status(404).json({ error: '主机不存在' });
    try {
      const dir = req.query.dir ? String(req.query.dir) : (host.defaultCwd || '~');
      const mode = req.query.mode === 'dir' ? 'dir' : 'chat';
      const rawHeader = req.headers['x-file-name'] || req.query.name || 'upload.bin';
      let fileName = 'upload.bin';
      try {
        fileName = decodeURIComponent(String(rawHeader));
      } catch {
        fileName = String(rawHeader);
      }
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      if (buffer.length === 0) {
        return res.status(400).json({ error: '上传文件内容为空' });
      }
      const uploaded = await uploadFile(host, dir, fileName, buffer, { mode });
      res.status(201).json({ file: uploaded });
    } catch (err) {
      res.status(400).json({ error: err.message || '上传文件失败' });
    }
  }
);

app.get('/api/hosts/:id/files/download', async (req, res) => {
  const host = store.getHost(req.params.id);
  if (!host) return res.status(404).json({ error: '主机不存在' });
  const filePath = req.query.path ? String(req.query.path) : '';
  if (!filePath) return res.status(400).json({ error: '缺少文件路径' });
  const inline = req.query.inline === '1' || req.query.inline === 'true';
  try {
    await streamFileToResponse(host, filePath, res, { inline });
  } catch (err) {
    if (!res.headersSent) {
      res.status(400).json({ error: err.message || '下载文件失败' });
    }
  }
});

app.delete('/api/hosts/:id/files', async (req, res) => {
  const host = store.getHost(req.params.id);
  if (!host) return res.status(404).json({ error: '主机不存在' });
  const filePath = req.query.path ? String(req.query.path) : '';
  if (!filePath) return res.status(400).json({ error: '缺少文件路径' });
  try {
    await deleteFile(host, filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || '删除文件失败' });
  }
});

// ---- Models & Usage APIs ----
app.get('/api/hosts/:id/models', async (req, res) => {
  const host = store.getHost(req.params.id);
  if (!host) return res.status(404).json({ error: '主机不存在' });
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const models = await fetchHostModels(host, { forceRefresh });
    res.json({ models });
  } catch (err) {
    res.status(400).json({ error: err.message || '获取模型列表失败' });
  }
});

app.get('/api/hosts/:id/usage', async (req, res) => {
  const host = store.getHost(req.params.id);
  if (!host) return res.status(404).json({ error: '主机不存在' });
  try {
    const conversationId = req.query.conversationId ? String(req.query.conversationId) : null;
    const conv = conversationId ? store.getConversation(conversationId) : null;
    const remote = await fetchRemoteUsage(host, conv?.remoteSessionId || '');
    const appUsage = summarizeAppUsage(store, host.id, conversationId);
    res.json({ remote, app: appUsage });
  } catch (err) {
    res.status(400).json({ error: err.message || '获取用量失败' });
  }
});

// ---- Remote CLI Session Sync APIs ----
app.get('/api/hosts/:id/remote-sessions', async (req, res) => {
  const host = store.getHost(req.params.id);
  if (!host) return res.status(404).json({ error: '主机不存在' });
  try {
    const sessions = await listRemoteSessions(host);
    const existing = store.state.conversations.filter((c) => c.hostId === host.id && c.remoteSessionId);
    const map = new Map(existing.map((c) => [`${c.agent}:${c.remoteSessionId}`, c.id]));
    const enriched = sessions.map((s) => ({
      ...s,
      importedConvId: map.get(`${s.agent}:${s.sessionId}`) || null
    }));
    res.json({ sessions: enriched });
  } catch (err) {
    res.status(400).json({ error: err.message || '读取远端会话失败' });
  }
});

app.post('/api/hosts/:id/remote-sessions/import', async (req, res) => {
  const host = store.getHost(req.params.id);
  if (!host) return res.status(404).json({ error: '主机不存在' });
  const { agent, sessionId } = req.body || {};
  if (!['codex', 'agy'].includes(agent) || !sessionId) {
    return res.status(400).json({ error: '缺少 agent 或 sessionId 参数' });
  }
  try {
    const detail = await fetchRemoteSessionDetail(host, agent, String(sessionId));
    const conversation = store.upsertSyncedConversation(host.id, detail);
    res.json({ conversation });
  } catch (err) {
    res.status(400).json({ error: err.message || '同步会话失败' });
  }
});

app.post('/api/conversations/:id/sync', async (req, res) => {
  const conv = store.getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: '对话不存在' });
  if (!conv.remoteSessionId || !['codex', 'agy'].includes(conv.agent)) {
    return res.status(400).json({ error: '当前对话尚未关联远端 CLI 会话' });
  }
  const host = store.getHost(conv.hostId);
  if (!host) return res.status(404).json({ error: '关联主机不存在' });
  try {
    const detail = await fetchRemoteSessionDetail(host, conv.agent, conv.remoteSessionId);
    const updated = store.upsertSyncedConversation(host.id, detail);
    res.json({ conversation: updated });
  } catch (err) {
    res.status(400).json({ error: err.message || '同步最新记录失败' });
  }
});

// ---- Conversation APIs ----
app.get('/api/conversations', (req, res) => {
  const hostId = req.query.hostId ? String(req.query.hostId) : null;
  res.json({ conversations: store.listConversations(hostId) });
});

app.post('/api/conversations', (req, res) => {
  try {
    const conv = store.createConversation(req.body || {});
    res.status(201).json({ conversation: conv });
  } catch (err) {
    res.status(400).json({ error: err.message || '创建对话失败' });
  }
});

app.get('/api/conversations/:id', (req, res) => {
  const conv = store.getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: '对话不存在' });
  const running = activeRuns.has(conv.id);
  res.json({ conversation: conv, running });
});

app.patch('/api/conversations/:id', (req, res) => {
  const conv = store.updateConversation(req.params.id, req.body || {});
  if (!conv) return res.status(404).json({ error: '对话不存在' });
  res.json({ conversation: conv });
});

app.delete('/api/conversations/:id', (req, res) => {
  const run = activeRuns.get(req.params.id);
  if (run) {
    run.handle.abort();
    activeRuns.delete(req.params.id);
  }
  const ok = store.deleteConversation(req.params.id);
  if (!ok) return res.status(404).json({ error: '对话不存在' });
  res.json({ ok: true });
});

// ---- Vendor Static Assets (Zero External CDN) ----
app.get('/vendor/marked.umd.js', (_req, res) => {
  res.sendFile(path.join(NM_DIR, 'marked', 'lib', 'marked.umd.js'));
});
app.get('/vendor/xterm.js', (_req, res) => {
  res.sendFile(path.join(NM_DIR, '@xterm', 'xterm', 'lib', 'xterm.js'));
});
app.get('/vendor/xterm.css', (_req, res) => {
  res.sendFile(path.join(NM_DIR, '@xterm', 'xterm', 'css', 'xterm.css'));
});
app.get('/vendor/addon-fit.js', (_req, res) => {
  res.sendFile(path.join(NM_DIR, '@xterm', 'addon-fit', 'lib', 'addon-fit.js'));
});
app.get('/vendor/hljs-dark.css', (_req, res) => {
  res.sendFile(path.join(NM_DIR, 'highlight.js', 'styles', 'github-dark.min.css'));
});
app.get('/vendor/hljs-light.css', (_req, res) => {
  res.sendFile(path.join(NM_DIR, 'highlight.js', 'styles', 'github.min.css'));
});

const ASSET_VERSION = String(Date.now());

app.get(['/', '/index.html'], (_req, res) => {
  const htmlPath = path.join(PUBLIC_DIR, 'index.html');
  const html = fs
    .readFileSync(htmlPath, 'utf8')
    .replace('/styles.css', `/styles.css?v=${ASSET_VERSION}`)
    .replace('/app.js', `/app.js?v=${ASSET_VERSION}`);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      }
    }
  })
);

// ---- HTTP + WebSocket Server ----
const server = http.createServer(app);
const chatWss = new WebSocketServer({ noServer: true });
const termWss = new WebSocketServer({ noServer: true });

// Active agent runs keyed by conversationId
const activeRuns = new Map();
// Connected chat WebSockets
const chatClients = new Set();

function broadcastChat(payload) {
  const data = JSON.stringify(payload);
  for (const ws of chatClients) {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }
}

server.on('upgrade', (req, socket, head) => {
  if (!isAuthenticated(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/ws/chat') {
    chatWss.handleUpgrade(req, socket, head, (ws) => {
      chatWss.emit('connection', ws, req);
    });
  } else if (url.pathname === '/ws/terminal') {
    termWss.handleUpgrade(req, socket, head, (ws) => {
      termWss.emit('connection', ws, req, url);
    });
  } else {
    socket.destroy();
  }
});

// ---- Chat WebSocket ----
chatWss.on('connection', (ws) => {
  chatClients.add(ws);

  ws.on('close', () => {
    chatClients.delete(ws);
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }

    if (msg.type === 'abort') {
      const run = activeRuns.get(msg.conversationId);
      if (run) {
        run.handle.abort();
      }
      return;
    }

    if (msg.type === 'send') {
      const { conversationId, prompt, attachments } = msg;
      const text = String(prompt || '').trim();
      const safeAttachments = Array.isArray(attachments)
        ? attachments.filter((a) => a && a.path && a.name).slice(0, 12)
        : [];
      if (!conversationId || (!text && safeAttachments.length === 0)) return;

      if (activeRuns.has(conversationId)) {
        ws.send(JSON.stringify({ type: 'error', conversationId, error: '当前对话正在执行中，请等待完成或先点击停止' }));
        return;
      }

      const conv = store.getConversation(conversationId);
      if (!conv) {
        ws.send(JSON.stringify({ type: 'error', conversationId, error: '对话不存在' }));
        return;
      }

      const hostConfig = store.getHost(conv.hostId);
      if (!hostConfig) {
        ws.send(JSON.stringify({ type: 'error', conversationId, error: '关联主机不存在' }));
        return;
      }

      const userMsg = store.appendMessage(conversationId, {
        role: 'user',
        content: text,
        attachments: safeAttachments,
        status: 'done'
      });

      const assistantMsg = store.appendMessage(conversationId, {
        role: 'assistant',
        content: '',
        thinking: '',
        tools: [],
        files: [],
        error: '',
        status: 'streaming'
      });

      broadcastChat({
        type: 'turn.started',
        conversationId,
        title: conv.title,
        userMessage: userMsg,
        assistantMessage: assistantMsg
      });

      let lastEmit = 0;
      let pendingTimer = null;
      let latestState = null;

      const flushUpdate = () => {
        if (!latestState) return;
        lastEmit = Date.now();
        if (latestState.remoteSessionId && latestState.remoteSessionId !== conv.remoteSessionId) {
          store.updateConversation(conversationId, { remoteSessionId: latestState.remoteSessionId });
        }
        store.updateMessage(conversationId, assistantMsg.id, {
          content: latestState.content,
          thinking: latestState.thinking,
          tools: latestState.tools,
          files: latestState.files || [],
          error: latestState.error,
          usage: latestState.usage,
          status: 'streaming'
        });
        broadcastChat({
          type: 'turn.update',
          conversationId,
          messageId: assistantMsg.id,
          remoteSessionId: latestState.remoteSessionId || conv.remoteSessionId,
          ...latestState
        });
      };

      const handle = runAgentTurn({
        hostConfig,
        conversation: conv,
        prompt: text,
        attachments: safeAttachments,
        onUpdate(st) {
          latestState = st;
          const now = Date.now();
          if (now - lastEmit >= 70) {
            if (pendingTimer) {
              clearTimeout(pendingTimer);
              pendingTimer = null;
            }
            flushUpdate();
          } else if (!pendingTimer) {
            pendingTimer = setTimeout(() => {
              pendingTimer = null;
              flushUpdate();
            }, 70);
          }
        },
        onComplete(finalState) {
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
          }
          activeRuns.delete(conversationId);

          if (finalState.remoteSessionId) {
            store.updateConversation(conversationId, { remoteSessionId: finalState.remoteSessionId });
          }

          const saved = store.updateMessage(conversationId, assistantMsg.id, {
            content: finalState.content,
            thinking: finalState.thinking,
            tools: finalState.tools,
            files: finalState.files || [],
            error: finalState.error,
            usage: finalState.usage,
            exitCode: finalState.exitCode,
            status: finalState.status
          });

          broadcastChat({
            type: 'turn.completed',
            conversationId,
            message: saved,
            remoteSessionId: finalState.remoteSessionId || conv.remoteSessionId
          });
        }
      });

      activeRuns.set(conversationId, { handle, messageId: assistantMsg.id });
    }
  });
});

// ---- Interactive Terminal WebSocket ----
termWss.on('connection', async (ws, _req, url) => {
  const hostId = url.searchParams.get('hostId');
  const cwd = url.searchParams.get('cwd') || '';
  const cols = Number(url.searchParams.get('cols')) || 80;
  const rows = Number(url.searchParams.get('rows')) || 24;

  const hostConfig = store.getHost(hostId);
  if (!hostConfig) {
    ws.send(JSON.stringify({ type: 'error', error: '主机不存在' }));
    ws.close();
    return;
  }

  let shell = null;
  try {
    ws.send(JSON.stringify({ type: 'status', message: `正在连接 ${hostConfig.name}...` }));
    shell = await openPtyShell(hostConfig, {
      cols,
      rows,
      cwd,
      onData(data) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'output', data }));
        }
      },
      onClose() {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'exit' }));
          ws.close();
        }
      },
      onError(err) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'error', error: err.message || '终端连接异常' }));
        }
      }
    });
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'ready' }));
    }
  } catch (err) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'error', error: err.message || 'SSH 连接失败' }));
      ws.close();
    }
    return;
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      shell?.write(msg.data);
    } else if (msg.type === 'resize') {
      shell?.resize(Number(msg.cols) || 80, Number(msg.rows) || 24);
    }
  });

  ws.on('close', () => {
    shell?.close();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n🚀 SSH AI Chat 已启动: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`🔒 访问密码保护: ${APP_PASSWORD ? '已开启 (APP_PASSWORD)' : '未开启（可设置环境变量 APP_PASSWORD 开启）'}\n`);
});
