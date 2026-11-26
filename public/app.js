/* SSH AI Chat - Mobile-First PWA Client */
(() => {
  const $ = (id) => document.getElementById(id);

  // ---- App State ----
  const state = {
    hosts: [],
    conversations: [],
    selectedHostId: localStorage.getItem('ssh_ai_host') || null,
    selectedConvId: localStorage.getItem('ssh_ai_conv') || null,
    activeConv: null,
    runningConvIds: new Set(),
    pendingAttachments: [], // [{ path, name, size, isImage, uploading }]
    hostModels: {}, // hostId -> { codex: {...}, agy: {...} }
    activeTab: 'chat', // 'chat' | 'files' | 'terminal'
    filesDir: '~',
    filesParent: null,
    chatWs: null,
    termWs: null,
    term: null,
    fitAddon: null,
    termFontSize: Number(localStorage.getItem('ssh_ai_term_font')) || 14,
    theme: localStorage.getItem('ssh_ai_theme') || 'dark'
  };

  // ---- Theme ----
  function applyTheme(theme) {
    state.theme = theme;
    localStorage.setItem('ssh_ai_theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.content = theme === 'light' ? '#f8fafc' : '#0d1117';
  }
  applyTheme(state.theme);

  // ---- Toast ----
  let toastTimer = null;
  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  // ---- Formatting Helpers ----
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function fileIconFor(name, isDir) {
    if (isDir) return '📁';
    const lower = String(name || '').toLowerCase();
    if (/\.(png|jpe?g|gif|webp|svg|bmp|heic)$/.test(lower)) return '🖼️';
    if (/\.(docx?|rtf|odt)$/.test(lower)) return '📝';
    if (/\.(xlsx?|csv)$/.test(lower)) return '📊';
    if (/\.(pptx?)$/.test(lower)) return '📽️';
    if (/\.pdf$/.test(lower)) return '📕';
    if (/\.(zip|tar|gz|7z|rar)$/.test(lower)) return '📦';
    if (/\.(md|txt|log)$/.test(lower)) return '📄';
    if (/\.(js|ts|py|go|rs|java|c|cpp|sh|json|yml|yaml|html|css)$/.test(lower)) return '💻';
    return '📎';
  }

  function isPreviewableInBrowser(name) {
    return /\.(pdf|md|txt|log|json|csv|html|htm|png|jpe?g|gif|webp|svg)$/i.test(String(name || ''));
  }

  function buildFileDownloadUrl(hostId, filePath, inline = false) {
    return `/api/hosts/${encodeURIComponent(hostId)}/files/download?path=${encodeURIComponent(filePath)}${inline ? '&inline=1' : ''}`;
  }

  // ---- API Helper ----
  async function api(url, opts = {}) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
      body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showAuthScreen();
      throw new Error(data.error || '未登录');
    }
    if (!res.ok) {
      throw new Error(data.error || `请求失败 (${res.status})`);
    }
    return data;
  }

  async function uploadRawFile(hostId, dir, file, mode = 'chat') {
    const url = `/api/hosts/${encodeURIComponent(hostId)}/files/upload?dir=${encodeURIComponent(dir || '~')}&mode=${encodeURIComponent(mode)}`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name || `upload_${Date.now()}.bin`)
      },
      body: file
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showAuthScreen();
      throw new Error('未登录');
    }
    if (!res.ok) {
      throw new Error(data.error || `上传失败 (${res.status})`);
    }
    return data.file;
  }

  // ---- Markdown Setup ----
  const renderer = new marked.Renderer();
  renderer.code = function (codeArg, langArg) {
    const codeText = typeof codeArg === 'object' ? (codeArg.text || '') : String(codeArg || '');
    const lang = typeof codeArg === 'object' ? (codeArg.lang || '') : String(langArg || '');
    const escaped = escapeHtml(codeText);
    const label = escapeHtml(lang || 'code');
    const encoded = encodeURIComponent(codeText);
    return `
      <div class="code-block-wrap">
        <div class="code-block-header">
          <span>${label}</span>
          <button type="button" class="copy-code-btn" data-copy="${encoded}">复制</button>
        </div>
        <pre><code>${escaped}</code></pre>
      </div>
    `;
  };
  marked.setOptions({ gfm: true, breaks: true, renderer });

  function renderMarkdown(text) {
    if (!text) return '';
    try {
      return marked.parse(text);
    } catch {
      return `<pre>${escapeHtml(text)}</pre>`;
    }
  }

  // ---- Image Preview Lightbox ----
  function openImagePreview(hostId, filePath, fileName) {
    const inlineUrl = buildFileDownloadUrl(hostId, filePath, true);
    const dlUrl = buildFileDownloadUrl(hostId, filePath, false);
    $('preview-title').textContent = fileName || '图片预览';
    $('preview-img').src = inlineUrl;
    $('preview-download-link').href = dlUrl;
    $('preview-download-link').setAttribute('download', fileName || 'image');
    $('preview-modal').classList.remove('hidden');
  }

  // ---- Auth ----
  function showAuthScreen() {
    $('auth-screen').classList.remove('hidden');
    $('auth-password').focus();
  }

  function hideAuthScreen() {
    $('auth-screen').classList.add('hidden');
  }

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('auth-error');
    errEl.classList.add('hidden');
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: { password: $('auth-password').value }
      });
      $('auth-password').value = '';
      hideAuthScreen();
      $('btn-logout').classList.remove('hidden');
      await bootstrapApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  $('btn-logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.reload();
  });

  // ---- Drawer Control ----
  function openDrawer() {
    $('sidebar').classList.add('open');
    $('drawer-backdrop').classList.remove('hidden');
  }

  function closeDrawer() {
    $('sidebar').classList.remove('open');
    $('drawer-backdrop').classList.add('hidden');
  }

  $('btn-menu').addEventListener('click', openDrawer);
  $('btn-close-drawer').addEventListener('click', closeDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);

  // ---- Theme Toggle ----
  $('btn-toggle-theme').addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  // ---- Chat WebSocket (with Heartbeat & Fast Mobile Reconnect) ----
  let chatPingTimer = null;
  let chatPongTimeout = null;
  let chatReconnectTimer = null;

  function stopChatHeartbeat() {
    clearInterval(chatPingTimer);
    clearTimeout(chatPongTimeout);
    chatPingTimer = null;
    chatPongTimeout = null;
  }

  function connectChatWs(force = false) {
    if (!force && state.chatWs && (state.chatWs.readyState === 0 || state.chatWs.readyState === 1)) return;
    if (force && state.chatWs) {
      try { state.chatWs.close(); } catch {}
      state.chatWs = null;
    }
    clearTimeout(chatReconnectTimer);
    stopChatHeartbeat();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/chat`);
    state.chatWs = ws;

    ws.onopen = () => {
      stopChatHeartbeat();
      chatPingTimer = setInterval(() => {
        if (ws.readyState !== 1) return;
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
        clearTimeout(chatPongTimeout);
        chatPongTimeout = setTimeout(() => {
          if (state.chatWs === ws) {
            try { ws.close(); } catch {}
          }
        }, 8000);
      }, 20000);
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'pong') {
        clearTimeout(chatPongTimeout);
        return;
      }

      if (msg.type === 'error') {
        showToast(msg.error || '发生错误');
        return;
      }

      if (msg.type === 'turn.started') {
        state.runningConvIds.add(msg.conversationId);
        if (state.activeConv && state.activeConv.id === msg.conversationId) {
          state.activeConv.title = msg.title || state.activeConv.title;
          state.activeConv.messages.push(msg.userMessage, msg.assistantMessage);
          renderMessages(true);
          renderTopbar();
          updateSendButton();
        }
        refreshConversations();
        return;
      }

      if (msg.type === 'turn.update') {
        if (state.activeConv && state.activeConv.id === msg.conversationId) {
          if (msg.remoteSessionId) state.activeConv.remoteSessionId = msg.remoteSessionId;
          const m = state.activeConv.messages.find((x) => x.id === msg.messageId);
          if (m) {
            m.content = msg.content || '';
            m.thinking = msg.thinking || '';
            m.tools = msg.tools || [];
            m.files = msg.files || [];
            m.error = msg.error || '';
            m.usage = msg.usage || null;
            updateAssistantMessageDom(m);
          }
        }
        return;
      }

      if (msg.type === 'turn.completed') {
        state.runningConvIds.delete(msg.conversationId);
        if (state.activeConv && state.activeConv.id === msg.conversationId) {
          if (msg.remoteSessionId) state.activeConv.remoteSessionId = msg.remoteSessionId;
          const idx = state.activeConv.messages.findIndex((x) => x.id === msg.message.id);
          if (idx !== -1) {
            state.activeConv.messages[idx] = msg.message;
          }
          updateAssistantMessageDom(msg.message);
          updateSendButton();
        }
        refreshConversations();
      }
    };

    ws.onclose = () => {
      if (state.chatWs === ws) {
        stopChatHeartbeat();
        chatReconnectTimer = setTimeout(() => connectChatWs(false), 1800);
      }
    };
  }

  // Reconnect immediately when returning to the app on iOS/mobile or recovering network
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!state.chatWs || state.chatWs.readyState !== 1) {
        connectChatWs(true);
      } else {
        try { state.chatWs.send(JSON.stringify({ type: 'ping' })); } catch {}
      }
      if (state.activeConv && state.runningConvIds.has(state.activeConv.id)) {
        selectConversation(state.activeConv.id).catch(() => {});
      }
    }
  });

  window.addEventListener('online', () => {
    connectChatWs(true);
  });

  // ---- Hosts Rendering & Management ----
  function getSelectedHost() {
    return state.hosts.find((h) => h.id === state.selectedHostId) || state.hosts[0] || null;
  }

  function renderHostList() {
    const container = $('host-list');
    container.innerHTML = '';

    for (const h of state.hosts) {
      const active = h.id === state.selectedHostId;
      const el = document.createElement('div');
      el.className = `list-item ${active ? 'active' : ''}`;
      el.innerHTML = `
        <span class="host-dot ${h.type === 'local' ? 'local' : ''}"></span>
        <div class="list-item-main">
          <div class="list-item-title">${escapeHtml(h.name)}</div>
          <div class="list-item-sub">${h.type === 'local' ? '本机运行' : escapeHtml(`${h.usernameMasked}@${h.host}:${h.port}`)}</div>
        </div>
        <button class="item-action-btn" data-edit-host="${h.id}" title="编辑主机">⋯</button>
      `;

      el.addEventListener('click', async (e) => {
        if (e.target.closest('[data-edit-host]')) {
          openHostModal(h);
          return;
        }
        await selectHost(h.id);
        closeDrawer();
      });

      container.appendChild(el);
    }
  }

  async function selectHost(hostId) {
    state.selectedHostId = hostId;
    state.pendingAttachments = [];
    renderPendingAttachments();
    localStorage.setItem('ssh_ai_host', hostId);
    renderHostList();
    await refreshConversations();

    const hostConvs = state.conversations;
    if (hostConvs.length > 0) {
      const keep = hostConvs.find((c) => c.id === state.selectedConvId);
      await selectConversation((keep || hostConvs[0]).id);
    } else {
      await createNewConversation('codex');
    }

    const host = getSelectedHost();
    state.filesDir = state.activeConv?.cwd || host?.defaultCwd || '~';
    if (state.activeTab === 'files') {
      loadFilesDir(state.filesDir);
    } else if (state.activeTab === 'terminal') {
      reconnectTerminal();
    }
  }

  // ---- Conversations Rendering & Management ----
  async function refreshConversations() {
    const host = getSelectedHost();
    if (!host) {
      state.conversations = [];
      renderConvList();
      return;
    }
    const data = await api(`/api/conversations?hostId=${encodeURIComponent(host.id)}`);
    state.conversations = data.conversations || [];
    renderConvList();
  }

  function renderConvList() {
    const container = $('conv-list');
    container.innerHTML = '';

    if (state.conversations.length === 0) {
      container.innerHTML = `<div style="padding:12px;color:var(--text-muted);font-size:13px;">暂无对话，点击右上角「+ 新对话」开始</div>`;
      return;
    }

    for (const c of state.conversations) {
      const active = c.id === state.selectedConvId;
      const agentLabel = c.agent === 'agy' ? 'AGY' : c.agent === 'shell' ? 'Shell' : 'Codex';
      const el = document.createElement('div');
      el.className = `list-item ${active ? 'active' : ''}`;
      el.innerHTML = `
        <div class="list-item-main">
          <div class="list-item-title">${escapeHtml(c.title || '新对话')}</div>
          <div class="list-item-sub">${agentLabel} · ${escapeHtml(c.cwd || '~')}</div>
        </div>
        <button class="item-action-btn" data-del-conv="${c.id}" title="删除">🗑</button>
      `;

      el.addEventListener('click', async (e) => {
        if (e.target.closest('[data-del-conv]')) {
          if (confirm('确定删除这条对话记录？')) {
            await deleteConversation(c.id);
          }
          return;
        }
        await selectConversation(c.id);
        closeDrawer();
      });

      container.appendChild(el);
    }
  }

  async function createNewConversation(agent = 'codex') {
    const host = getSelectedHost();
    if (!host) {
      openHostModal(null);
      return;
    }
    const { conversation } = await api('/api/conversations', {
      method: 'POST',
      body: {
        hostId: host.id,
        agent,
        cwd: host.defaultCwd || '~'
      }
    });
    await refreshConversations();
    await selectConversation(conversation.id);
  }

  async function selectConversation(convId) {
    const data = await api(`/api/conversations/${encodeURIComponent(convId)}`);
    state.selectedConvId = convId;
    localStorage.setItem('ssh_ai_conv', convId);
    state.activeConv = data.conversation;
    state.pendingAttachments = [];
    renderPendingAttachments();
    if (data.running) state.runningConvIds.add(convId);
    else state.runningConvIds.delete(convId);

    renderConvList();
    renderTopbar();
    renderComposerMeta();
    renderMessages(true);
    updateSendButton();
  }

  async function deleteConversation(convId) {
    await api(`/api/conversations/${encodeURIComponent(convId)}`, { method: 'DELETE' });
    await refreshConversations();
    if (state.selectedConvId === convId) {
      if (state.conversations.length > 0) {
        await selectConversation(state.conversations[0].id);
      } else {
        await createNewConversation('codex');
      }
    }
  }

  $('btn-new-chat').addEventListener('click', async () => {
    const currentAgent = state.activeConv?.agent || 'codex';
    await createNewConversation(currentAgent);
    closeDrawer();
  });

  // ---- Topbar & Composer Meta ----
  function renderTopbar() {
    const host = getSelectedHost();
    const conv = state.activeConv;
    $('topbar-title').textContent = conv ? (conv.title || '新对话') : 'SSH AI Chat';
    $('topbar-subtitle').textContent = host
      ? `${host.name}${conv?.cwd ? ` · ${conv.cwd}` : ''}`
      : '点击左上角添加 SSH 主机';

    const badge = $('topbar-agent-badge');
    const agent = conv?.agent || 'codex';
    badge.className = `agent-badge ${agent}`;
    badge.textContent = agent === 'agy' ? 'AGY' : agent === 'shell' ? 'Shell' : 'Codex';
  }

  function renderComposerMeta() {
    const conv = state.activeConv;
    const agent = conv?.agent || 'codex';
    document.querySelectorAll('.pill-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.agent === agent);
    });

    const modelPill = $('btn-model-pill');
    if (agent === 'shell') {
      modelPill.classList.add('hidden');
    } else {
      modelPill.classList.remove('hidden');
      const m = conv?.options?.model || '';
      const eff = conv?.options?.effort || '';
      const hostCatalog = state.hostModels[conv?.hostId || state.selectedHostId];
      let label = m;
      if (!label) {
        if (agent === 'codex' && hostCatalog?.codex?.defaultModel) {
          label = `${hostCatalog.codex.defaultModel} (默认)`;
        } else {
          label = '默认模型';
        }
      } else if (hostCatalog) {
        const list = agent === 'agy' ? hostCatalog.agy?.models : hostCatalog.codex?.models;
        const found = (list || []).find((x) => x.id === m);
        if (found?.name) label = found.name;
      }
      modelPill.textContent = `🤖 ${label}${eff ? ` · ${eff}` : ''}`;
    }

    $('btn-cwd-pill').textContent = `📁 ${conv?.cwd || '~'}`;
    const canSync = Boolean(conv?.remoteSessionId && (conv.agent === 'codex' || conv.agent === 'agy'));
    $('btn-sync-conv').classList.toggle('hidden', !canSync);
    const input = $('prompt-input');
    if (agent === 'codex') input.placeholder = '给 Codex CLI 发指令（点 + 可传图/传文件）...';
    else if (agent === 'agy') input.placeholder = '给 Antigravity CLI 发指令（点 + 可传图/传文件）...';
    else input.placeholder = '输入要在远端执行的 Shell 命令...';
  }

  document.querySelectorAll('.pill-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.activeConv) return;
      const nextAgent = btn.dataset.agent;
      if (state.activeConv.agent === nextAgent) return;
      const { conversation } = await api(`/api/conversations/${state.activeConv.id}`, {
        method: 'PATCH',
        body: { agent: nextAgent }
      });
      state.activeConv = conversation;
      renderTopbar();
      renderComposerMeta();
      refreshConversations();
      showToast(`已切换为 ${nextAgent === 'agy' ? 'Antigravity CLI' : nextAgent === 'shell' ? 'Shell 模式' : 'Codex CLI'}`);
    });
  });

  $('btn-cwd-pill').addEventListener('click', async () => {
    if (!state.activeConv) return;
    const next = prompt('设置远端工作目录 (cwd)：', state.activeConv.cwd || '~');
    if (next === null) return;
    const { conversation } = await api(`/api/conversations/${state.activeConv.id}`, {
      method: 'PATCH',
      body: { cwd: next.trim() || '~' }
    });
    state.activeConv = conversation;
    renderTopbar();
    renderComposerMeta();
  });

  // ---- Chat Attachment Uploads ----
  function renderPendingAttachments() {
    const strip = $('pending-attachments');
    if (state.pendingAttachments.length === 0) {
      strip.classList.add('hidden');
      strip.innerHTML = '';
      return;
    }
    strip.classList.remove('hidden');
    const hostId = state.activeConv?.hostId || state.selectedHostId;

    strip.innerHTML = state.pendingAttachments.map((att, idx) => {
      const thumb = att.isImage && att.path && !att.uploading
        ? `<img src="${buildFileDownloadUrl(hostId, att.path, true)}" alt="" />`
        : `<span style="font-size:20px;">${att.uploading ? '⏳' : fileIconFor(att.name, false)}</span>`;
      return `
        <div class="pending-chip">
          ${thumb}
          <div class="pending-chip-info">
            <div class="pending-chip-name">${escapeHtml(att.name)}</div>
            <div class="pending-chip-size">${att.uploading ? '上传中...' : formatBytes(att.size)}</div>
          </div>
          <button type="button" class="pending-chip-remove" data-remove-att="${idx}">✕</button>
        </div>
      `;
    }).join('');

    strip.querySelectorAll('[data-remove-att]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.pendingAttachments.splice(Number(btn.dataset.removeAtt), 1);
        renderPendingAttachments();
      });
    });
  }

  async function handleChatFilesSelected(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    const host = getSelectedHost();
    if (!host) {
      showToast('请先选择主机');
      return;
    }
    const targetDir = state.activeConv?.cwd || host.defaultCwd || '~';

    for (const f of files) {
      const placeholder = {
        name: f.name || `image_${Date.now()}.png`,
        size: f.size,
        isImage: f.type?.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic)$/i.test(f.name || ''),
        uploading: true,
        path: ''
      };
      state.pendingAttachments.push(placeholder);
      renderPendingAttachments();

      try {
        const uploaded = await uploadRawFile(host.id, targetDir, f, 'chat');
        Object.assign(placeholder, uploaded, { uploading: false });
        renderPendingAttachments();
      } catch (err) {
        const idx = state.pendingAttachments.indexOf(placeholder);
        if (idx !== -1) state.pendingAttachments.splice(idx, 1);
        renderPendingAttachments();
        showToast(`上传失败: ${err.message}`);
      }
    }
  }

  // Attach menu toggle
  $('btn-attach').addEventListener('click', (e) => {
    e.stopPropagation();
    $('attach-menu').classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#attach-menu') && !e.target.closest('#btn-attach')) {
      $('attach-menu').classList.add('hidden');
    }
  });

  $('btn-pick-image').addEventListener('click', () => {
    $('attach-menu').classList.add('hidden');
    $('input-image-file').value = '';
    $('input-image-file').click();
  });

  $('btn-pick-file').addEventListener('click', () => {
    $('attach-menu').classList.add('hidden');
    $('input-any-file').value = '';
    $('input-any-file').click();
  });

  $('btn-pick-remote').addEventListener('click', () => {
    $('attach-menu').classList.add('hidden');
    switchTab('files');
  });

  $('input-image-file').addEventListener('change', (e) => handleChatFilesSelected(e.target.files));
  $('input-any-file').addEventListener('change', (e) => handleChatFilesSelected(e.target.files));

  // Support pasting screenshots/files directly into the textarea
  $('prompt-input').addEventListener('paste', (e) => {
    const items = e.clipboardData?.files;
    if (items && items.length > 0) {
      e.preventDefault();
      handleChatFilesSelected(items);
    }
  });

  // ---- Messages Rendering ----
  function buildOutputFilesHtml(files, hostId) {
    if (!Array.isArray(files) || files.length === 0 || !hostId) return '';

    const cards = files.map((f) => {
      const dlUrl = buildFileDownloadUrl(hostId, f.path, false);
      const inlineUrl = buildFileDownloadUrl(hostId, f.path, true);
      const encodedPath = encodeURIComponent(f.path);
      const encodedName = encodeURIComponent(f.name);

      if (f.isImage) {
        return `
          <div class="file-card" style="flex-direction:column;align-items:stretch;">
            <div style="display:flex;align-items:center;gap:10px;">
              <div class="file-card-icon">🖼️</div>
              <div class="file-card-info">
                <div class="file-card-name">${escapeHtml(f.name)}</div>
                <div class="file-card-meta">${formatBytes(f.size)} · ${escapeHtml(f.path)}</div>
              </div>
              <div class="file-card-actions">
                <a class="file-action-link primary" href="${dlUrl}" download="${escapeHtml(f.name)}">下载</a>
              </div>
            </div>
            <img class="output-image-preview" src="${inlineUrl}" data-preview-path="${encodedPath}" data-preview-name="${encodedName}" alt="${escapeHtml(f.name)}" loading="lazy" />
          </div>
        `;
      }

      const previewBtn = isPreviewableInBrowser(f.name)
        ? `<a class="file-action-link secondary" href="${inlineUrl}" target="_blank" rel="noopener">预览</a>`
        : '';

      return `
        <div class="file-card">
          <div class="file-card-icon">${fileIconFor(f.name, false)}</div>
          <div class="file-card-info">
            <div class="file-card-name">${escapeHtml(f.name)}</div>
            <div class="file-card-meta">${formatBytes(f.size)} · ${escapeHtml(f.path)}</div>
          </div>
          <div class="file-card-actions">
            ${previewBtn}
            <a class="file-action-link primary" href="${dlUrl}" download="${escapeHtml(f.name)}">下载</a>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="output-files-box">
        <div class="output-files-title">📎 生成 / 相关文件（点击即可下载到手机）</div>
        ${cards}
      </div>
    `;
  }

  function buildAssistantInnerHtml(msg, agent, hostId) {
    const parts = [];

    if (msg.thinking) {
      const openAttr = msg.status === 'streaming' && !msg.content ? 'open' : '';
      parts.push(`
        <details class="thinking-box" ${openAttr}>
          <summary><span>💭</span><span>思考过程</span></summary>
          <div class="thinking-body">${escapeHtml(msg.thinking)}</div>
        </details>
      `);
    }

    if (Array.isArray(msg.tools) && msg.tools.length > 0) {
      for (const t of msg.tools) {
        const bodyParts = [];
        if (t.input) bodyParts.push(`$ ${t.input}`);
        if (t.output) bodyParts.push(t.output);
        const bodyText = bodyParts.join('\n\n') || '(无输出)';
        parts.push(`
          <details class="tool-card">
            <summary>
              <span class="tool-status-dot ${t.status || 'done'}"></span>
              <span class="tool-name">${escapeHtml(t.name || 'Tool')}</span>
              <span class="tool-title">${escapeHtml(t.title || '')}</span>
            </summary>
            <div class="tool-body">${escapeHtml(bodyText)}</div>
          </details>
        `);
      }
    }

    if (msg.content) {
      if (agent === 'shell') {
        const encoded = encodeURIComponent(msg.content);
        parts.push(`
          <div class="code-block-wrap">
            <div class="code-block-header">
              <span>stdout</span>
              <button type="button" class="copy-code-btn" data-copy="${encoded}">复制</button>
            </div>
            <pre><code>${escapeHtml(msg.content)}</code></pre>
          </div>
        `);
      } else {
        parts.push(`<div class="md-content">${renderMarkdown(msg.content)}</div>`);
      }
    }

    // Auto-detected generated / referenced files with download buttons
    if (Array.isArray(msg.files) && msg.files.length > 0) {
      parts.push(buildOutputFilesHtml(msg.files, hostId));
    }

    if (msg.status === 'streaming') {
      parts.push(`
        <div class="streaming-indicator">
          <span class="streaming-dots"><span></span><span></span><span></span></span>
          <span>${msg.tools?.some((t) => t.status === 'running') ? '正在远端执行工具...' : '正在思考并输出...'}</span>
        </div>
      `);
    }

    if (msg.error) {
      parts.push(`<div class="msg-error-box">${escapeHtml(msg.error)}</div>`);
    }

    const meta = [];
    if (msg.status !== 'streaming') {
      if (msg.exitCode !== null && msg.exitCode !== undefined && agent === 'shell') {
        meta.push(`退出码: ${msg.exitCode}`);
      }
      if (msg.usage) {
        const inTok = msg.usage.input_tokens ?? msg.usage.inputTokens;
        const outTok = msg.usage.output_tokens ?? msg.usage.outputTokens;
        if (inTok || outTok) meta.push(`Tokens: ${inTok || 0} in / ${outTok || 0} out`);
      }
    }
    if (meta.length) {
      parts.push(`<div class="msg-meta-footer">${meta.map((m) => `<span>${escapeHtml(m)}</span>`).join('')}</div>`);
    }

    return parts.join('');
  }

  function buildUserAttachmentsHtml(attachments, hostId) {
    if (!Array.isArray(attachments) || attachments.length === 0 || !hostId) return '';
    const items = attachments.map((att) => {
      const inlineUrl = buildFileDownloadUrl(hostId, att.path, true);
      const dlUrl = buildFileDownloadUrl(hostId, att.path, false);
      if (att.isImage) {
        return `<img class="user-att-img" src="${inlineUrl}" data-preview-path="${encodeURIComponent(att.path)}" data-preview-name="${encodeURIComponent(att.name)}" alt="${escapeHtml(att.name)}" loading="lazy" />`;
      }
      return `<a class="user-att-file" href="${dlUrl}" download="${escapeHtml(att.name)}"><span>${fileIconFor(att.name, false)}</span><span>${escapeHtml(att.name)}</span></a>`;
    }).join('');
    return `<div class="user-attachments">${items}</div>`;
  }

  function renderMessages(scrollToBottom = false) {
    const container = $('messages-container');
    const conv = state.activeConv;
    const host = getSelectedHost();

    if (!conv || conv.messages.length === 0) {
      const hostName = host ? host.name : '未配置主机';
      container.innerHTML = `
        <div class="empty-state">
          <img src="/icon.svg" alt="" />
          <h3>随时随地指挥远端 AI</h3>
          <p>当前主机：<strong>${escapeHtml(hostName)}</strong><br/>支持点左下角 <strong>+</strong> 上传图片或文档给 AI，AI 生成的 Word/PDF/图片会自动出现下载卡片，也可在顶部「文件」页随时互传。</p>
          <div class="quick-chips">
            <button class="quick-chip" data-prompt="查看当前目录结构和 git 状态">查看项目状态</button>
            <button class="quick-chip" data-prompt="帮我检查当前服务器磁盘、内存和运行中的服务">检查服务器状态</button>
            <button class="quick-chip" data-prompt="列出当前目录中最近修改的文档文件">查看最新文档</button>
          </div>
        </div>
      `;
      container.querySelectorAll('.quick-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          $('prompt-input').value = chip.dataset.prompt;
          sendPrompt();
        });
      });
      return;
    }

    container.innerHTML = '';
    const agent = conv.agent || 'codex';
    const hostId = conv.hostId;
    const agentName = agent === 'agy' ? 'Antigravity' : agent === 'shell' ? 'Shell' : 'Codex';
    const avatarText = agent === 'agy' ? 'AG' : agent === 'shell' ? '$_' : 'CX';

    for (const msg of conv.messages) {
      const row = document.createElement('div');
      row.className = `msg-row ${msg.role}`;
      row.dataset.msgId = msg.id;

      if (msg.role === 'user') {
        const attHtml = buildUserAttachmentsHtml(msg.attachments, hostId);
        const textHtml = msg.content ? `<div class="msg-bubble-user">${escapeHtml(msg.content)}</div>` : '';
        row.innerHTML = `${attHtml}${textHtml}`;
      } else {
        row.innerHTML = `
          <div class="msg-assistant-header">
            <span class="assistant-avatar ${agent}">${avatarText}</span>
            <span>${agentName}</span>
          </div>
          <div class="msg-assistant-body">${buildAssistantInnerHtml(msg, agent, hostId)}</div>
        `;
      }
      container.appendChild(row);
    }

    if (scrollToBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }

  function updateAssistantMessageDom(msg) {
    const container = $('messages-container');
    const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 140;
    const row = container.querySelector(`.msg-row[data-msg-id="${msg.id}"]`);
    const agent = state.activeConv?.agent || 'codex';
    const hostId = state.activeConv?.hostId;

    if (row) {
      const body = row.querySelector('.msg-assistant-body');
      if (body) body.innerHTML = buildAssistantInnerHtml(msg, agent, hostId);
    } else {
      renderMessages(true);
      return;
    }

    if (wasNearBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }

  // Copy code block & image preview delegation inside messages
  $('messages-container').addEventListener('click', async (e) => {
    const previewImg = e.target.closest('[data-preview-path]');
    if (previewImg) {
      const hostId = state.activeConv?.hostId || state.selectedHostId;
      openImagePreview(
        hostId,
        decodeURIComponent(previewImg.dataset.previewPath),
        decodeURIComponent(previewImg.dataset.previewName || 'image')
      );
      return;
    }

    const btn = e.target.closest('.copy-code-btn');
    if (!btn) return;
    const text = decodeURIComponent(btn.dataset.copy || '');
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制'; }, 1400);
    } catch {
      showToast('复制失败，请手动选中复制');
    }
  });

  // ---- Composer Send & Stop ----
  function updateSendButton() {
    const isRunning = state.activeConv && state.runningConvIds.has(state.activeConv.id);
    const btn = $('btn-send');
    btn.classList.toggle('running', Boolean(isRunning));
    $('icon-send').classList.toggle('hidden', Boolean(isRunning));
    $('icon-stop').classList.toggle('hidden', !isRunning);
  }

  function autoResizeInput() {
    const el = $('prompt-input');
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  $('prompt-input').addEventListener('input', autoResizeInput);
  $('prompt-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      if (window.innerWidth >= 768) {
        e.preventDefault();
        sendPrompt();
      }
    }
  });

  function sendPrompt() {
    if (!state.activeConv) return;
    const convId = state.activeConv.id;

    if (state.runningConvIds.has(convId)) {
      state.chatWs?.send(JSON.stringify({ type: 'abort', conversationId: convId }));
      showToast('正在停止执行...');
      return;
    }

    if (state.pendingAttachments.some((a) => a.uploading)) {
      showToast('附件还在上传中，请稍候...');
      return;
    }

    const input = $('prompt-input');
    const text = input.value.trim();
    const attachments = state.pendingAttachments.map(({ path, name, size, isImage }) => ({
      path,
      name,
      size,
      isImage
    }));

    if (!text && attachments.length === 0) return;

    if (!state.chatWs || state.chatWs.readyState !== 1) {
      connectChatWs();
      showToast('连接正在恢复，请稍后再试');
      return;
    }

    input.value = '';
    autoResizeInput();
    state.pendingAttachments = [];
    renderPendingAttachments();

    state.chatWs.send(JSON.stringify({
      type: 'send',
      conversationId: convId,
      prompt: text,
      attachments
    }));
  }

  $('btn-send').addEventListener('click', sendPrompt);

  // ---- Mode Switch (Chat <-> Files <-> Terminal) ----
  function switchTab(tab) {
    state.activeTab = tab;
    $('tab-chat').classList.toggle('active', tab === 'chat');
    $('tab-files').classList.toggle('active', tab === 'files');
    $('tab-terminal').classList.toggle('active', tab === 'terminal');

    $('chat-view').classList.toggle('active', tab === 'chat');
    $('files-view').classList.toggle('active', tab === 'files');
    $('terminal-view').classList.toggle('active', tab === 'terminal');

    if (tab === 'files') {
      const host = getSelectedHost();
      const target = state.filesDir || state.activeConv?.cwd || host?.defaultCwd || '~';
      loadFilesDir(target);
    } else if (tab === 'terminal') {
      if (!state.termWs || state.termWs.readyState !== 1) {
        reconnectTerminal();
      } else {
        setTimeout(() => fitTerminal(), 50);
      }
    }
  }

  $('tab-chat').addEventListener('click', () => switchTab('chat'));
  $('tab-files').addEventListener('click', () => switchTab('files'));
  $('tab-terminal').addEventListener('click', () => switchTab('terminal'));

  // ---- Remote File Manager ----
  async function loadFilesDir(dirPath) {
    const host = getSelectedHost();
    const listEl = $('files-list');
    if (!host) {
      listEl.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);">请先添加主机</div>`;
      return;
    }

    listEl.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);">正在读取远端目录...</div>`;
    try {
      const data = await api(`/api/hosts/${encodeURIComponent(host.id)}/files?path=${encodeURIComponent(dirPath || '~')}`);
      state.filesDir = data.dir;
      state.filesParent = data.parent;
      $('files-current-path').textContent = data.dir;
      $('btn-files-up').disabled = !data.parent;

      if (!data.entries || data.entries.length === 0) {
        listEl.innerHTML = `<div style="padding:28px;text-align:center;color:var(--text-muted);">空目录</div>`;
        return;
      }

      listEl.innerHTML = '';
      for (const item of data.entries) {
        const row = document.createElement('div');
        row.className = `file-row ${item.isDir ? 'dir' : ''}`;

        const timeStr = item.mtime ? new Date(item.mtime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

        if (item.isDir) {
          row.innerHTML = `
            <div class="file-card-icon">📁</div>
            <div class="file-card-info">
              <div class="file-card-name">${escapeHtml(item.name)}</div>
              <div class="file-card-meta">文件夹 · ${timeStr}</div>
            </div>
            <span style="color:var(--text-muted);font-size:18px;">›</span>
          `;
          row.addEventListener('click', () => loadFilesDir(item.path));
        } else {
          const dlUrl = buildFileDownloadUrl(host.id, item.path, false);
          const inlineUrl = buildFileDownloadUrl(host.id, item.path, true);
          const iconInner = item.isImage
            ? `<img src="${inlineUrl}" alt="" loading="lazy" />`
            : fileIconFor(item.name, false);

          row.innerHTML = `
            <div class="file-card-icon">${iconInner}</div>
            <div class="file-card-info">
              <div class="file-card-name">${escapeHtml(item.name)}</div>
              <div class="file-card-meta">${formatBytes(item.size)} · ${timeStr}</div>
            </div>
            <div class="file-row-btns">
              <button type="button" class="file-action-link secondary" data-send-ai="1">发给AI</button>
              <a class="file-action-link primary" href="${dlUrl}" download="${escapeHtml(item.name)}">下载</a>
              <button type="button" class="item-action-btn" data-del-file="1" title="删除">🗑</button>
            </div>
          `;

          if (item.isImage) {
            row.querySelector('.file-card-icon').addEventListener('click', () => {
              openImagePreview(host.id, item.path, item.name);
            });
          } else if (isPreviewableInBrowser(item.name)) {
            row.querySelector('.file-card-info').style.cursor = 'pointer';
            row.querySelector('.file-card-info').addEventListener('click', () => {
              window.open(inlineUrl, '_blank', 'noopener');
            });
          }

          row.querySelector('[data-send-ai]').addEventListener('click', () => {
            state.pendingAttachments.push({
              path: item.path,
              name: item.name,
              size: item.size,
              isImage: item.isImage,
              uploading: false
            });
            renderPendingAttachments();
            switchTab('chat');
            showToast(`已附加 ${item.name} 到输入框`);
          });

          row.querySelector('[data-del-file]').addEventListener('click', async () => {
            if (!confirm(`确定删除远端文件 "${item.name}"？`)) return;
            try {
              await api(`/api/hosts/${encodeURIComponent(host.id)}/files?path=${encodeURIComponent(item.path)}`, {
                method: 'DELETE'
              });
              showToast('已删除');
              loadFilesDir(state.filesDir);
            } catch (err) {
              showToast(err.message);
            }
          });
        }

        listEl.appendChild(row);
      }
    } catch (err) {
      listEl.innerHTML = `<div style="padding:20px;color:var(--danger);">读取失败：${escapeHtml(err.message)}</div>`;
    }
  }

  $('btn-files-up').addEventListener('click', () => {
    if (state.filesParent) loadFilesDir(state.filesParent);
  });

  $('btn-files-refresh').addEventListener('click', () => {
    loadFilesDir(state.filesDir);
  });

  $('btn-files-set-cwd').addEventListener('click', async () => {
    if (!state.activeConv || !state.filesDir) return;
    const { conversation } = await api(`/api/conversations/${state.activeConv.id}`, {
      method: 'PATCH',
      body: { cwd: state.filesDir }
    });
    state.activeConv = conversation;
    renderTopbar();
    renderComposerMeta();
    showToast(`已将对话目录设为 ${state.filesDir}`);
  });

  $('btn-files-upload').addEventListener('click', () => {
    $('input-dir-upload').value = '';
    $('input-dir-upload').click();
  });

  $('input-dir-upload').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const host = getSelectedHost();
    if (!host) return;

    showToast(`正在上传 ${files.length} 个文件...`);
    let okCount = 0;
    for (const f of files) {
      try {
        await uploadRawFile(host.id, state.filesDir || '~', f, 'dir');
        okCount++;
      } catch (err) {
        showToast(`${f.name} 上传失败: ${err.message}`);
      }
    }
    if (okCount > 0) {
      showToast(`成功上传 ${okCount} 个文件`);
      loadFilesDir(state.filesDir);
    }
  });

  // ---- Interactive Xterm.js Terminal (Lazy-Loaded for Fast Initial Page Load) ----
  let xtermLoadPromise = null;

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`加载 ${src} 失败`));
      document.body.appendChild(s);
    });
  }

  function ensureXtermLoaded() {
    if (window.Terminal && window.FitAddon) return Promise.resolve();
    if (xtermLoadPromise) return xtermLoadPromise;

    xtermLoadPromise = (async () => {
      if (!document.querySelector('link[href="/vendor/xterm.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/vendor/xterm.css';
        document.head.appendChild(link);
      }
      await loadScriptOnce('/vendor/xterm.js');
      await loadScriptOnce('/vendor/addon-fit.js');
    })().catch((err) => {
      xtermLoadPromise = null;
      throw err;
    });

    return xtermLoadPromise;
  }

  async function initTerminalIfNeeded() {
    if (state.term) return;
    $('term-status-text').textContent = '正在加载终端组件...';
    await ensureXtermLoaded();
    const term = new window.Terminal({
      cursorBlink: true,
      fontSize: state.termFontSize,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#38bdf8'
      },
      scrollback: 3000
    });
    const fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open($('xterm-container'));
    fitAddon.fit();

    term.onData((data) => {
      if (state.termWs && state.termWs.readyState === 1) {
        state.termWs.send(JSON.stringify({ type: 'input', data }));
      }
    });

    window.addEventListener('resize', () => {
      if (state.activeTab === 'terminal') fitTerminal();
    });

    state.term = term;
    state.fitAddon = fitAddon;
  }

  function fitTerminal() {
    if (!state.fitAddon || !state.term) return;
    try {
      state.fitAddon.fit();
      if (state.termWs && state.termWs.readyState === 1) {
        state.termWs.send(JSON.stringify({
          type: 'resize',
          cols: state.term.cols,
          rows: state.term.rows
        }));
      }
    } catch {}
  }

  async function reconnectTerminal() {
    try {
      await initTerminalIfNeeded();
    } catch (err) {
      $('term-status-text').textContent = err.message || '加载终端组件失败';
      return;
    }
    if (state.termWs) {
      try { state.termWs.close(); } catch {}
      state.termWs = null;
    }

    const host = getSelectedHost();
    if (!host) {
      $('term-status-text').textContent = '请先添加主机';
      return;
    }

    state.term.clear();
    fitTerminal();
    $('term-status-text').textContent = `正在连接 ${host.name}...`;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const cwd = state.activeConv?.cwd || host.defaultCwd || '';
    const url = `${proto}//${location.host}/ws/terminal?hostId=${encodeURIComponent(host.id)}&cwd=${encodeURIComponent(cwd)}&cols=${state.term.cols}&rows=${state.term.rows}`;

    const ws = new WebSocket(url);
    state.termWs = ws;

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'output') {
        state.term.write(msg.data);
      } else if (msg.type === 'ready') {
        $('term-status-text').textContent = `已连接 · ${host.name}`;
        fitTerminal();
        state.term.focus();
      } else if (msg.type === 'status') {
        $('term-status-text').textContent = msg.message;
      } else if (msg.type === 'error') {
        $('term-status-text').textContent = `连接失败: ${msg.error}`;
        state.term.writeln(`\r\n\x1b[31m[错误] ${msg.error}\x1b[0m`);
      } else if (msg.type === 'exit') {
        $('term-status-text').textContent = '连接已断开';
      }
    };

    ws.onclose = () => {
      if ($('term-status-text').textContent.startsWith('已连接')) {
        $('term-status-text').textContent = '连接已断开（点右上角重连）';
      }
    };
  }

  $('btn-term-reconnect').addEventListener('click', reconnectTerminal);
  $('btn-term-font-inc').addEventListener('click', () => {
    state.termFontSize = Math.min(24, state.termFontSize + 2);
    localStorage.setItem('ssh_ai_term_font', String(state.termFontSize));
    if (state.term) { state.term.options.fontSize = state.termFontSize; fitTerminal(); }
  });
  $('btn-term-font-dec').addEventListener('click', () => {
    state.termFontSize = Math.max(10, state.termFontSize - 2);
    localStorage.setItem('ssh_ai_term_font', String(state.termFontSize));
    if (state.term) { state.term.options.fontSize = state.termFontSize; fitTerminal(); }
  });

  const KEY_MAP = {
    esc: '\x1b',
    tab: '\t',
    'ctrl-c': '\x03',
    'ctrl-d': '\x04',
    up: '\x1b[A',
    down: '\x1b[B',
    right: '\x1b[C',
    left: '\x1b[D',
    enter: '\r'
  };

  document.querySelectorAll('.key-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const seq = KEY_MAP[btn.dataset.key];
      if (seq && state.termWs && state.termWs.readyState === 1) {
        state.termWs.send(JSON.stringify({ type: 'input', data: seq }));
        state.term?.focus();
      }
    });
  });

  // ---- Modals Helper ----
  document.querySelectorAll('.modal-close').forEach((btn) => {
    btn.addEventListener('click', () => $(btn.dataset.close).classList.add('hidden'));
  });
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });

  // ---- Host Modal ----
  function syncHostFormVisibility() {
    const isLocal = $('host-type').value === 'local';
    $('ssh-fields').classList.toggle('hidden', isLocal);
    const auth = $('host-auth-type').value;
    $('auth-password-row').classList.toggle('hidden', auth !== 'password');
    $('auth-key-rows').classList.toggle('hidden', auth !== 'key');
  }

  $('host-type').addEventListener('change', syncHostFormVisibility);
  $('host-auth-type').addEventListener('change', syncHostFormVisibility);

  function openHostModal(host = null) {
    $('host-modal-title').textContent = host ? '编辑主机' : '添加 SSH 主机';
    $('host-id').value = host?.id || '';
    $('host-type').value = host?.type || 'ssh';
    $('host-name').value = host?.name || '';
    $('host-addr').value = host?.host || '';
    $('host-port').value = host?.port || 2222;
    $('host-user').value = host?.username || '';
    $('host-auth-type').value = host?.authType || 'token';
    $('host-password').value = '';
    $('host-key-path').value = host?.privateKeyPath || '';
    $('host-key-text').value = '';
    $('host-passphrase').value = '';
    $('host-cwd').value = host?.defaultCwd || '~';
    $('ssh-paste-input').value = '';
    $('host-test-result').classList.add('hidden');
    $('btn-delete-host').classList.toggle('hidden', !host || state.hosts.length <= 1);
    syncHostFormVisibility();
    $('host-modal').classList.remove('hidden');
  }

  $('btn-add-host').addEventListener('click', () => {
    closeDrawer();
    openHostModal(null);
  });

  async function doParseSshPaste() {
    const raw = $('ssh-paste-input').value.trim();
    if (!raw) return;
    try {
      const { parsed } = await api('/api/hosts/parse-ssh', {
        method: 'POST',
        body: { command: raw }
      });
      $('host-type').value = 'ssh';
      if (!$('host-name').value) $('host-name').value = parsed.name;
      $('host-addr').value = parsed.host;
      $('host-port').value = parsed.port;
      $('host-user').value = parsed.username;
      $('host-auth-type').value = parsed.authType;
      syncHostFormVisibility();
      showToast('已自动识别主机、端口与 Token！');
    } catch (err) {
      showToast(err.message);
    }
  }

  $('btn-parse-ssh').addEventListener('click', doParseSshPaste);
  $('ssh-paste-input').addEventListener('paste', () => {
    setTimeout(doParseSshPaste, 50);
  });

  function collectHostFormData() {
    return {
      id: $('host-id').value || undefined,
      type: $('host-type').value,
      name: $('host-name').value.trim(),
      host: $('host-addr').value.trim(),
      port: Number($('host-port').value) || 22,
      username: $('host-user').value.trim(),
      authType: $('host-auth-type').value,
      password: $('host-password').value,
      privateKeyPath: $('host-key-path').value.trim(),
      privateKey: $('host-key-text').value,
      passphrase: $('host-passphrase').value,
      defaultCwd: $('host-cwd').value.trim() || '~'
    };
  }

  $('btn-test-host').addEventListener('click', async () => {
    const box = $('host-test-result');
    box.className = 'test-result';
    box.textContent = '正在测试连接并检测 Codex / Antigravity CLI...';
    box.classList.remove('hidden');

    try {
      const { result } = await api('/api/hosts/test-raw', {
        method: 'POST',
        body: collectHostFormData()
      });
      box.className = 'test-result ok';
      box.textContent =
        `✅ 连接成功 (${result.latencyMs}ms)\n` +
        `系统：${result.uname || 'Linux'}\n` +
        `Codex CLI：${result.hasCodex ? '已安装 (' + result.codexPath + ')' : '未检测到'}\n` +
        `Antigravity CLI：${result.hasAgy ? '已安装 (' + result.agyPath + ')' : '未检测到'}`;
    } catch (err) {
      box.className = 'test-result err';
      box.textContent = `❌ 连接失败：${err.message}`;
    }
  });

  $('host-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = collectHostFormData();
    try {
      let saved;
      if (payload.id) {
        const res = await api(`/api/hosts/${payload.id}`, { method: 'PUT', body: payload });
        saved = res.host;
      } else {
        const res = await api('/api/hosts', { method: 'POST', body: payload });
        saved = res.host;
      }
      const listRes = await api('/api/hosts');
      state.hosts = listRes.hosts;
      $('host-modal').classList.add('hidden');
      await selectHost(saved.id);
      showToast('主机已保存');
    } catch (err) {
      showToast(err.message);
    }
  });

  $('btn-delete-host').addEventListener('click', async () => {
    const id = $('host-id').value;
    if (!id || !confirm('确定删除这台主机及其下所有对话？')) return;
    await api(`/api/hosts/${id}`, { method: 'DELETE' });
    const listRes = await api('/api/hosts');
    state.hosts = listRes.hosts;
    $('host-modal').classList.add('hidden');
    if (state.hosts.length > 0) {
      await selectHost(state.hosts[0].id);
    }
    showToast('已删除主机');
  });

  // ---- Model & Effort Picker Modal ----
  async function ensureHostModels(hostId, forceRefresh = false) {
    if (!forceRefresh && state.hostModels[hostId]) {
      return state.hostModels[hostId];
    }
    const { models } = await api(
      `/api/hosts/${encodeURIComponent(hostId)}/models${forceRefresh ? '?refresh=1' : ''}`
    );
    state.hostModels[hostId] = models;
    return models;
  }

  function renderModelPickerBody(catalog) {
    const conv = state.activeConv;
    if (!conv) return;
    const agent = conv.agent || 'codex';
    const currentModel = conv.options?.model || '';
    const currentEffort = conv.options?.effort || '';

    $('model-modal-title').textContent =
      agent === 'agy' ? 'Antigravity 模型选择' : 'Codex 模型与推理强度';
    $('custom-model-input').value = currentModel;

    const list = agent === 'agy'
      ? (catalog?.agy?.models || [])
      : (catalog?.codex?.models || []);
    const defaultModelHint = agent === 'codex'
      ? (catalog?.codex?.defaultModel || '主机 config.toml 默认')
      : 'Antigravity CLI 默认';

    // Determine supported reasoning efforts
    let effortChoices = agent === 'agy'
      ? ['low', 'medium', 'high', 'xhigh', 'max']
      : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

    if (agent === 'codex') {
      const targetId = currentModel || catalog?.codex?.defaultModel;
      const found = list.find((m) => m.id === targetId);
      if (found && Array.isArray(found.efforts) && found.efforts.length > 0) {
        effortChoices = found.efforts;
      }
    }

    const effortWrap = $('effort-pills');
    const defaultEffortLabel = agent === 'codex' && catalog?.codex?.defaultEffort
      ? `默认 (${catalog.codex.defaultEffort})`
      : '默认';

    effortWrap.innerHTML = [
      `<button type="button" class="effort-pill ${!currentEffort ? 'active' : ''}" data-effort="">${escapeHtml(defaultEffortLabel)}</button>`,
      ...effortChoices.map(
        (ef) => `<button type="button" class="effort-pill ${currentEffort === ef ? 'active' : ''}" data-effort="${escapeHtml(ef)}">${escapeHtml(ef)}</button>`
      )
    ].join('');

    effortWrap.querySelectorAll('.effort-pill').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const nextEffort = btn.dataset.effort;
        const { conversation } = await api(`/api/conversations/${conv.id}`, {
          method: 'PATCH',
          body: { options: { effort: nextEffort } }
        });
        state.activeConv = conversation;
        renderComposerMeta();
        renderModelPickerBody(catalog);
        showToast(nextEffort ? `推理强度已设为 ${nextEffort}` : '已恢复默认推理强度');
      });
    });

    // Render model cards
    const listEl = $('model-list');
    const items = [
      { id: '', name: `默认模型 (${defaultModelHint})`, subtitle: '跟随远端 CLI 默认配置' },
      ...list.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        subtitle: m.id
      }))
    ];

    listEl.innerHTML = items.map((m) => {
      const active = m.id === currentModel;
      return `
        <button type="button" class="model-option ${active ? 'active' : ''}" data-model-id="${escapeHtml(m.id)}">
          <div class="model-option-main">
            <div class="model-option-name">${escapeHtml(m.name)}</div>
            <div class="model-option-id">${escapeHtml(m.subtitle)}</div>
          </div>
          ${active ? '<span class="model-check">✓</span>' : ''}
        </button>
      `;
    }).join('');

    listEl.querySelectorAll('.model-option').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const nextModel = btn.dataset.modelId;
        const { conversation } = await api(`/api/conversations/${conv.id}`, {
          method: 'PATCH',
          body: { options: { model: nextModel } }
        });
        state.activeConv = conversation;
        renderComposerMeta();
        renderModelPickerBody(catalog);
        $('model-modal').classList.add('hidden');
        showToast(nextModel ? `已切换模型：${nextModel}` : '已恢复默认模型');
      });
    });
  }

  async function openModelPicker(forceRefresh = false) {
    if (!state.activeConv) return;
    const hostId = state.activeConv.hostId || state.selectedHostId;
    if (!hostId) return;

    $('model-modal').classList.remove('hidden');
    if (forceRefresh || !state.hostModels[hostId]) {
      $('model-list').innerHTML = `<div style="padding:18px;text-align:center;color:var(--text-muted);">正在从远端主机拉取模型列表...</div>`;
    } else {
      renderModelPickerBody(state.hostModels[hostId]);
    }

    try {
      const catalog = await ensureHostModels(hostId, forceRefresh);
      renderModelPickerBody(catalog);
    } catch (err) {
      $('model-list').innerHTML = `<div style="padding:14px;color:var(--danger);">拉取失败：${escapeHtml(err.message)}</div>`;
    }
  }

  $('btn-model-pill').addEventListener('click', () => openModelPicker(false));
  $('btn-refresh-models').addEventListener('click', () => openModelPicker(true));
  $('btn-apply-custom-model').addEventListener('click', async () => {
    if (!state.activeConv) return;
    const nextModel = $('custom-model-input').value.trim();
    const { conversation } = await api(`/api/conversations/${state.activeConv.id}`, {
      method: 'PATCH',
      body: { options: { model: nextModel } }
    });
    state.activeConv = conversation;
    renderComposerMeta();
    $('model-modal').classList.add('hidden');
    showToast(nextModel ? `已应用模型：${nextModel}` : '已恢复默认模型');
  });

  // ---- Usage & Quota Dashboard Modal ----
  function formatTokens(n) {
    const num = Number(n) || 0;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
    return String(num);
  }

  function formatResetEta(epochSec) {
    if (!epochSec) return '';
    const diffMs = epochSec * 1000 - Date.now();
    if (diffMs <= 0) return '即将重置';
    const totalMin = Math.floor(diffMs / 60000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    if (days > 0) return `${days}天${hours}小时后重置`;
    if (hours > 0) return `${hours}小时${mins}分后重置`;
    return `${mins}分钟后重置`;
  }

  function barClass(pct) {
    if (pct >= 85) return 'danger';
    if (pct >= 60) return 'warn';
    return '';
  }

  function renderQuotaRow(title, usedPct, subtitle) {
    const pct = Math.max(0, Math.min(100, Number(usedPct) || 0));
    const remain = Math.max(0, 100 - pct);
    return `
      <div class="quota-row">
        <div class="quota-label-row">
          <span><strong>${escapeHtml(title)}</strong> · 已用 ${pct.toFixed(1)}%（剩 ${remain.toFixed(1)}%）</span>
          <span class="quota-sub">${escapeHtml(subtitle)}</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill ${barClass(pct)}" style="width:${pct}%"></div>
        </div>
      </div>
    `;
  }

  function renderUsageBody(data) {
    const body = $('usage-body');
    const codex = data.remote?.codex;
    const agy = data.remote?.agy;
    const convUsage = data.app?.conversation;
    const hostTotal = data.app?.hostTotal;
    const sections = [];

    // 1. Antigravity CLI Usage Card
    if (agy) {
      const sess = agy.currentSession || agy.latestSession;
      const d24 = agy.last24h || {};
      const all = agy.allTime || {};
      const sessTotalIn = (sess?.inputTokens || 0) + (sess?.cacheReadTokens || 0);
      const sessCacheRate = sessTotalIn > 0
        ? `${(((sess?.cacheReadTokens || 0) / sessTotalIn) * 100).toFixed(0)}%`
        : '0%';

      const modelRows = (agy.byModel || []).map((m) => {
        const tot = (m.inputTokens || 0) + (m.cacheReadTokens || 0) + (m.outputTokens || 0);
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:4px 0;border-top:1px solid var(--border);">
            <span style="font-family:ui-monospace,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%;">${escapeHtml(m.model)}</span>
            <span class="quota-sub">${m.steps} 步 · ${formatTokens(tot)}</span>
          </div>
        `;
      }).join('');

      sections.push(`
        <div class="usage-card">
          <div class="usage-card-header">
            <span class="usage-card-title">Antigravity CLI 用量</span>
            <span class="plan-badge" style="background:rgba(168,85,247,0.18);color:#c084fc;">${agy.totalSessions} 个会话</span>
          </div>
          ${sess ? `
            <div class="quota-sub" style="margin-bottom:8px;">
              ${agy.currentSession ? '当前会话' : '最近会话'}：<strong>${escapeHtml(sess.model || '默认模型')}</strong> · 缓存命中 ${sessCacheRate}
            </div>
            <div class="usage-stats-grid" style="margin-bottom:10px;">
              <div class="stat-tile">
                <div class="stat-tile-label">最近上下文窗口</div>
                <div class="stat-tile-val">${formatTokens(sess.lastContextTokens)}</div>
              </div>
              <div class="stat-tile">
                <div class="stat-tile-label">会话输出 (Output)</div>
                <div class="stat-tile-val">${formatTokens(sess.outputTokens)}</div>
              </div>
              <div class="stat-tile">
                <div class="stat-tile-label">近 24h 消耗</div>
                <div class="stat-tile-val">${formatTokens((d24.inputTokens || 0) + (d24.cacheReadTokens || 0) + (d24.outputTokens || 0))}</div>
              </div>
              <div class="stat-tile">
                <div class="stat-tile-label">历史总计 (${all.steps || 0} 步)</div>
                <div class="stat-tile-val">${formatTokens((all.inputTokens || 0) + (all.cacheReadTokens || 0) + (all.outputTokens || 0))}</div>
              </div>
            </div>
          ` : ''}
          ${modelRows ? `<div style="margin-top:6px;"><div class="quota-sub" style="margin-bottom:4px;">按模型分布</div>${modelRows}</div>` : ''}
          <div style="margin-top:10px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:8px;border-top:1px solid var(--border);">
            <span class="quota-sub">实时剩余额度百分比需在交互式 TUI 查看（<code>/usage</code>）</span>
            <button type="button" id="btn-open-agy-quota-term" class="btn-secondary sm" style="flex-shrink:0;">切终端看 /usage</button>
          </div>
        </div>
      `);
    }

    // 2. Codex Account Rate Limits & Context Window
    if (codex) {
      const rl = codex.rateLimits || {};
      const plan = rl.plan_type ? String(rl.plan_type) : 'Codex';
      const updatedStr = codex.updatedAt
        ? new Date(codex.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '';

      const rows = [];
      if (rl.primary) {
        const hrs = Math.round((rl.primary.window_minutes || 300) / 60);
        rows.push(renderQuotaRow(`${hrs}小时窗口额度`, rl.primary.used_percent, formatResetEta(rl.primary.resets_at)));
      }
      if (rl.secondary) {
        const days = Math.round((rl.secondary.window_minutes || 10080) / 1440);
        rows.push(renderQuotaRow(`${days}天周期额度`, rl.secondary.used_percent, formatResetEta(rl.secondary.resets_at)));
      }

      const sessInfo = (codex.currentSession || codex.latestSession)?.info;
      if (sessInfo && sessInfo.model_context_window && sessInfo.last_token_usage) {
        const usedCtx = sessInfo.last_token_usage.total_tokens || sessInfo.last_token_usage.input_tokens || 0;
        const maxCtx = sessInfo.model_context_window;
        const ctxPct = (usedCtx / maxCtx) * 100;
        const ctxLabel = codex.currentSession ? '当前会话上下文' : '最近 Codex 会话上下文';
        rows.push(
          renderQuotaRow(
            ctxLabel,
            ctxPct,
            `${formatTokens(usedCtx)} / ${formatTokens(maxCtx)}`
          )
        );
      }

      sections.push(`
        <div class="usage-card">
          <div class="usage-card-header">
            <span class="usage-card-title">Codex 账号额度</span>
            <span class="plan-badge">${escapeHtml(plan)}</span>
          </div>
          ${rows.join('') || '<div class="quota-sub">暂无配额明细</div>'}
          ${updatedStr ? `<div class="quota-sub" style="margin-top:8px;">最近同步时间：${escapeHtml(updatedStr)}</div>` : ''}
        </div>
      `);

      // Latest Codex session detailed token breakdown
      if (sessInfo?.total_token_usage) {
        const t = sessInfo.total_token_usage;
        const cacheRate = t.input_tokens > 0
          ? `${((t.cached_input_tokens / t.input_tokens) * 100).toFixed(0)}%`
          : '0%';
        sections.push(`
          <div class="usage-card">
            <div class="usage-card-header">
              <span class="usage-card-title">${codex.currentSession ? '当前 Codex 会话 Token' : '最近 Codex 会话 Token'}</span>
              <span class="quota-sub">缓存命中 ${cacheRate}</span>
            </div>
            <div class="usage-stats-grid">
              <div class="stat-tile">
                <div class="stat-tile-label">总输入 (Input)</div>
                <div class="stat-tile-val">${formatTokens(t.input_tokens)}</div>
              </div>
              <div class="stat-tile">
                <div class="stat-tile-label">缓存命中 (Cached)</div>
                <div class="stat-tile-val">${formatTokens(t.cached_input_tokens)}</div>
              </div>
              <div class="stat-tile">
                <div class="stat-tile-label">总输出 (Output)</div>
                <div class="stat-tile-val">${formatTokens(t.output_tokens)}</div>
              </div>
              <div class="stat-tile">
                <div class="stat-tile-label">推理思考 (Reasoning)</div>
                <div class="stat-tile-val">${formatTokens(t.reasoning_output_tokens)}</div>
              </div>
            </div>
          </div>
        `);
      }
    }

    // 2. Active conversation usage in SSH AI Chat
    if (convUsage) {
      sections.push(`
        <div class="usage-card">
          <div class="usage-card-header">
            <span class="usage-card-title">当前对话统计</span>
            <span class="quota-sub">${escapeHtml(convUsage.agent.toUpperCase())}${convUsage.model ? ` · ${escapeHtml(convUsage.model)}` : ''}</span>
          </div>
          <div class="usage-stats-grid">
            <div class="stat-tile">
              <div class="stat-tile-label">对话轮数</div>
              <div class="stat-tile-val">${convUsage.turns}</div>
            </div>
            <div class="stat-tile">
              <div class="stat-tile-label">累计 Tokens</div>
              <div class="stat-tile-val">${formatTokens(convUsage.totalTokens)}</div>
            </div>
            <div class="stat-tile">
              <div class="stat-tile-label">Input / Cached</div>
              <div class="stat-tile-val">${formatTokens(convUsage.inputTokens)} / ${formatTokens(convUsage.cachedTokens)}</div>
            </div>
            <div class="stat-tile">
              <div class="stat-tile-label">Output</div>
              <div class="stat-tile-val">${formatTokens(convUsage.outputTokens)}</div>
            </div>
          </div>
        </div>
      `);
    }

    // 3. Host total inside this app
    if (hostTotal) {
      sections.push(`
        <div class="usage-card">
          <div class="usage-card-header">
            <span class="usage-card-title">本主机对话累计</span>
            <span class="quota-sub">${hostTotal.conversations} 个对话</span>
          </div>
          <div class="usage-stats-grid">
            <div class="stat-tile">
              <div class="stat-tile-label">总回复次数</div>
              <div class="stat-tile-val">${hostTotal.turns}</div>
            </div>
            <div class="stat-tile">
              <div class="stat-tile-label">累计 Tokens</div>
              <div class="stat-tile-val">${formatTokens(hostTotal.totalTokens)}</div>
            </div>
          </div>
        </div>
      `);
    }

    body.innerHTML = sections.join('') || '<div style="padding:20px;text-align:center;color:var(--text-muted);">暂无用量数据，发送一条消息后再查看</div>';

    const agyTermBtn = $('btn-open-agy-quota-term');
    if (agyTermBtn) {
      agyTermBtn.addEventListener('click', () => {
        $('usage-modal').classList.add('hidden');
        switchTab('terminal');
        showToast('在终端运行 agy 后输入 /usage 即可查看实时配额');
      });
    }
  }

  async function openUsageModal() {
    const host = getSelectedHost();
    if (!host) return;
    $('usage-modal').classList.remove('hidden');
    $('usage-body').innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);">正在拉取远端配额与 Token 用量...</div>`;
    try {
      const convId = state.activeConv?.id || '';
      const data = await api(
        `/api/hosts/${encodeURIComponent(host.id)}/usage${convId ? `?conversationId=${encodeURIComponent(convId)}` : ''}`
      );
      renderUsageBody(data);
    } catch (err) {
      $('usage-body').innerHTML = `<div style="padding:16px;color:var(--danger);">拉取失败：${escapeHtml(err.message)}</div>`;
    }
  }

  $('btn-usage').addEventListener('click', openUsageModal);
  $('btn-refresh-usage').addEventListener('click', openUsageModal);

  // ---- Remote Computer CLI Session Sync ----
  let cachedRemoteSessions = [];
  let syncFilter = 'all';

  function renderRemoteSessionList() {
    const listEl = $('sync-session-list');
    const filtered = cachedRemoteSessions.filter(
      (s) => syncFilter === 'all' || s.agent === syncFilter
    );

    if (filtered.length === 0) {
      listEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);">未检测到可同步的电脑端会话</div>`;
      return;
    }

    listEl.innerHTML = '';
    for (const s of filtered) {
      const card = document.createElement('div');
      card.className = 'sync-card';
      const timeStr = s.updatedAt
        ? new Date(s.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '';
      const badgeCls = s.agent === 'agy' ? 'agy' : 'codex';
      const badgeLabel = s.agent === 'agy' ? 'AGY' : 'Codex';
      const actionText = s.importedConvId ? '更新同步' : '同步继续';

      card.innerHTML = `
        <div class="sync-card-main">
          <div class="sync-card-title">${escapeHtml(s.title)}</div>
          <div class="sync-card-meta">
            <span class="agent-badge ${badgeCls}">${badgeLabel}</span>
            <span>${timeStr}</span>
            <span>${s.messageCount} 条消息</span>
            ${s.model ? `<span>${escapeHtml(s.model)}</span>` : ''}
          </div>
        </div>
        <button type="button" class="btn-primary sm" style="flex-shrink:0;">${actionText}</button>
      `;

      card.addEventListener('click', async () => {
        const host = getSelectedHost();
        if (!host) return;
        const btn = card.querySelector('button');
        btn.disabled = true;
        btn.textContent = '同步中...';
        try {
          const { conversation } = await api(
            `/api/hosts/${encodeURIComponent(host.id)}/remote-sessions/import`,
            {
              method: 'POST',
              body: { agent: s.agent, sessionId: s.sessionId }
            }
          );
          $('sync-modal').classList.add('hidden');
          closeDrawer();
          await refreshConversations();
          await selectConversation(conversation.id);
          switchTab('chat');
          showToast(`已同步会话（共 ${conversation.messages.length} 条记录），可直接继续对话`);
        } catch (err) {
          btn.disabled = false;
          btn.textContent = actionText;
          showToast(`同步失败：${err.message}`);
        }
      });

      listEl.appendChild(card);
    }
  }

  async function openSyncModal() {
    const host = getSelectedHost();
    if (!host) {
      showToast('请先选择主机');
      return;
    }
    $('sync-modal').classList.remove('hidden');
    $('sync-session-list').innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);">正在扫描主机上的 Codex / Antigravity 会话...</div>`;
    try {
      const { sessions } = await api(`/api/hosts/${encodeURIComponent(host.id)}/remote-sessions`);
      cachedRemoteSessions = sessions || [];
      renderRemoteSessionList();
    } catch (err) {
      $('sync-session-list').innerHTML = `<div style="padding:16px;color:var(--danger);">扫描失败：${escapeHtml(err.message)}</div>`;
    }
  }

  $('btn-open-sync').addEventListener('click', () => {
    closeDrawer();
    openSyncModal();
  });
  $('btn-refresh-sync').addEventListener('click', openSyncModal);

  document.querySelectorAll('[data-sync-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      syncFilter = btn.dataset.syncFilter;
      document.querySelectorAll('[data-sync-filter]').forEach((b) => {
        b.classList.toggle('active', b.dataset.syncFilter === syncFilter);
      });
      renderRemoteSessionList();
    });
  });

  // One-tap sync active conversation to pull latest computer messages
  $('btn-sync-conv').addEventListener('click', async () => {
    if (!state.activeConv || !state.activeConv.remoteSessionId) return;
    showToast('正在同步该会话最新消息...');
    try {
      const { conversation } = await api(`/api/conversations/${encodeURIComponent(state.activeConv.id)}/sync`, {
        method: 'POST'
      });
      state.activeConv = conversation;
      renderTopbar();
      renderComposerMeta();
      renderMessages(true);
      refreshConversations();
      showToast(`同步完成（共 ${conversation.messages.length} 条消息）`);
    } catch (err) {
      showToast(`同步失败：${err.message}`);
    }
  });

  // ---- Chat Settings Modal ----
  function openChatSettings() {
    if (!state.activeConv) return;
    const c = state.activeConv;
    $('cs-title').value = c.title || '';
    $('cs-agent').value = c.agent || 'codex';
    $('cs-cwd').value = c.cwd || '~';
    $('cs-model').value = c.options?.model || '';
    $('cs-auto-approve').checked = c.options?.autoApprove !== false;
    $('cs-session-id').textContent = c.remoteSessionId || '尚未建立';
    $('chat-settings-modal').classList.remove('hidden');
  }

  $('btn-chat-opts').addEventListener('click', openChatSettings);
  $('btn-open-chat-settings').addEventListener('click', openChatSettings);

  $('btn-reset-session').addEventListener('click', async () => {
    if (!state.activeConv) return;
    const { conversation } = await api(`/api/conversations/${state.activeConv.id}`, {
      method: 'PATCH',
      body: { remoteSessionId: null }
    });
    state.activeConv = conversation;
    $('cs-session-id').textContent = '已重置（下一条消息将开启新上下文）';
    showToast('已重置远端会话上下文');
  });

  $('chat-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.activeConv) return;
    const { conversation } = await api(`/api/conversations/${state.activeConv.id}`, {
      method: 'PATCH',
      body: {
        title: $('cs-title').value.trim() || '新对话',
        agent: $('cs-agent').value,
        cwd: $('cs-cwd').value.trim() || '~',
        options: {
          model: $('cs-model').value.trim(),
          autoApprove: $('cs-auto-approve').checked
        }
      }
    });
    state.activeConv = conversation;
    $('chat-settings-modal').classList.add('hidden');
    renderTopbar();
    renderComposerMeta();
    refreshConversations();
    showToast('对话设置已保存');
  });

  $('btn-delete-conv').addEventListener('click', async () => {
    if (!state.activeConv) return;
    if (!confirm('确定删除当前对话？')) return;
    const id = state.activeConv.id;
    $('chat-settings-modal').classList.add('hidden');
    await deleteConversation(id);
  });

  // ---- Bootstrap ----
  async function bootstrapApp() {
    connectChatWs();
    const { hosts } = await api('/api/hosts');
    state.hosts = hosts || [];
    if (!state.selectedHostId || !state.hosts.some((h) => h.id === state.selectedHostId)) {
      state.selectedHostId = state.hosts[0]?.id || null;
    }
    renderHostList();
    if (state.selectedHostId) {
      await selectHost(state.selectedHostId);
    } else {
      renderTopbar();
      renderMessages();
    }
  }

  async function init() {
    try {
      const auth = await api('/api/auth/status');
      if (auth.required && !auth.authenticated) {
        showAuthScreen();
        return;
      }
      if (auth.required) {
        $('btn-logout').classList.remove('hidden');
      }
      await bootstrapApp();
    } catch (err) {
      showToast(err.message);
    }
  }

  init();
})();
