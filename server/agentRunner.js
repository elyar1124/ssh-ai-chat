import { execStream } from './sshManager.js';
import { detectOutputFiles } from './fileManager.js';

function shellSingleQuote(str) {
  return `'${String(str).replace(/'/g, "'\\''")}'`;
}

function envPrelude(cwd) {
  const parts = [
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/usr/local/bin:$PATH"',
    '[ -f "$HOME/.profile" ] && . "$HOME/.profile" 2>/dev/null || true'
  ];
  if (cwd && cwd !== '~') {
    parts.push(`cd ${shellSingleQuote(cwd)} 2>/dev/null || true`);
  } else {
    parts.push('cd "$HOME" 2>/dev/null || true');
  }
  return parts.join('; ');
}

function enrichPromptWithAttachments(prompt, attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) return prompt;
  const lines = attachments.map(
    (a) => `- ${a.name} (${a.isImage ? '图片' : '文件'}): ${a.path}`
  );
  const header = `[用户已上传以下文件到远端主机，请直接读取或处理]\n${lines.join('\n')}`;
  return prompt ? `${header}\n\n${prompt}` : header;
}

function buildAgyCommand(prompt, conv) {
  const opts = conv.options || {};
  const b64 = Buffer.from(prompt, 'utf8').toString('base64');
  const flags = ['-p "$PROMPT"', '--output-format', 'stream-json'];

  if (conv.remoteSessionId) {
    flags.push('--conversation', shellSingleQuote(conv.remoteSessionId));
  }
  if (opts.autoApprove !== false) {
    flags.push('--dangerously-skip-permissions');
  } else if (opts.agyMode && ['auto', 'accept-edits', 'plan'].includes(opts.agyMode)) {
    flags.push('--mode', opts.agyMode);
  }
  if (opts.model) {
    flags.push('--model', shellSingleQuote(opts.model));
  }
  if (opts.effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(opts.effort)) {
    flags.push('--effort', opts.effort);
  }

  return `${envPrelude(conv.cwd)}; PROMPT=$(printf '%s' '${b64}' | base64 -d); agy ${flags.join(' ')}`;
}

function buildCodexCommand(conv, attachments = []) {
  const opts = conv.options || {};
  const commonFlags = ['--json', '--skip-git-repo-check'];

  if (opts.autoApprove !== false) {
    commonFlags.push('--dangerously-bypass-approvals-and-sandbox');
  }
  if (opts.model) {
    commonFlags.push('-m', shellSingleQuote(opts.model));
  }
  if (opts.effort && ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(opts.effort)) {
    commonFlags.push('-c', shellSingleQuote(`model_reasoning_effort="${opts.effort}"`));
  }

  // Pass uploaded images natively via codex -i <FILE>
  for (const att of attachments) {
    if (att && att.isImage && att.path) {
      commonFlags.push('-i', shellSingleQuote(att.path));
    }
  }

  if (conv.remoteSessionId) {
    return `${envPrelude(conv.cwd)}; codex exec resume ${commonFlags.join(' ')} ${shellSingleQuote(conv.remoteSessionId)} -`;
  }
  return `${envPrelude(conv.cwd)}; codex exec ${commonFlags.join(' ')} -`;
}

function buildShellCommand(prompt, conv) {
  return `${envPrelude(conv.cwd)}; ${prompt}`;
}

/**
 * Extract likely file paths from assistant Markdown text (supports Chinese filenames too).
 */
function extractMentionedPaths(text = '') {
  const found = new Set();
  const str = String(text || '');

  // 1) Backtick-wrapped paths like `report.docx` or `/root/申论范文.docx`
  for (const m of str.matchAll(/`([^`\n]{2,220}\.[a-zA-Z0-9]{1,8})`/g)) {
    const p = m[1].trim();
    if (!p.includes('://') && !p.startsWith('-')) found.add(p);
  }

  // 2) Markdown file links [label](file:///path) or [label](/path/to/file.ext)
  for (const m of str.matchAll(/\]\((?:file:\/\/)?([^)\s]{2,240}\.[a-zA-Z0-9]{1,8})\)/g)) {
    const p = decodeURIComponent(m[1]).trim();
    if (!p.includes('://')) found.add(p);
  }

  // 3) Bare absolute paths with extensions like /root/foo/bar.docx
  for (const m of str.matchAll(/(?:^|[\s"'：(（])(\/[^\s"'`<>()（）,，;；:：]{2,200}\.[a-zA-Z0-9]{1,8})/g)) {
    found.add(m[1].trim());
  }

  return Array.from(found);
}

