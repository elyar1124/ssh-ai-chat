import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

function defaultState() {
  return {
    hosts: [
      {
        id: 'local-default',
        name: '本机 (Local)',
        type: 'local',
        host: 'localhost',
        port: 22,
        username: process.env.USER || 'root',
        authType: 'none',
        password: '',
        privateKey: '',
        passphrase: '',
        defaultCwd: process.env.HOME || '/root',
        createdAt: Date.now()
      }
    ],
    conversations: [],
    settings: {
      theme: 'auto'
    }
  };
}

class Store {
  constructor() {
    ensureDataDir();
    this.state = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return {
          hosts: Array.isArray(parsed.hosts) && parsed.hosts.length > 0 ? parsed.hosts : defaultState().hosts,
          conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
          settings: parsed.settings || { theme: 'auto' }
        };
      }
    } catch (err) {
      console.error('[Store] Failed to read state.json, starting fresh:', err.message);
    }
    const init = defaultState();
    this._save(init);
    return init;
  }

  _save(state = this.state) {
    ensureDataDir();
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  }

  // ---- Hosts ----

  listHosts() {
    return this.state.hosts.map((h) => this.sanitizeHost(h));
  }

  getHost(id) {
    return this.state.hosts.find((h) => h.id === id) || null;
  }

  sanitizeHost(h) {
    const isTokenUser = h.authType === 'token' && h.username && h.username.length > 10;
    return {
      id: h.id,
      name: h.name,
      type: h.type || 'ssh',
      host: h.host,
      port: Number(h.port) || 22,
      username: h.username,
      usernameMasked: isTokenUser
        ? `${h.username.slice(0, 10)}••••${h.username.slice(-4)}`
        : h.username,
      authType: h.authType || 'token',
      hasPassword: Boolean(h.password),
      hasPrivateKey: Boolean(h.privateKey),
      privateKeyPath: h.privateKeyPath || '',
      defaultCwd: h.defaultCwd || '~',
      createdAt: h.createdAt
    };
  }

  createHost(input) {
    const id = `host_${crypto.randomBytes(6).toString('hex')}`;
    const host = {
      id,
      name: String(input.name || input.host || 'New Host').trim(),
      type: input.type === 'local' ? 'local' : 'ssh',
      host: String(input.host || '').trim(),
      port: Number(input.port) || 22,
      username: String(input.username || '').trim(),
      authType: ['token', 'password', 'key', 'none'].includes(input.authType) ? input.authType : 'token',
      password: String(input.password || ''),
      privateKey: String(input.privateKey || ''),
      privateKeyPath: String(input.privateKeyPath || '').trim(),
      passphrase: String(input.passphrase || ''),
      defaultCwd: String(input.defaultCwd || '~').trim() || '~',
      createdAt: Date.now()
    };
    this.state.hosts.push(host);
    this._save();
    return this.sanitizeHost(host);
  }

  updateHost(id, patch) {
    const existing = this.getHost(id);
    if (!existing) return null;

    if (patch.name !== undefined) existing.name = String(patch.name).trim();
    if (patch.type !== undefined) existing.type = patch.type === 'local' ? 'local' : 'ssh';
    if (patch.host !== undefined) existing.host = String(patch.host).trim();
    if (patch.port !== undefined) existing.port = Number(patch.port) || 22;
    if (patch.username !== undefined) existing.username = String(patch.username).trim();
    if (patch.authType !== undefined) existing.authType = patch.authType;
    if (patch.password) existing.password = String(patch.password);
    if (patch.clearPassword) existing.password = '';
    if (patch.privateKey) existing.privateKey = String(patch.privateKey);
    if (patch.clearPrivateKey) existing.privateKey = '';
    if (patch.privateKeyPath !== undefined) existing.privateKeyPath = String(patch.privateKeyPath).trim();
    if (patch.passphrase) existing.passphrase = String(patch.passphrase);
    if (patch.defaultCwd !== undefined) existing.defaultCwd = String(patch.defaultCwd).trim() || '~';

    this._save();
    return this.sanitizeHost(existing);
  }

  deleteHost(id) {
    const idx = this.state.hosts.findIndex((h) => h.id === id);
    if (idx === -1) return false;
    this.state.hosts.splice(idx, 1);
    // Keep conversations or remove orphaned ones
    this.state.conversations = this.state.conversations.filter((c) => c.hostId !== id);
    this._save();
    return true;
  }

  // ---- Conversations ----

  listConversations(hostId = null) {
    const list = hostId
      ? this.state.conversations.filter((c) => c.hostId === hostId)
      : this.state.conversations;
    return list
      .slice()
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
      .map((c) => ({
        id: c.id,
        hostId: c.hostId,
        title: c.title,
        agent: c.agent,
        cwd: c.cwd,
        remoteSessionId: c.remoteSessionId || null,
        options: c.options || {},
        messageCount: c.messages.length,
        lastMessagePreview: c.messages.length
          ? String(c.messages[c.messages.length - 1].content || '').slice(0, 80)
          : '',
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      }));
  }

  getConversation(id) {
    return this.state.conversations.find((c) => c.id === id) || null;
  }

  createConversation(input) {
    const host = this.getHost(input.hostId);
    if (!host) throw new Error('Host not found');

    const agent = ['agy', 'codex', 'shell'].includes(input.agent) ? input.agent : 'codex';
    const id = `conv_${crypto.randomBytes(6).toString('hex')}`;
    const now = Date.now();
    const conv = {
      id,
      hostId: host.id,
      title: String(input.title || '新对话').trim(),
      agent,
      cwd: String(input.cwd || host.defaultCwd || '~').trim() || '~',
      remoteSessionId: null,
      options: {
        model: String(input.options?.model || '').trim(),
        agyMode: input.options?.agyMode || 'auto',
        autoApprove: input.options?.autoApprove !== false
      },
      messages: [],
      createdAt: now,
      updatedAt: now
    };
    this.state.conversations.push(conv);
    this._save();
    return conv;
  }

  updateConversation(id, patch) {
    const conv = this.getConversation(id);
    if (!conv) return null;
    if (patch.title !== undefined) conv.title = String(patch.title).trim();
    if (patch.agent !== undefined && ['agy', 'codex', 'shell'].includes(patch.agent)) {
      if (conv.agent !== patch.agent) {
        conv.agent = patch.agent;
        conv.remoteSessionId = null; // reset session when switching agent engine
      }
    }
    if (patch.cwd !== undefined) conv.cwd = String(patch.cwd).trim() || '~';
    if (patch.remoteSessionId !== undefined) conv.remoteSessionId = patch.remoteSessionId;
    if (patch.options) {
      conv.options = { ...(conv.options || {}), ...patch.options };
    }
    conv.updatedAt = Date.now();
    this._save();
    return conv;
  }

  appendMessage(convId, message) {
    const conv = this.getConversation(convId);
    if (!conv) return null;
    const msg = {
      id: message.id || `msg_${crypto.randomBytes(5).toString('hex')}`,
      role: message.role,
      content: message.content || '',
      thinking: message.thinking || '',
      tools: Array.isArray(message.tools) ? message.tools : [],
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
      files: Array.isArray(message.files) ? message.files : [],
      error: message.error || '',
      usage: message.usage || null,
      exitCode: message.exitCode ?? null,
      status: message.status || 'done',
      createdAt: message.createdAt || Date.now()
    };
    conv.messages.push(msg);
    if (conv.messages.length === 1 && msg.role === 'user' && (conv.title === '新对话' || !conv.title)) {
      const firstLabel = msg.content.replace(/\s+/g, ' ').trim()
        || (msg.attachments[0]?.name ? `文件: ${msg.attachments[0].name}` : '新对话');
      conv.title = firstLabel.slice(0, 32) || '新对话';
    }
    conv.updatedAt = Date.now();
    this._save();
    return msg;
  }

  updateMessage(convId, msgId, patch) {
    const conv = this.getConversation(convId);
    if (!conv) return null;
    const msg = conv.messages.find((m) => m.id === msgId);
    if (!msg) return null;
    Object.assign(msg, patch);
    conv.updatedAt = Date.now();
    this._save();
    return msg;
  }

  deleteConversation(id) {
    const idx = this.state.conversations.findIndex((c) => c.id === id);
    if (idx === -1) return false;
    this.state.conversations.splice(idx, 1);
    this._save();
    return true;
  }

  upsertSyncedConversation(hostId, detail) {
    let conv = this.state.conversations.find(
      (c) => c.hostId === hostId && c.agent === detail.agent && c.remoteSessionId === detail.sessionId
    );
    const now = Date.now();
    const mappedMsgs = (detail.messages || []).map((m, idx) => ({
      id: m.id || `sync_${idx}`,
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content || '',
      thinking: m.thinking || '',
      tools: Array.isArray(m.tools) ? m.tools : [],
      attachments: [],
      files: [],
      error: '',
      usage: m.usage || null,
      exitCode: null,
      status: 'done',
      createdAt: m.createdAt || now
    }));

    if (conv) {
      conv.title = detail.title || conv.title;
      conv.cwd = detail.cwd || conv.cwd;
      if (detail.model) conv.options = { ...(conv.options || {}), model: detail.model };
      if (detail.effort) conv.options = { ...(conv.options || {}), effort: detail.effort };
      // Preserve any locally attached/detected files on matching messages where possible
      if (mappedMsgs.length >= conv.messages.length || mappedMsgs.length > 0) {
        conv.messages = mappedMsgs;
      }
      conv.updatedAt = mappedMsgs.length
        ? Math.max(now, mappedMsgs[mappedMsgs.length - 1].createdAt || 0)
        : now;
      this._save();
      return conv;
    }

    const id = `conv_${crypto.randomBytes(6).toString('hex')}`;
    conv = {
      id,
      hostId,
      title: detail.title || `${detail.agent === 'agy' ? 'AGY' : 'Codex'} 会话`,
      agent: detail.agent,
      cwd: detail.cwd || '~',
      remoteSessionId: detail.sessionId,
      options: {
        model: detail.model || '',
        effort: detail.effort || '',
        agyMode: 'auto',
        autoApprove: true
      },
      messages: mappedMsgs,
      createdAt: mappedMsgs[0]?.createdAt || now,
      updatedAt: mappedMsgs[mappedMsgs.length - 1]?.createdAt || now
    };
    this.state.conversations.push(conv);
    this._save();
    return conv;
  }
}

export const store = new Store();
