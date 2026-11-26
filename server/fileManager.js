import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectSSH, execOnce } from './sshManager.js';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic']);

const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4'
};

export function isImageName(name) {
  return IMAGE_EXTS.has(path.extname(String(name || '')).toLowerCase());
}

export function getMimeType(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

export function sanitizeFilename(rawName) {
  const base = path.basename(String(rawName || 'file').replace(/\\/g, '/'));
  // Preserve Unicode (Chinese etc.), letters, numbers, dots, hyphens, spaces, underscores
  const cleaned = base.replace(/[\x00-\x1f<>:"/|?*]/g, '_').trim();
  return cleaned || `file_${Date.now()}`;
}

function getSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
}

function sftpRealpath(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.realpath(p, (err, abs) => {
      if (err) reject(err);
      else resolve(abs);
    });
  });
}

function sftpReaddir(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.readdir(p, (err, list) => {
      if (err) reject(err);
      else resolve(list);
    });
  });
}

function sftpStat(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.stat(p, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });
}

function sftpMkdir(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(p, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function sftpEnsureDir(sftp, dirPath) {
  const parts = path.posix.normalize(dirPath).split('/').filter(Boolean);
  let cur = dirPath.startsWith('/') ? '' : '.';
  for (const part of parts) {
    cur = cur === '' ? `/${part}` : `${cur}/${part}`;
    try {
      await sftpStat(sftp, cur);
    } catch {
      try {
        await sftpMkdir(sftp, cur);
      } catch {
        // Might race or already exist
      }
    }
  }
}

function sftpWriteBuffer(sftp, remotePath, buffer) {
  return new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(remotePath);
    ws.on('error', reject);
    ws.on('close', resolve);
    ws.end(buffer);
  });
}

function sftpUnlink(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function resolveLocalPath(p) {
  const str = String(p || '~').trim() || '~';
  if (str === '~') return os.homedir();
  if (str.startsWith('~/')) return path.join(os.homedir(), str.slice(2));
  return path.resolve(str);
}

async function resolveSftpPath(sftp, p) {
  const str = String(p || '~').trim() || '~';
  const home = await sftpRealpath(sftp, '.');
  if (str === '~') return home;
  if (str.startsWith('~/')) return path.posix.join(home, str.slice(2));
  if (!str.startsWith('/')) return path.posix.join(home, str);
  return path.posix.normalize(str);
}

/**
 * List files in a directory on local or SSH host.
 */
export async function listDirectory(hostConfig, dirPath = '~') {
  if (hostConfig.type === 'local') {
    const absDir = resolveLocalPath(dirPath);
    const items = await fsp.readdir(absDir, { withFileTypes: true });
    const entries = [];

    for (const item of items) {
      const full = path.join(absDir, item.name);
      try {
        const st = await fsp.stat(full);
        entries.push({
          name: item.name,
          path: full,
          isDir: st.isDirectory(),
          size: st.size,
          mtime: st.mtimeMs,
          isImage: !st.isDirectory() && isImageName(item.name)
        });
      } catch {
        // Ignore broken symlinks or inaccessible entries
      }
    }

    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return b.mtime - a.mtime;
    });

    const parent = path.dirname(absDir);
    return {
      dir: absDir,
      parent: parent !== absDir ? parent : null,
      entries
    };
  }

  const conn = await connectSSH(hostConfig);
  try {
    const sftp = await getSftp(conn);
    const absDir = await resolveSftpPath(sftp, dirPath);
    const rawList = await sftpReaddir(sftp, absDir);

    const entries = rawList
      .filter((item) => item.filename !== '.' && item.filename !== '..')
      .map((item) => {
        const isDir = item.attrs.isDirectory();
        return {
          name: item.filename,
          path: path.posix.join(absDir, item.filename),
          isDir,
          size: item.attrs.size || 0,
          mtime: (item.attrs.mtime || 0) * 1000,
          isImage: !isDir && isImageName(item.filename)
        };
      });

    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return b.mtime - a.mtime;
    });

    const parent = path.posix.dirname(absDir);
    return {
      dir: absDir,
      parent: parent !== absDir ? parent : null,
      entries
    };
  } finally {
    try { conn.end(); } catch {}
  }
}