/**
 * Helper to create a clean streaming state accumulator for a turn.
 */
function createTurnState(onEmit) {
  const state = {
    content: '',
    thinking: '',
    tools: [],
    files: [],
    error: '',
    usage: null,
    remoteSessionId: null
  };
  const candidateFiles = new Set();

  const emit = () => {
    onEmit({
      content: state.content,
      thinking: state.thinking,
      tools: state.tools,
      files: state.files,
      error: state.error,
      usage: state.usage,
      remoteSessionId: state.remoteSessionId
    });
  };

  const upsertTool = (tool) => {
    const idx = state.tools.findIndex((t) => t.id === tool.id);
    if (idx === -1) {
      state.tools.push(tool);
    } else {
      state.tools[idx] = { ...state.tools[idx], ...tool };
    }
  };

  return { state, candidateFiles, emit, upsertTool };
}

function handleCodexLine(line, turn) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let evt;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { state, candidateFiles, emit, upsertTool } = turn;

  if (evt.type === 'thread.started' && evt.thread_id) {
    state.remoteSessionId = evt.thread_id;
    emit();
    return;
  }

  if (evt.type === 'item.started' || evt.type === 'item.updated' || evt.type === 'item.completed') {
    const item = evt.item || {};
    const done = evt.type === 'item.completed';

    if (item.type === 'reasoning') {
      const text = item.text || (Array.isArray(item.summary) ? item.summary.join('\n') : '');
      if (text) {
        if (!turn._reasoningMap) turn._reasoningMap = new Map();
        turn._reasoningMap.set(item.id || 'r', text);
        state.thinking = Array.from(turn._reasoningMap.values()).join('\n\n');
        emit();
      }
      return;
    }

    if (item.type === 'agent_message') {
      const text = item.text || '';
      if (text) {
        if (!turn._msgMap) turn._msgMap = new Map();
        turn._msgMap.set(item.id || `m_${turn._msgMap.size}`, text);
        state.content = Array.from(turn._msgMap.values()).join('\n\n');
        emit();
      }
      return;
    }

    if (item.type === 'command_execution') {
      const status = done
        ? (item.exit_code && item.exit_code !== 0 ? 'error' : 'done')
        : 'running';
      upsertTool({
        id: item.id || `cmd_${state.tools.length}`,
        name: 'Shell',
        title: item.command || '执行命令',
        input: item.command || '',
        output: item.aggregated_output || '',
        exitCode: item.exit_code ?? null,
        status
      });
      emit();
      return;
    }

    if (item.type === 'file_change') {
      if (Array.isArray(item.changes)) {
        for (const c of item.changes) {
          if (c?.path) candidateFiles.add(c.path);
        }
      }
      const changes = Array.isArray(item.changes)
        ? item.changes.map((c) => `${c.kind || 'edit'}: ${c.path}`).join('\n')
        : JSON.stringify(item, null, 2);
      upsertTool({
        id: item.id || `file_${state.tools.length}`,
        name: 'File Change',
        title: Array.isArray(item.changes)
          ? `修改 ${item.changes.length} 个文件`
          : '文件变更',
        input: changes,
        output: item.status || '',
        status: done ? (item.status === 'failed' ? 'error' : 'done') : 'running'
      });
      emit();
      return;
    }

    if (item.type) {
      upsertTool({
        id: item.id || `tool_${state.tools.length}`,
        name: item.type,
        title: item.name || item.query || item.type,
        input: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || item.input || '', null, 2),
        output: typeof item.result === 'string' ? item.result : (item.output || ''),
        status: done ? 'done' : 'running'
      });
      emit();
    }
    return;
  }

  if (evt.type === 'turn.completed' && evt.usage) {
    state.usage = evt.usage;
    emit();
    return;
  }

  if (evt.type === 'error' || evt.type === 'turn.failed') {
    const errMsg = evt.message || evt.error?.message || JSON.stringify(evt);
    state.error = state.error ? `${state.error}\n${errMsg}` : errMsg;
    emit();
  }
}

