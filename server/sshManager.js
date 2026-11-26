import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from 'ssh2';

function resolveHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function buildSshConnectConfig(hostConfig) {
  const cfg = {
    host: hostConfig.host,
    port: Number(hostConfig.port) || 22,
    username: hostConfig.username,
    readyTimeout: 15000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
    tryKeyboard: true
  };

  const authType = hostConfig.authType || 'token';

  if (authType === 'token' || authType === 'none') {
    // InstaBox and similar token-in-username SSH gateways accept 'none',
    // empty keyboard-interactive, or empty password authentication.
    cfg.password = '';
    cfg.authHandler = ['none', 'keyboard-interactive', 'password'];
  } else if (authType === 'password') {
    cfg.password = hostConfig.password || '';
  } else if (authType === 'key') {
    if (hostConfig.privateKey && hostConfig.privateKey.trim()) {
      cfg.privateKey = hostConfig.privateKey;
    } else if (hostConfig.privateKeyPath && hostConfig.privateKeyPath.trim()) {
      const keyPath = resolveHome(hostConfig.privateKeyPath.trim());
      cfg.privateKey = fs.readFileSync(keyPath, 'utf8');
    } else {
      throw new Error('请填写私钥内容或私钥文件路径');
    }
    if (hostConfig.passphrase) {
      cfg.passphrase = hostConfig.passphrase;
    }
  }

  return cfg;
}

export function connectSSH(hostConfig) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch {}
      reject(err);
    };

    conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      const answers = prompts.map(() => hostConfig.password || '');
      finish(answers);
    });

    conn.on('ready', () => {
      if (settled) return;
      settled = true;
      resolve(conn);
    });

    conn.on('error', (err) => {
      fail(err);
    });

    conn.on('close', () => {
      if (!settled) {
        fail(new Error('SSH 连接已关闭'));
      }
    });

    try {
      const cfg = buildSshConnectConfig(hostConfig);
      conn.connect(cfg);
    } catch (err) {
      fail(err);
    }
  });
}

/**
 * Execute a command on a host (local or SSH) and stream stdout/stderr.
 * Returns { abort() }.
 */
export function execStream(hostConfig, command, callbacks = {}) {
  const { stdin, onStdout, onStderr, onClose, onError } = callbacks;
  let aborted = false;

  if (hostConfig.type === 'local') {
    const child = spawn('/bin/bash', ['-lc', command], {
      env: {
        ...process.env,
        HOME: process.env.HOME || os.homedir(),
        TERM: 'dumb',
        FORCE_COLOR: '0',
        NO_COLOR: '1'
      }
    });

    child.stdout.on('data', (chunk) => onStdout?.(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => onStderr?.(chunk.toString('utf8')));
    child.on('error', (err) => onError?.(err));
    child.on('close', (code, signal) => onClose?.(code ?? (signal ? 130 : 0), aborted));

    if (stdin !== undefined && stdin !== null) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    return {
      abort() {
        aborted = true;
        try { child.kill('SIGINT'); } catch {}
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 1200);
      }
    };
  }

  // SSH remote host
  let conn = null;
  let streamRef = null;

  connectSSH(hostConfig)
    .then((c) => {
      if (aborted) {
        c.end();
        onClose?.(130, true);
        return;
      }
      conn = c;
      conn.exec(command, { pty: false }, (err, stream) => {
        if (err) {
          conn.end();
          onError?.(err);
          return;
        }
        streamRef = stream;

        stream.on('data', (chunk) => onStdout?.(chunk.toString('utf8')));
        stream.stderr.on('data', (chunk) => onStderr?.(chunk.toString('utf8')));
        stream.on('close', (code) => {
          try { conn.end(); } catch {}
          onClose?.(typeof code === 'number' ? code : (aborted ? 130 : 0), aborted);
        });
        stream.on('error', (streamErr) => {
          onError?.(streamErr);
        });

        if (stdin !== undefined && stdin !== null) {
          stream.write(stdin);
          stream.end();
        } else {
          stream.end();
        }
      });
    })
    .catch((err) => {
      onError?.(err);
    });

  return {
    abort() {
      aborted = true;
      if (streamRef) {
        try { streamRef.signal('INT'); } catch {}
        try { streamRef.close(); } catch {}
      }
      if (conn) {
        try { conn.end(); } catch {}
      }
    }
  };
}

/**
 * Run a short one-shot command and collect full stdout/stderr.
 */
export function execOnce(hostConfig, command, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        handle.abort();
        reject(new Error('命令执行超时'));
      }
    }, timeoutMs);

    const handle = execStream(hostConfig, command, {
      onStdout: (d) => { stdout += d; },
      onStderr: (d) => { stderr += d; },
      onError: (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(err);
      },
      onClose: (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      }
    });
  });
}

/**
 * Test SSH/local connectivity and probe installed agents (agy, codex).
 */