/**
 * Upload a binary buffer to local or SSH host.
 * If mode === 'chat', saves inside `<dir>/.ssh-ai-uploads/<timestamp>_<name>` so it doesn't clutter the repo root.
 * If mode === 'dir', saves directly into `<dir>/<name>`.
 */
export async function uploadFile(hostConfig, dirPath, rawFileName, buffer, { mode = 'chat' } = {}) {
  const safeName = sanitizeFilename(rawFileName);
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(4, 14);
  const finalName = mode === 'chat' ? `${stamp}_${safeName}` : safeName;

  if (hostConfig.type === 'local') {
    const baseDir = resolveLocalPath(dirPath);
    const targetDir = mode === 'chat' ? path.join(baseDir, '.ssh-ai-uploads') : baseDir;
    await fsp.mkdir(targetDir, { recursive: true });
    const fullPath = path.join(targetDir, finalName);
    await fsp.writeFile(fullPath, buffer);
    return {
      path: fullPath,
      name: safeName,
      storedName: finalName,
      size: buffer.length,
      isImage: isImageName(safeName)
    };
  }

  const conn = await connectSSH(hostConfig);
  try {
    const sftp = await getSftp(conn);
    const baseDir = await resolveSftpPath(sftp, dirPath);
    const targetDir = mode === 'chat' ? path.posix.join(baseDir, '.ssh-ai-uploads') : baseDir;
    await sftpEnsureDir(sftp, targetDir);
    const fullPath = path.posix.join(targetDir, finalName);
    await sftpWriteBuffer(sftp, fullPath, buffer);
    return {
      path: fullPath,
      name: safeName,
      storedName: finalName,
      size: buffer.length,
      isImage: isImageName(safeName)
    };
  } finally {
    try { conn.end(); } catch {}
  }
}

/**
 * Stream a file from local or SSH host directly to an Express response.
 */
export async function streamFileToResponse(hostConfig, filePath, res, { inline = false } = {}) {
  if (hostConfig.type === 'local') {
    const absPath = resolveLocalPath(filePath);
    const st = await fsp.stat(absPath);
    if (st.isDirectory()) throw new Error('不能直接下载文件夹');
    const name = path.basename(absPath);
    const mime = getMimeType(name);
    const encoded = encodeURIComponent(name);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', st.size);
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encoded}`
    );
    const stream = fs.createReadStream(absPath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.pipe(res);
    return;
  }

  const conn = await connectSSH(hostConfig);
  try {
    const sftp = await getSftp(conn);
    const absPath = await resolveSftpPath(sftp, filePath);
    const st = await sftpStat(sftp, absPath);
    if (st.isDirectory()) {
      conn.end();
      throw new Error('不能直接下载文件夹');
    }

    const name = path.posix.basename(absPath);
    const mime = getMimeType(name);
    const encoded = encodeURIComponent(name);
    res.setHeader('Content-Type', mime);
    if (typeof st.size === 'number') res.setHeader('Content-Length', st.size);
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encoded}`
    );

    const rs = sftp.createReadStream(absPath);
    const cleanup = () => {
      try { conn.end(); } catch {}
    };
    rs.on('end', cleanup);
    rs.on('close', cleanup);
    rs.on('error', () => {
      cleanup();
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    res.on('close', cleanup);
    rs.pipe(res);
  } catch (err) {
    try { conn.end(); } catch {}
    throw err;
  }
}

/**
 * Delete a file on local or SSH host.
 */
