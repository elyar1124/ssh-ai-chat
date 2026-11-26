import { execOnce } from './sshManager.js';

const modelsCache = new Map(); // hostId -> { ts, data }
const CACHE_TTL_MS = 120_000;

function stripAnsi(str) {
  return String(str || '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r[^\n]*\r/g, '\n')
    .replace(/\r/g, '\n');
}

/**
 * Fetch available models for both Codex CLI and Antigravity CLI (agy)
 * directly from the target host (local or SSH).
 */
export async function fetchHostModels(hostConfig, { forceRefresh = false } = {}) {
  const cached = modelsCache.get(hostConfig.id);
  if (!forceRefresh && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  const pyCode = [
    'import json, os, re, subprocess',
    'out = {"codex": {"defaultModel": "", "defaultEffort": "", "models": []}, "agy": {"models": []}}',
    '# 1. Codex config.toml',
    'cfg_path = os.path.expanduser("~/.codex/config.toml")',
    'if os.path.exists(cfg_path):',
    '    txt = open(cfg_path, encoding="utf-8", errors="ignore").read()',
    '    m = re.search(r\'^\\s*model\\s*=\\s*"([^"]+)"\', txt, re.M)',
    '    if m: out["codex"]["defaultModel"] = m.group(1)',
    '    e = re.search(r\'^\\s*model_reasoning_effort\\s*=\\s*"([^"]+)"\', txt, re.M)',
    '    if e: out["codex"]["defaultEffort"] = e.group(1)',
    '# 2. Codex models_cache.json',
    'mc_path = os.path.expanduser("~/.codex/models_cache.json")',
    'if os.path.exists(mc_path):',
    '    try:',
    '        d = json.load(open(mc_path, encoding="utf-8"))',
    '        raw_models = d.get("models", []) if isinstance(d, dict) else (d if isinstance(d, list) else [])',
    '        for item in raw_models:',
    '            if not isinstance(item, dict): continue',
    '            slug = item.get("slug") or item.get("id") or item.get("name")',
    '            if not slug: continue',
    '            efforts = [x.get("effort") for x in (item.get("supported_reasoning_levels") or []) if isinstance(x, dict) and x.get("effort")]',
    '            out["codex"]["models"].append({',
    '                "id": slug,',
    '                "name": item.get("display_name") or slug,',
    '                "description": item.get("description") or "",',
    '                "efforts": efforts,',
    '                "defaultEffort": item.get("default_reasoning_level") or ""',
    '            })',
    '    except Exception: pass',
    '# 3. Antigravity CLI models',
    'env = os.environ.copy()',
    'env["PATH"] = os.path.expanduser("~/.local/bin") + ":/usr/local/bin:" + env.get("PATH", "")',
    'try:',
    '    p = subprocess.run(["agy", "models"], capture_output=True, text=True, timeout=12, env=env)',
    '    raw = (p.stdout or "") + "\\n" + (p.stderr or "")',
    '    raw = re.sub(r"\\x1b\\[[0-9;?]*[a-zA-Z]", "", raw)',
    '    for line in raw.replace("\\r", "\\n").splitlines():',
    '        s = line.strip()',
    '        if not s or "Fetching available models" in s: continue',
    '        m = re.match(r"^([a-zA-Z0-9._:/-]+)(?:\\t+|\\s{2,})(.+)$", s)',
    '        if m:',
    '            out["agy"]["models"].append({"id": m.group(1).strip(), "name": m.group(2).strip()})',
    'except Exception: pass',
    'print(json.dumps(out, ensure_ascii=False))'
  ].join('\n');

  const b64Py = Buffer.from(pyCode, 'utf8').toString('base64');
  const cmd = `python3 -c "$(printf '%s' '${b64Py}' | base64 -d)" 2>/dev/null`;
  const res = await execOnce(hostConfig, cmd, 18000);

  let data = {
    codex: { defaultModel: '', defaultEffort: '', models: [] },
    agy: { models: [] }
  };

  try {
    const cleaned = stripAnsi(res.stdout).trim();
    const lastLine = cleaned.split('\n').pop() || '{}';
    const parsed = JSON.parse(lastLine);
    if (parsed && typeof parsed === 'object') {
      data = parsed;
    }
  } catch {
    // Keep empty fallback
  }

  modelsCache.set(hostConfig.id, { ts: Date.now(), data });
  return data;
}

/**
 * Fetch Codex account rate-limits, latest session context/token usage,
 * and current session usage directly from the target host.
 */
export async function fetchRemoteUsage(hostConfig, remoteSessionId = '') {
  const b64Session = Buffer.from(String(remoteSessionId || ''), 'utf8').toString('base64');

  const pyCode = [
    'import json, os, glob, sys, base64, time',
    'target_sid = base64.b64decode(sys.argv[1]).decode("utf-8").strip()',
    'out = {"codex": None, "agy": None}',
    '# ---- 1. Codex sessions & rate_limits ----',
    'sessions = sorted(glob.glob(os.path.expanduser("~/.codex/sessions/**/*.jsonl"), recursive=True), key=os.path.getmtime, reverse=True)',
    'def extract_latest_usage(path):',
    '    try:',
    '        with open(path, encoding="utf-8", errors="ignore") as f:',
    '            lines = f.readlines()',
    '        for line in reversed(lines):',
    '            if "token_count" not in line: continue',
    '            obj = json.loads(line)',
    '            payload = obj.get("payload") or {}',
    '            if payload.get("type") == "token_count":',
    '                return {',
    '                    "timestamp": obj.get("timestamp"),',
    '                    "sessionFile": os.path.basename(path),',
    '                    "info": payload.get("info"),',
    '                    "rateLimits": payload.get("rate_limits")',
    '                }',
    '    except Exception:',
    '        pass',
    '    return None',
    'latest_global = None',
    'matched_session = None',
    'for sp in sessions[:25]:',
    '    if latest_global is None:',
    '        u = extract_latest_usage(sp)',
    '        if u and (u.get("rateLimits") or u.get("info")):',
    '            latest_global = u',
    '    if target_sid and matched_session is None and target_sid in os.path.basename(sp):',
    '        u = extract_latest_usage(sp)',
    '        if u: matched_session = u',
    '    if latest_global and (not target_sid or matched_session):',
    '        break',
    'if latest_global or matched_session:',
    '    out["codex"] = {',
    '        "rateLimits": (matched_session or latest_global or {}).get("rateLimits") or (latest_global or {}).get("rateLimits"),',
    '        "updatedAt": (latest_global or {}).get("timestamp"),',
    '        "latestSession": latest_global,',
    '        "currentSession": matched_session,',
    '        "totalSessionsCount": len(sessions)',
    '    }',
    '# ---- 2. Antigravity CLI transcripts usage ----',
    'agy_files = sorted(glob.glob(os.path.expanduser("~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl")), key=os.path.getmtime, reverse=True)',
    'if agy_files:',
    '    now_ts = time.time()',
    '    cutoff_24h = now_ts - 86400',
    '    total_steps = 0',
    '    total_in = 0',
    '    total_cache = 0',
    '    total_out = 0',
    '    day_steps = 0',
    '    day_in = 0',
    '    day_cache = 0',
    '    day_out = 0',
    '    by_model = {}',
    '    latest_agy = None',
    '    current_agy = None',
    '    for fp in agy_files[:60]:',
    '        cid = os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(fp))))',
    '        mtime = os.path.getmtime(fp)',
    '        s_steps = 0; s_in = 0; s_cache = 0; s_out = 0; last_model = ""; last_ctx = 0; last_ts = ""',
    '        try:',
    '            with open(fp, encoding="utf-8", errors="ignore") as f:',
    '                for line in f:',
    '                    if "input_tokens" not in line and "output_tokens" not in line: continue',
    '                    try: obj = json.loads(line)',
    '                    except Exception: continue',
    '                    it = int(obj.get("input_tokens") or 0)',
    '                    ct = int(obj.get("cache_read_tokens") or 0)',
    '                    ot = int(obj.get("output_tokens") or 0)',
    '                    if it == 0 and ct == 0 and ot == 0: continue',
    '                    s_steps += 1; s_in += it; s_cache += ct; s_out += ot',
    '                    last_ctx = it + ct',
    '                    mdl = obj.get("model") or ""',
    '                    if mdl: last_model = mdl',
    '                    if obj.get("created_at"): last_ts = obj.get("created_at")',
    '                    if mdl:',
    '                        bm = by_model.setdefault(mdl, {"model": mdl, "steps": 0, "inputTokens": 0, "cacheReadTokens": 0, "outputTokens": 0})',
    '                        bm["steps"] += 1; bm["inputTokens"] += it; bm["cacheReadTokens"] += ct; bm["outputTokens"] += ot',
    '        except Exception:',
    '            continue',
    '        if s_steps == 0: continue',
    '        total_steps += s_steps; total_in += s_in; total_cache += s_cache; total_out += s_out',
    '        if mtime >= cutoff_24h:',
    '            day_steps += s_steps; day_in += s_in; day_cache += s_cache; day_out += s_out',
    '        summary = {"conversationId": cid, "model": last_model, "steps": s_steps, "inputTokens": s_in, "cacheReadTokens": s_cache, "outputTokens": s_out, "lastContextTokens": last_ctx, "updatedAt": last_ts}',
    '        if latest_agy is None: latest_agy = summary',
    '        if target_sid and cid == target_sid: current_agy = summary',
    '    top_models = sorted(by_model.values(), key=lambda x: x["inputTokens"] + x["cacheReadTokens"] + x["outputTokens"], reverse=True)[:5]',
    '    out["agy"] = {',
    '        "totalSessions": len(agy_files),',
    '        "currentSession": current_agy,',
    '        "latestSession": latest_agy,',
    '        "last24h": {"steps": day_steps, "inputTokens": day_in, "cacheReadTokens": day_cache, "outputTokens": day_out},',
    '        "allTime": {"steps": total_steps, "inputTokens": total_in, "cacheReadTokens": total_cache, "outputTokens": total_out},',
    '        "byModel": top_models',
    '    }',
    'print(json.dumps(out, ensure_ascii=False))'
  ].join('\n');

  const b64Py = Buffer.from(pyCode, 'utf8').toString('base64');
  const cmd = `python3 -c "$(printf '%s' '${b64Py}' | base64 -d)" '${b64Session}' 2>/dev/null || echo '{"codex":null,"agy":null}'`;

  try {
    const res = await execOnce(hostConfig, cmd, 12000);
    return JSON.parse((res.stdout || '').trim() || '{"codex":null,"agy":null}');
  } catch {
    return { codex: null, agy: null };
  }
}

/**
 * Aggregate token usage from local app store for a conversation & host.
 */
export function summarizeAppUsage(store, hostId, conversationId = null) {
  const allConvs = store.state.conversations.filter((c) => c.hostId === hostId);

  const sumMessages = (messages) => {
    let turns = 0;
    let inputTokens = 0;
    let cachedTokens = 0;
    let outputTokens = 0;
    for (const m of messages || []) {
      if (m.role === 'assistant') {
        turns++;
        if (m.usage) {
          inputTokens += Number(m.usage.input_tokens ?? m.usage.inputTokens ?? 0) || 0;
          cachedTokens += Number(m.usage.cached_input_tokens ?? m.usage.cachedInputTokens ?? m.usage.cache_read_input_tokens ?? m.usage.cache_read_tokens ?? 0) || 0;
          outputTokens += Number(m.usage.output_tokens ?? m.usage.outputTokens ?? 0) || 0;
        }
      }
    }
    return {
      turns,
      inputTokens,
      cachedTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens
    };
  };

  let hostTurns = 0;
  let hostInput = 0;
  let hostCached = 0;
  let hostOutput = 0;
  for (const c of allConvs) {
    const s = sumMessages(c.messages);
    hostTurns += s.turns;
    hostInput += s.inputTokens;
    hostCached += s.cachedTokens;
    hostOutput += s.outputTokens;
  }

  const activeConv = conversationId ? store.getConversation(conversationId) : null;

  return {
    conversation: activeConv
      ? {
          id: activeConv.id,
          title: activeConv.title,
          agent: activeConv.agent,
          model: activeConv.options?.model || '',
          effort: activeConv.options?.effort || '',
          remoteSessionId: activeConv.remoteSessionId || null,
          ...sumMessages(activeConv.messages)
        }
      : null,
    hostTotal: {
      conversations: allConvs.length,
      turns: hostTurns,
      inputTokens: hostInput,
      cachedTokens: hostCached,
      outputTokens: hostOutput,
      totalTokens: hostInput + hostOutput
    }
  };
}