function handleAgyLine(line, turn) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let evt;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    turn.state.content += (turn.state.content ? '\n' : '') + trimmed;
    turn.emit();
    return;
  }

  const { state, candidateFiles, emit, upsertTool } = turn;

  // Capture conversation/session id from top-level or nested envelopes
  const sid =
    evt.conversation_id ||
    evt.conversationId ||
    evt.session_id ||
    evt.sessionId ||
    evt.step_update?.conversation_id ||
    evt.result?.conversation_id;
  if (sid && !state.remoteSessionId) {
    state.remoteSessionId = sid;
  }

  // ---- Native Antigravity CLI stream-json format (uses `event`) ----
  if (evt.event === 'init') {
    emit();
    return;
  }

  if (evt.event === 'step_update' && evt.step_update) {
    const su = evt.step_update;

    if (su.step_type === 'agent_response') {
      if (typeof su.thinking_delta === 'string' && su.thinking_delta) {
        state.thinking += su.thinking_delta;
      }
      if (typeof su.thought_delta === 'string' && su.thought_delta) {
        state.thinking += su.thought_delta;
      }
      if (typeof su.text_delta === 'string' && su.text_delta) {
        state.content += su.text_delta;
      }
      if (su.usage) {
        state.usage = su.usage;
      }
      emit();
      return;
    }

    if (su.step_type === 'thinking' || su.step_type === 'thought') {
      const t = su.thinking_delta || su.text_delta || su.text || '';
      if (t) {
        state.thinking += t;
        emit();
      }
      return;
    }

    if (su.step_type === 'tool') {
      const info = su.tool_info || {};
      const params = info.parameters || {};
      const toolName = su.tool_name || info.name || 'Tool';
      const filePath = params.Path || params.TargetFile || params.path || params.file_path;
      if (filePath && /write|edit|replace|create|image/i.test(String(toolName))) {
        candidateFiles.add(filePath);
      }
      const title =
        params.CommandLine ||
        params.command ||
        filePath ||
        params.query ||
        params.Query ||
        toolName;
      const stUpper = String(su.state || '').toUpperCase();
      const status =
        stUpper === 'ACTIVE' || stUpper === 'RUNNING'
          ? 'running'
          : stUpper === 'ERROR' || stUpper === 'FAILED'
            ? 'error'
            : 'done';

      upsertTool({
        id: `agy_step_${su.step_index ?? state.tools.length}`,
        name: toolName,
        title: String(title).slice(0, 120),
        input: Object.keys(params).length ? JSON.stringify(params, null, 2) : '',
        output: typeof info.output === 'string' ? info.output.slice(0, 6000) : '',
        status
      });
      emit();
      return;
    }

    return;
  }

  if (evt.event === 'result' && evt.result) {
    const r = evt.result;
    if (r.status && String(r.status).toUpperCase() !== 'SUCCESS') {
      state.error = r.error || r.message || `执行状态: ${r.status}`;
    } else if (typeof r.response === 'string' && r.response && !state.content.trim()) {
      state.content = r.response;
    }
    if (r.usage) state.usage = r.usage;
    for (const t of state.tools) {
      if (t.status === 'running') t.status = 'done';
    }
    emit();
    return;
  }

  if (evt.event === 'error') {
    state.error = evt.error?.message || evt.message || JSON.stringify(evt);
    emit();
    return;
  }

  // ---- Fallback: Claude/OpenAI-style `type` envelopes ----
  if (evt.type === 'content_block_delta' || evt.type === 'delta') {
    const delta = evt.delta || evt;
    if (delta.type === 'text_delta' || typeof delta.text === 'string') {
      state.content += delta.text || '';
      emit();
      return;
    }
    if (delta.type === 'thinking_delta' || typeof delta.thinking === 'string') {
      state.thinking += delta.thinking || '';
      emit();
      return;
    }
  }

  if (evt.type === 'assistant' || evt.role === 'assistant') {
    const msg = evt.message || evt;
    const blocks = Array.isArray(msg.content) ? msg.content : null;

    if (blocks) {
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === 'text' && b.text) {
          if (!state.content.endsWith(b.text)) {
            state.content += (state.content ? '\n\n' : '') + b.text;
          }
        } else if ((b.type === 'thinking' || b.type === 'thought') && (b.thinking || b.text)) {
          const t = b.thinking || b.text;
          if (!state.thinking.endsWith(t)) {
            state.thinking += (state.thinking ? '\n\n' : '') + t;
          }
        } else if (b.type === 'tool_use' || b.type === 'function_call') {
          const inputObj = b.input ?? b.args ?? {};
          const filePath = inputObj.Path || inputObj.path || inputObj.file_path;
          if (filePath && /write|edit|create/i.test(String(b.name || ''))) {
            candidateFiles.add(filePath);
          }
          const title =
            inputObj.CommandLine ||
            inputObj.command ||
            filePath ||
            inputObj.query ||
            b.name ||
            'Tool';
          upsertTool({
            id: b.id || `tool_${state.tools.length}`,
            name: b.name || 'Tool',
            title: String(title).slice(0, 120),
            input: typeof inputObj === 'string' ? inputObj : JSON.stringify(inputObj, null, 2),
            output: '',
            status: 'running'
          });
        }
      }
      emit();
      return;
    }

    if (typeof msg.content === 'string' && msg.content) {
      if (!state.content.endsWith(msg.content)) {
        state.content += (state.content ? '\n\n' : '') + msg.content;
      }
      emit();
      return;
    }
  }

  if (evt.type === 'result') {
    if (evt.is_error) {
      state.error = evt.result || evt.error || '执行出错';
    } else if (typeof evt.result === 'string' && evt.result && !state.content) {
      state.content = evt.result;
    }
    if (evt.usage) state.usage = evt.usage;
    for (const t of state.tools) {
      if (t.status === 'running') t.status = 'done';
    }
    emit();
    return;
  }

  if (evt.type === 'error') {
    state.error = evt.error?.message || evt.message || JSON.stringify(evt);
    emit();
  }
}