export async function deleteFile(hostConfig, filePath) {
  if (hostConfig.type === 'local') {
    const absPath = resolveLocalPath(filePath);
    const st = await fsp.stat(absPath);
    if (st.isDirectory()) throw new Error('为安全起见暂不支持直接删除文件夹');
    await fsp.unlink(absPath);
    return true;
  }

  const conn = await connectSSH(hostConfig);
  try {
    const sftp = await getSftp(conn);
    const absPath = await resolveSftpPath(sftp, filePath);
    const st = await sftpStat(sftp, absPath);
    if (st.isDirectory()) throw new Error('为安全起见暂不支持直接删除文件夹');
    await sftpUnlink(sftp, absPath);
    return true;
  } finally {
    try { conn.end(); } catch {}
  }
}

/**
 * Detect output/generated files from a completed agent turn:
 * 1) Checks explicit candidate paths extracted from tool calls & assistant text.
 * 2) Scans `cwd` (max depth 2) for files created/modified since `turnStartedAt`.
 * Returns verified existing files: [{ path, name, size, isImage }].
 */
export async function detectOutputFiles(hostConfig, cwd, candidatePaths = [], turnStartedAt = Date.now()) {
  const uniqueCandidates = Array.from(new Set(candidatePaths.filter(Boolean))).slice(0, 30);
  const b64Payload = Buffer.from(
    JSON.stringify({
      cwd: cwd || '~',
      candidates: uniqueCandidates,
      sinceSec: Math.floor((turnStartedAt - 2000) / 1000)
    }),
    'utf8'
  ).toString('base64');

  // Lightweight Python 3 probe (falls back gracefully if python3 unavailable)
  const pyCode = [
    'import os, sys, json, base64',
    'cfg = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))',
    'cwd = os.path.expanduser(cfg["cwd"] or "~")',
    'if not os.path.isdir(cwd): cwd = os.path.expanduser("~")',
    'since = cfg["sinceSec"]',
    'seen = {}',
    'def add(p):',
    '    if not p: return',
    '    p = os.path.expanduser(p)',
    '    if not os.path.isabs(p): p = os.path.normpath(os.path.join(cwd, p))',
    '    if p in seen: return',
    '    try:',
    '        st = os.stat(p)',
    '        if os.path.isfile(p) and st.st_size >= 0:',
    '            seen[p] = {"path": p, "name": os.path.basename(p), "size": st.st_size, "mtime": st.st_mtime}',
    '    except OSError: pass',
    'for c in cfg["candidates"]: add(c)',
    'skip_dirs = {".git", "node_modules", ".ssh-ai-uploads", "__pycache__", ".venv", "venv", ".cache", ".next", "dist", "ssh-ai-chat"}',
    'for root, dirs, files in os.walk(cwd):',
    '    rel = os.path.relpath(root, cwd)',
    '    depth = 0 if rel == "." else rel.count(os.sep) + 1',
    '    dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith(".")] if depth < 2 else []',
    '    for f in files:',
    '        if f.startswith(".") or f in ("state.json", "state.json.tmp"): continue',
    '        fp = os.path.join(root, f)',
    '        try:',
    '            st = os.stat(fp)',
    '            if st.st_mtime >= since:',
    '                add(fp)',
    '        except OSError: pass',
    'res = sorted(seen.values(), key=lambda x: x["mtime"], reverse=True)[:12]',
    'print(json.dumps(res, ensure_ascii=False))'
  ].join('\n');

  const b64Py = Buffer.from(pyCode, 'utf8').toString('base64');
  const cmd = `python3 -c "$(printf '%s' '${b64Py}' | base64 -d)" '${b64Payload}' 2>/dev/null || echo '[]'`;

  try {
    const res = await execOnce(hostConfig, cmd, 8000);
    const parsed = JSON.parse(res.stdout.trim() || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((f) => ({
      path: f.path,
      name: f.name,
      size: f.size || 0,
      isImage: isImageName(f.name)
    }));
  } catch {
    return [];
  }
}