export async function testHost(hostConfig) {
  const probeCmd = [
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/usr/local/bin:$PATH"',
    '[ -f "$HOME/.profile" ] && . "$HOME/.profile" 2>/dev/null || true',
    'echo "UNAME:$(uname -srm)"',
    'echo "HOME:$HOME"',
    'echo "PWD:$(pwd)"',
    'echo "AGY:$(command -v agy 2>/dev/null || true)"',
    'echo "CODEX:$(command -v codex 2>/dev/null || true)"'
  ].join('; ');

  const startedAt = Date.now();
  const res = await execOnce(hostConfig, probeCmd, 15000);
  const latencyMs = Date.now() - startedAt;

  const info = {
    ok: res.code === 0,
    latencyMs,
    uname: '',
    home: '',
    pwd: '',
    hasAgy: false,
    agyPath: '',
    hasCodex: false,
    codexPath: '',
    stderr: res.stderr.trim()
  };

  for (const line of res.stdout.split(/\r?\n/)) {
    if (line.startsWith('UNAME:')) info.uname = line.slice(6).trim();
    else if (line.startsWith('HOME:')) info.home = line.slice(5).trim();
    else if (line.startsWith('PWD:')) info.pwd = line.slice(4).trim();
    else if (line.startsWith('AGY:')) {
      info.agyPath = line.slice(4).trim();
      info.hasAgy = Boolean(info.agyPath);
    } else if (line.startsWith('CODEX:')) {
      info.codexPath = line.slice(6).trim();
      info.hasCodex = Boolean(info.codexPath);
    }
  }
  return info;
}

/**
 * Open an interactive PTY shell over SSH (or local Python pty wrapper).
 */
export async function openPtyShell(hostConfig, { cols = 80, rows = 24, cwd = '', onData, onClose, onError }) {
  if (hostConfig.type === 'local') {
    // Use python3 pty so local terminal supports full interactive TUI (vim/codex/agy/etc.)
    const pyScript = [
      'import os, pty, sys, fcntl, termios, struct, select, signal',
      'pid, fd = pty.fork()',
      'if pid == 0:',
      '    os.environ["TERM"] = "xterm-256color"',
      '    os.execvp("/bin/bash", ["/bin/bash", "-l"])',
      'else:',
      '    while True:',
      '        r, _, _ = select.select([fd, sys.stdin.fileno()], [], [])',
      '        if fd in r:',
      '            try:',
      '                data = os.read(fd, 4096)',
      '                if not data: break',
      '                os.write(sys.stdout.fileno(), data)',
      '            except OSError: break',
      '        if sys.stdin.fileno() in r:',
      '            try:',
      '                data = os.read(sys.stdin.fileno(), 4096)',
      '                if not data: break',
      '                os.write(fd, data)',
      '            except OSError: break'
    ].join('\n');

    const child = spawn('python3', ['-u', '-c', pyScript], {
      cwd: resolveHome(cwd) || os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color' }
    });

    child.stdout.on('data', (d) => onData?.(d.toString('utf8')));
    child.stderr.on('data', (d) => onData?.(d.toString('utf8')));
    child.on('error', (err) => onError?.(err));
    child.on('close', () => onClose?.());

    return {
      write(data) {
        try { child.stdin.write(data); } catch {}
      },
      resize(c, r) {
        // Basic stty resize fallback for local mode
        if (c > 0 && r > 0) {
          try { child.stdin.write(''); } catch {}
        }
      },
      close() {
        try { child.kill('SIGHUP'); } catch {}
      }
    };
  }

  const conn = await connectSSH(hostConfig);
  return new Promise((resolve, reject) => {
    conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) {
        conn.end();
        reject(err);
        return;
      }

      stream.on('data', (d) => onData?.(d.toString('utf8')));
      stream.stderr?.on('data', (d) => onData?.(d.toString('utf8')));
      stream.on('close', () => {
        try { conn.end(); } catch {}
        onClose?.();
      });
      stream.on('error', (e) => onError?.(e));

      if (cwd && cwd !== '~') {
        const safeCwd = cwd.replace(/'/g, "'\\''");
        stream.write(`cd '${safeCwd}' 2>/dev/null; clear\n`);
      }

      resolve({
        write(data) {
          try { stream.write(data); } catch {}
        },
        resize(c, r) {
          try { stream.setWindow(r, c, 0, 0); } catch {}
        },
        close() {
          try { stream.close(); } catch {}
          try { conn.end(); } catch {}
        }
      });
    });
  });
}

/**
 * Parse a pasted SSH command string like:
 *   ssh -p 2222 ibssh_xxxx@ssh.instabox.sh
 *   ssh root@1.2.3.4 -p 2200
 */
export function parseSshCommand(raw) {
  const str = String(raw || '').trim();
  if (!str) return null;

  let port = 22;
  const portMatch = str.match(/(?:^|\s)-p\s*(\d+)/);
  if (portMatch) port = Number(portMatch[1]) || 22;

  // Match user@host token
  const targetMatch = str.match(/([^\s@]+)@([A-Za-z0-9._:-]+)/);
  if (!targetMatch) return null;

  const username = targetMatch[1].replace(/^['"]|['"]$/g, '');
  const host = targetMatch[2].replace(/^['"]|['"]$/g, '');
  const isInstaBox = host.includes('instabox.sh') || username.startsWith('ibssh_');

  return {
    name: isInstaBox ? `InstaBox (${username.slice(0, 12)})` : `${username}@${host}`,
    type: 'ssh',
    host,
    port,
    username,
    authType: isInstaBox ? 'token' : 'password'
  };
}