export function runAgentTurn({ hostConfig, conversation, prompt, attachments = [], onUpdate, onComplete }) {
  const agent = conversation.agent || 'codex';
  const turn = createTurnState(onUpdate);
  const turnStartedAt = Date.now();

  let cmd;
  let stdin = null;

  if (agent === 'codex') {
    const finalPrompt = enrichPromptWithAttachments(prompt, attachments);
    cmd = buildCodexCommand(conversation, attachments);
    stdin = finalPrompt;
  } else if (agent === 'agy') {
    const finalPrompt = enrichPromptWithAttachments(prompt, attachments);
    cmd = buildAgyCommand(finalPrompt, conversation);
  } else {
    cmd = buildShellCommand(prompt, conversation);
  }

  let stdoutBuf = '';
  let stderrText = '';

  const handle = execStream(hostConfig, cmd, {
    stdin,
    onStdout(chunk) {
      if (agent === 'shell') {
        turn.state.content += chunk;
        turn.emit();
        return;
      }
      stdoutBuf += chunk;
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        if (agent === 'codex') handleCodexLine(line, turn);
        else if (agent === 'agy') handleAgyLine(line, turn);
      }
    },
    onStderr(chunk) {
      stderrText += chunk;
      if (agent === 'shell') {
        turn.state.error += chunk;
        turn.emit();
      }
    },
    onError(err) {
      turn.state.error = err.message || String(err);
      for (const t of turn.state.tools) {
        if (t.status === 'running') t.status = 'error';
      }
      onComplete({
        ...turn.state,
        exitCode: 1,
        status: 'error'
      });
    },
    async onClose(code, aborted) {
      if (stdoutBuf.trim() && agent !== 'shell') {
        if (agent === 'codex') handleCodexLine(stdoutBuf, turn);
        else if (agent === 'agy') handleAgyLine(stdoutBuf, turn);
      }

      for (const t of turn.state.tools) {
        if (t.status === 'running') t.status = aborted ? 'error' : 'done';
      }

      if (aborted) {
        turn.state.error = turn.state.error || '已手动停止';
      } else if (code !== 0 && !turn.state.error && stderrText.trim()) {
        turn.state.error = stderrText.trim().slice(-2000);
      } else if (!turn.state.content && !turn.state.error && stderrText.trim() && agent !== 'shell') {
        turn.state.error = stderrText.trim().slice(-2000);
      }

      // Detect newly created/modified or mentioned files on the remote host so the user
      // gets instant one-tap download/preview cards right in the chat bubble!
      if (!aborted) {
        for (const p of extractMentionedPaths(turn.state.content)) {
          turn.candidateFiles.add(p);
        }
        try {
          const uploadedPaths = new Set((attachments || []).map((a) => a.path));
          const detected = await detectOutputFiles(
            hostConfig,
            conversation.cwd,
            Array.from(turn.candidateFiles),
            turnStartedAt
          );
          turn.state.files = detected.filter((f) => !uploadedPaths.has(f.path));
        } catch {
          turn.state.files = [];
        }
      }

      onComplete({
        ...turn.state,
        exitCode: code,
        status: aborted ? 'aborted' : (code === 0 && !turn.state.error ? 'done' : 'error')
      });
    }
  });

  return handle;
}
