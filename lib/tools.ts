import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { diffLines } from 'diff';

const execAsync = promisify(exec);
const WORKSPACE = process.cwd();
const USER_DOCS = path.join(process.env.HOME || '/home/chau', 'Documents');
const BACKUP_DIR = path.join(WORKSPACE, '.agent_backups');
const SNAPSHOT_DIR = path.join(WORKSPACE, '.agent_snapshots');
const IGNORE_DIRS = ['node_modules', '.git', '.next', '.agent_backups', '.agent_chats', '.agent_snapshots', 'dist', 'build', 'coverage'];

// ═══════════════════════════════════════════════════════════
// CORE FILES: Self-update REQUIRES self_edit tool
// ═══════════════════════════════════════════════════════════
const CORE_FILES = [
  'lib/tools.ts',
  'lib/multiAgent.ts',
  'app/api/chat/route.ts',
  'app/api/multi-chat/route.ts',
  'app/page.tsx',
  'app/multi/page.tsx',
];

function isCoreFile(p: string): boolean {
  const normalized = p.replace(/^\.\//, '').replace(/\/+$/, '');
  return CORE_FILES.some((cf) => normalized === cf || normalized.endsWith('/' + cf));
}

export const toolSchemas = [
  { type: 'function', function: { name: 'open_url', description: 'Open a URL or project name in browser (auto-finds & starts projects).', parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } } },
  { type: 'function', function: { name: 'scan_project', description: 'Get project structure.', parameters: { type: 'object', properties: { max_depth: { type: 'number' } } } } },
  { type: 'function', function: { name: 'grep_search', description: 'Search for a text pattern.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, file_glob: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'update_plan', description: 'Create a checklist of steps.', parameters: { type: 'object', properties: { plan: { type: 'array', items: { type: 'string' } } }, required: ['plan'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create a NEW file only. BLOCKED if exists.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Surgical replace. Use for NON-core files only.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'self_edit', description: 'Surgical self-modification for CORE files. Takes snapshot → validates tsc → auto-rollback. Use for small changes.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'self_rewrite', description: 'Full file rewrite for CORE files. Use ONLY for major refactoring (e.g., converting page.tsx to Server Component). Takes snapshot → tsc validates → auto-rollback on failure. Requires reason.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: 'Complete new file content' }, reason: { type: 'string', description: 'Why full rewrite is necessary' } }, required: ['path', 'content', 'reason'] } } },
  { type: 'function', function: { name: 'verify_agent_health', description: 'Check if the agent itself is alive (ping localhost:3000). Run this after self_edit + restart.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'bash', description: 'Run a READ-ONLY bash command or background process.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'check_build', description: 'Run npm run build.', parameters: { type: 'object', properties: {} } } },
];

const HARD_BLOCK = ['rm -rf /', ':(){', '> /dev/sd', 'mkfs', 'dd if=/dev/zero', 'shutdown', 'reboot'];
const READONLY_GIT = ['status', 'diff', 'log', 'show', 'branch', 'remote', 'config', 'rev-parse', 'ls-files', 'blame'];
const SAFE_PREFIXES = ['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'pwd', 'which', 'file', 'stat', 'du', 'df', 'tree', 'echo', 'node', 'npm', 'npx', 'cargo', 'rustc', 'git', 'nohup', 'xdg-open', 'curl', 'sleep'];

function isShellWrite(cmd: string): { isWrite: boolean; reason?: string } {
  if (cmd.includes('> /tmp/') || cmd.includes('>> /tmp/')) return { isWrite: false };
  const commands = cmd.split(/&&|\|\||;/);
  for (const c of commands) {
    const trimmed = c.trim();
    if (!trimmed) continue;
    const redirectMatch = trimmed.match(/(?<![0-9&])>(?!>)\s*([^\s]+)/);
    if (redirectMatch) {
      const target = redirectMatch[1];
      if (!target.startsWith('/dev/null') && !target.startsWith('/dev/zero') && !target.startsWith('/tmp/') && !target.startsWith('&')) return { isWrite: true, reason: `output redirection (> ${target})` };
    }
    if (/>>\s*[^\s&]/.test(trimmed) && !trimmed.includes('/dev/null') && !trimmed.includes('/tmp/')) return { isWrite: true, reason: 'append redirection' };
    if (/\b(sed|perl|ruby|awk)\s+(-\S*i|--in-place)/.test(trimmed)) return { isWrite: true, reason: 'in-place editor' };
    if (/(^|\s)(tee|truncate)\s/.test(trimmed)) return { isWrite: true, reason: 'tee/truncate' };
    if (/^\s*(rm|mv|cp|ln|chmod|chown|chgrp|shred|dd|unlink)\s/.test(trimmed)) return { isWrite: true, reason: 'destructive command' };
    if (/^\s*(touch|mkdir|rmdir)\s/.test(trimmed)) return { isWrite: true, reason: 'file creation' };
  }
  return { isWrite: false };
}

export function needsApproval(name: string, args: any): { need: boolean; reason?: string; blocked?: boolean } {
  if (name === 'read_file' || name === 'update_plan' || name === 'check_build' || name === 'scan_project' || name === 'grep_search' || name === 'open_url' || name === 'verify_agent_health') return { need: false };
  if (name === 'write_file' || name === 'edit_file' || name === 'self_edit' || name === 'self_rewrite') {
    const p = String(args.path || '');
    // edit_file and write_file refuse core files
    if ((name === 'edit_file' || name === 'write_file') && isCoreFile(p)) {
      return { need: false, blocked: true, reason: `⛔ ${p} is a CORE file. Use ${name === 'write_file' ? 'self_rewrite' : 'self_edit'} tool instead (has snapshot + auto-rollback protection).` };
    }
    // self_rewrite only for core files
    if (name === 'self_rewrite' && !isCoreFile(p)) {
      return { need: false, blocked: true, reason: `⛔ self_rewrite is for CORE files only. Use write_file for new files or edit_file for non-core edits.` };
    }
    return { need: true, reason: 'File modification' };
  }
  if (name === 'bash') {
    const cmd = String(args.command || '');
    if (HARD_BLOCK.some((d) => cmd.includes(d))) return { need: false, blocked: true, reason: 'catastrophic' };
    const writeCheck = isShellWrite(cmd);
    if (writeCheck.isWrite) return { need: false, blocked: true, reason: `⛔ ${writeCheck.reason} FORBIDDEN. Use edit_file.` };
    const parts = cmd.trim().split(/\s+/);
    if (parts[0] === 'git') {
      const sub = parts[1] || '';
      if (READONLY_GIT.includes(sub)) return { need: false };
      return { need: true, reason: `git ${sub}` };
    }
    if (SAFE_PREFIXES.includes(parts[0])) return { need: false };
    return { need: true, reason: `command: ${parts[0]}` };
  }
  return { need: true, reason: 'Unknown tool' };
}

function resolveSafe(p: string): string {
  const full = path.resolve(p);
  const isInsideAgent = full.startsWith(WORKSPACE);
  const isInsideDocs = full.startsWith(USER_DOCS);
  if (!isInsideAgent && !isInsideDocs) throw new Error('Path outside allowed workspace');
  if (isInsideAgent && (p.includes('AGENT_RULES.md') || p.includes('.env') || p.includes('.git/'))) throw new Error('Protected file');
  return full;
}

export async function loadRules(): Promise<string> {
  try { return await fs.readFile(path.join(WORKSPACE, 'AGENT_RULES.md'), 'utf-8'); } catch { return "No specific rules."; }
}

export async function loadMemory(): Promise<string> {
  try { return await fs.readFile(path.join(WORKSPACE, '.agent_memory.md'), 'utf-8'); } catch { return "No memory yet."; }
}

export async function getPreviewDiff(name: string, args: any): Promise<string | null> {
  if (name !== 'write_file' && name !== 'edit_file' && name !== 'self_edit') return null;
  try {
    const full = resolveSafe(String(args.path || ''));
    let oldStr = '';
    try { oldStr = await fs.readFile(full, 'utf-8'); } catch {}
    let newStr = '';
    if (name === 'write_file') newStr = String(args.content ?? '');
    else {
      const oldToFind = String(args.old_string ?? '');
      if (!oldStr.includes(oldToFind)) return null;
      newStr = oldStr.replace(oldToFind, String(args.new_string ?? ''));
    }
    const changes = diffLines(oldStr, newStr);
    let diffStr = '';
    changes.forEach((part) => {
      const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
      part.value.split('\n').forEach((line) => { if (line) diffStr += prefix + line + '\n'; });
    });
    return diffStr;
  } catch { return null; }
}

async function backupFile(fullPath: string) {
  try {
    await fs.access(fullPath);
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const fileName = path.basename(fullPath);
    const time = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.copyFile(fullPath, path.join(BACKUP_DIR, `${time}_${fileName}`));
  } catch {}
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function verifyAndSave(fullPath: string, newContent: string) {
  const fileName = path.basename(fullPath);
  let oldContent = '';
  let exists = false;
  try { oldContent = await fs.readFile(fullPath, 'utf-8'); exists = true; } catch {}

  if (!newContent || newContent.trim().length < 10) throw new Error(`SAFETY: ${fileName} too short`);
  if (exists && oldContent.length > 500) {
    const shrinkRatio = newContent.length / oldContent.length;
    if (shrinkRatio < 0.4) throw new Error(`SAFETY: ${fileName} shrank to ${Math.round(shrinkRatio * 100)}%`);
  }

  const tmpPath = fullPath + '.agent_tmp';
  await fs.writeFile(tmpPath, newContent, 'utf-8');
  try {
    if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) {
      await execAsync('npx tsc --noEmit', { cwd: WORKSPACE, timeout: 90000 });
    }
    await fs.rename(tmpPath, fullPath);
  } catch (e: any) {
    await fs.unlink(tmpPath).catch(() => {});
    throw new Error(`SAFETY: TypeScript failed.\n\n${((e.stdout || '') + (e.stderr || '')).trim().slice(0, 3000)}`);
  }
}

// ═══════════════════════════════════════════════════════════
// 10/10 SELF-EDIT: snapshot → validate → tsc → rollback on fail
// ═══════════════════════════════════════════════════════════
async function selfEdit(filePath: string, oldString: string, newString: string): Promise<string> {
  const full = path.resolve(WORKSPACE, filePath);
  const fileName = path.basename(filePath);

  if (!(await fileExists(full))) throw new Error(`${filePath} does not exist. Use write_file for new files.`);

  const original = await fs.readFile(full, 'utf-8');

  // 1. Snapshot
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(SNAPSHOT_DIR, `${ts}_${fileName}`);
  await fs.writeFile(snapshotPath, original, 'utf-8');

  // 2. Uniqueness check
  if (!oldString) throw new Error('old_string is empty');
  const count = original.split(oldString).length - 1;
  if (count === 0) throw new Error(`old_string not found in ${fileName}. Read the file first and copy exact text.`);
  if (count > 1) throw new Error(`old_string appears ${count} times in ${fileName}. Include more context to make it unique.`);

  const updated = original.replace(oldString, newString);

  // 3. Critical marker check (per file type)
  const CRITICAL_MARKERS: Record<string, string[]> = {
    'page.tsx': ['export default function'],  // 'use client' removed — tsc catches real breaks
    'route.ts': ['export async function POST'],
    'tools.ts': ['export async function executeTool', 'export const toolSchemas'],
    'multiAgent.ts': ['export async function runMultiAgent'],
  };
  for (const [key, markers] of Object.entries(CRITICAL_MARKERS)) {
    if (fileName === key) {
      for (const m of markers) {
        if (original.includes(m) && !updated.includes(m)) {
          throw new Error(`⛔ BLOCKED: This edit would remove critical marker "${m}" from ${fileName}. This would break the agent. Aborted. Snapshot saved at ${path.basename(snapshotPath)}.`);
        }
      }
    }
  }

  // 4. Apply to disk
  await fs.writeFile(full, updated, 'utf-8');

  // 5. tsc validation
  try {
    await execAsync('npx tsc --noEmit', { cwd: WORKSPACE, timeout: 90000 });
  } catch (e: any) {
    // 6. Rollback
    await fs.writeFile(full, original, 'utf-8');
    const err = ((e.stdout || '') + (e.stderr || '')).slice(0, 3000);
    throw new Error(`⛔ SELF-EDIT FAILED. TypeScript broke. Auto-reverted ${fileName} to previous working version.\n\nTypeScript errors:\n${err}\n\n💡 Hint: Read the file again. You may need to fix MULTIPLE errors in one edit, not just one.`);
  }

  // 7. Success
  const isRoute = fileName === 'route.ts';
  const isPage = fileName === 'page.tsx';
  const isTools = fileName === 'tools.ts' || fileName === 'multiAgent.ts';
  const restartNote = (isRoute || isPage || isTools)
    ? '\n\n⚠️ This file triggers dev server restart. Your chat stream will end cleanly. After restart (~3s), verify with verify_agent_health in next message.'
    : '';

  return `✅ Self-edited ${fileName} safely. Snapshot: ${path.basename(snapshotPath)}${restartNote}`;
}

// ═══════════════════════════════════════════════════════════
// SELF-REWRITE: Full file replacement with safety net
// For legitimate refactoring (e.g., page.tsx → Server Component)
// ═══════════════════════════════════════════════════════════
async function selfRewrite(filePath: string, newContent: string, reason: string): Promise<string> {
  const full = path.resolve(WORKSPACE, filePath);
  const fileName = path.basename(filePath);

  if (!(await fileExists(full))) throw new Error(`${filePath} does not exist. Use write_file for new files.`);

  if (!newContent || newContent.trim().length < 20) {
    throw new Error(`Refusing to write ${fileName}: content is too short (${newContent.length} bytes). Likely truncated.`);
  }

  const original = await fs.readFile(full, 'utf-8');

  // Snapshot before touching anything
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(SNAPSHOT_DIR, `${ts}_${fileName}`);
  await fs.writeFile(snapshotPath, original, 'utf-8');

  // Structural validation: new content MUST have export default function for page/layout
  if (fileName === 'page.tsx' || fileName === 'layout.tsx') {
    if (!newContent.includes('export default function') && !newContent.includes('export default async function')) {
      throw new Error(`⛔ BLOCKED: ${fileName} rewrite must contain "export default function". Otherwise Next.js cannot route it.`);
    }
  }

  // For route.ts: must have POST or GET handler
  if (fileName === 'route.ts') {
    if (!newContent.includes('export async function POST') && !newContent.includes('export async function GET')) {
      throw new Error(`⛔ BLOCKED: ${fileName} rewrite must contain POST or GET handler.`);
    }
  }

  // Write to disk
  await fs.writeFile(full, newContent, 'utf-8');

  // Validate with tsc — if it fails, rollback
  try {
    await execAsync('npx tsc --noEmit', { cwd: WORKSPACE, timeout: 90000 });
  } catch (e: any) {
    await fs.writeFile(full, original, 'utf-8');
    const err = ((e.stdout || '') + (e.stderr || '')).slice(0, 3000);
    throw new Error(`⛔ SELF-REWRITE FAILED. TypeScript broke. Auto-reverted ${fileName} to previous version.\n\nReason user requested: ${reason}\n\nTypeScript errors:\n${err}`);
  }

  const restartNote = '\n\n⚠️ This file triggers dev server restart. Your chat stream will end cleanly. After restart (~3s), verify with verify_agent_health in next message.';
  return `✅ Self-rewrote ${fileName} safely (${newContent.length} bytes, reason: ${reason}). Snapshot: ${path.basename(snapshotPath)}${restartNote}`;
}

// ═══════════════════════════════════════════════════════════
// HEALTH CHECK: Verify agent still works after self-edit
// ═══════════════════════════════════════════════════════════
async function verifyHealth(): Promise<string> {
  try {
    const { stdout } = await execAsync(
      'curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000/',
      { timeout: 8000 }
    );
    const code = stdout.trim();
    if (code === '200' || code === '304' || code === '301') {
      return `✅ Agent healthy (HTTP ${code}). Ready to continue.`;
    }
    return `⚠️ Agent returned HTTP ${code}. May be restarting. Wait 5-10s and try again.`;
  } catch (e: any) {
    return `❌ Agent not responding (${e.message}). Dev server may still be restarting. Wait 10s and retry.`;
  }
}

function cleanOutput(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

async function runBashStreaming(cmd: string, onOutput?: (s: string) => void, timeoutMs = 60000): Promise<string> {
  return new Promise((resolve) => {
    let output = '';
    let killed = false;
    let killReason = '';
    const child = spawn('bash', ['-c', cmd], { cwd: WORKSPACE });
    const handleChunk = (data: Buffer) => {
      if (killed) return;
      const s = data.toString();
      output += s;
      if (output.length > 80000) { killed = true; killReason = 'output limit'; child.kill('SIGTERM'); return; }
      if (onOutput) { const c = cleanOutput(s); if (c) onOutput(c); }
    };
    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);
    const timer = setTimeout(() => { if (!killed) { killed = true; killReason = 'timeout'; child.kill('SIGKILL'); } }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const suffix = killed ? ` (${killReason})` : '';
      resolve(`exit: ${code}${suffix}\n\n${cleanOutput(output).slice(0, 15000)}`);
    });
    child.on('error', (err) => { clearTimeout(timer); resolve(`Error: ${err.message}`); });
  });
}

async function walkTree(dir: string, base: string, depth: number, maxDepth: number): Promise<string> {
  if (depth > maxDepth) return '';
  let out = '';
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const visible = entries.filter((e) => !IGNORE_DIRS.includes(e.name) && !e.name.startsWith('.env'));
    visible.sort((a, b) => {
      if (a.isDirectory() === b.isDirectory()) return a.name.localeCompare(b.name);
      return a.isDirectory() ? -1 : 1;
    });
    for (const e of visible) {
      const indent = '  '.repeat(depth);
      if (e.isDirectory()) {
        out += `${indent}${e.name}/\n`;
        out += await walkTree(path.join(dir, e.name), base, depth + 1, maxDepth);
      } else out += `${indent}${e.name}\n`;
    }
  } catch {}
  return out;
}

async function scanProject(maxDepth: number): Promise<string> {
  let result = '=== PROJECT STRUCTURE ===\n';
  result += await walkTree(WORKSPACE, WORKSPACE, 0, maxDepth);
  return result.slice(0, 12000);
}

async function smartOpen(target: string, onOutput?: (s: string) => void): Promise<string> {
  const t = target.trim();
  if (t.startsWith('http://') || t.startsWith('https://')) {
    onOutput?.(`🌐 Opening ${t}...\n`);
    spawn('xdg-open', [t], { detached: true, stdio: 'ignore' }).unref();
    return `✅ Opened ${t}`;
  }
  if (/^localhost:\d+/.test(t) || /^127\.0\.0\.1:\d+/.test(t)) {
    const url = `http://${t}`;
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return `✅ Opened ${url}`;
  }

  // Project name → find, detect port, start server, open
  const projectName = t.toLowerCase().replace(/\s+/g, '');
  let projectPath = '';
  try {
    const docs = await fs.readdir(USER_DOCS, { withFileTypes: true });
    const dirs = docs.filter((d) => d.isDirectory());
    const exact = dirs.find((d) => d.name === t || d.name.toLowerCase() === t.toLowerCase());
    if (exact) projectPath = path.join(USER_DOCS, exact.name);
    else {
      const fuzzy = dirs.find((d) => d.name.toLowerCase().includes(projectName));
      if (fuzzy) projectPath = path.join(USER_DOCS, fuzzy.name);
    }
  } catch {}
  if (!projectPath) throw new Error(`Project "${target}" not found in ~/Documents/`);

  onOutput?.(`📂 Found: ${projectPath}\n`);
  let port = 3000;
  try {
    const pkgRaw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw);
    const devScript = String(pkg.scripts?.dev || '');
    const portMatch = devScript.match(/(?:-p|--port)\s+(\d+)/) || devScript.match(/PORT=(\d+)/);
    if (portMatch) port = parseInt(portMatch[1], 10);
    else if (pkg.name?.toLowerCase().includes('genmart')) port = 4100;
  } catch {}

  onOutput?.(`🔍 Port: ${port}\n`);
  let isRunning = false;
  try {
    const check = await execAsync(`curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:${port}`, { timeout: 5000 });
    if (['200', '304', '301'].includes(check.stdout.trim())) isRunning = true;
  } catch {}

  if (!isRunning) {
    const hasNodeModules = await fileExists(path.join(projectPath, 'node_modules'));
    if (!hasNodeModules) {
      onOutput?.(`📦 Installing...\n`);
      try { await execAsync('npm install', { cwd: projectPath, timeout: 180000 }); } catch (e: any) { throw new Error(`npm install failed: ${e.message}`); }
    }
    onOutput?.(`🚀 Starting server...\n`);
    const logFile = `/tmp/${path.basename(projectPath)}.log`;
    spawn('bash', ['-c', `cd "${projectPath}" && nohup npm run dev > ${logFile} 2>&1 &`], { detached: true, stdio: 'ignore' }).unref();

    let ready = false;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const check = await execAsync(`curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:${port}`, { timeout: 5000 });
        if (['200', '304', '301'].includes(check.stdout.trim())) { ready = true; break; }
      } catch {}
    }
    if (!ready) throw new Error(`Server didn't start in 30s. Check ${logFile}`);
  }

  const url = `http://localhost:${port}`;
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  return `✅ Opened ${path.basename(projectPath)} at ${url}`;
}

export type ToolResult = { name: string; args: any; result: string };

export async function executeTool(name: string, args: any, onOutput?: (chunk: string) => void): Promise<ToolResult> {
  let result = '';
  try {
    if (name === 'open_url') {
      const target = String(args.target || args.url || '');
      if (!target) throw new Error('target required');
      result = await smartOpen(target, onOutput);
    } else if (name === 'verify_agent_health') {
      onOutput?.(`🏥 Checking agent health...\n`);
      result = await verifyHealth();
    } else if (name === 'self_edit') {
      onOutput?.(`🛡️ Self-editing ${args.path} (snapshot + tsc validate)...\n`);
      result = await selfEdit(String(args.path || ''), String(args.old_string || ''), String(args.new_string || ''));
      onOutput?.(`${result}\n`);
    } else if (name === 'self_rewrite') {
      onOutput?.(`🛡️ Self-rewriting ${args.path} (snapshot + tsc validate)...\n`);
      result = await selfRewrite(String(args.path || ''), String(args.content || ''), String(args.reason || 'user request'));
      onOutput?.(`${result}\n`);
    } else if (name === 'scan_project') {
      result = await scanProject(args.max_depth || 3);
    } else if (name === 'grep_search') {
      const pattern = String(args.pattern || '');
      onOutput?.(`🔍 Searching: ${args.pattern}\n`);
      result = await runBashStreaming(`grep -rn --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git -E "${pattern}" . 2>/dev/null | head -50`);
    } else if (name === 'update_plan') {
      result = 'Plan updated.';
    } else if (name === 'read_file') {
      const full = resolveSafe(String(args.path || ''));
      onOutput?.(`📖 Reading ${args.path}...\n`);
      const content = await fs.readFile(full, 'utf-8');
      result = content.length > 20000 ? content.slice(0, 20000) + '\n...(truncated)' : content;
    } else if (name === 'write_file') {
      const full = resolveSafe(String(args.path || ''));
      if (await fileExists(full)) throw new Error(`⛔ REWRITE BLOCKED: ${args.path} exists. Use ${isCoreFile(args.path) ? 'self_edit' : 'edit_file'}.`);
      onOutput?.(`📝 Creating NEW ${args.path}...\n`);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await verifyAndSave(full, String(args.content ?? ''));
      result = `✅ Created ${args.path}`;
    } else if (name === 'edit_file') {
      const full = resolveSafe(String(args.path || ''));
      if (!(await fileExists(full))) throw new Error(`File ${args.path} does not exist.`);
      onOutput?.(`✏️ Editing ${args.path}...\n`);
      await backupFile(full);
      const original = await fs.readFile(full, 'utf-8');
      const oldStr = String(args.old_string ?? '');
      const newStr = String(args.new_string ?? '');
      if (!oldStr) result = 'Error: old_string empty';
      else {
        const count = original.split(oldStr).length - 1;
        if (count === 0) result = 'Error: old_string not found.';
        else if (count > 1) result = `Error: old_string appears ${count} times.`;
        else {
          await verifyAndSave(full, original.replace(oldStr, newStr));
          result = `✅ Edited ${args.path}.`;
        }
      }
    } else if (name === 'bash') {
      const cmd = String(args.command || '');
      onOutput?.(`$ ${cmd}\n\n`);
      result = await runBashStreaming(cmd, onOutput);
    } else if (name === 'check_build') {
      onOutput?.(`$ NODE_ENV=production npm run build\n\n`);
      const buildOut = await runBashStreaming('NODE_ENV=production npm run build', onOutput, 180000);
      if (buildOut.includes('exit: 0')) result = `✅ BUILD SUCCESSFUL\n\n${buildOut.slice(0, 4000)}`;
      else result = `❌ BUILD FAILED\n\n${buildOut.slice(0, 8000)}`;
    } else {
      result = `Unknown tool: ${name}`;
    }
  } catch (e: any) { result = `Error: ${e.message}`; }
  return { name, args, result };
}

export async function runVerify(): Promise<{ ok: boolean; output: string; command: string }> {
  const cmd = 'npx tsc --noEmit';
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd: WORKSPACE, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, output: ((stdout || '') + (stderr || '')).trim() || 'No errors.', command: cmd };
  } catch (e: any) {
    return { ok: false, output: ((e.stdout || '') + (e.stderr || '') + '\n' + (e.message || '')).trim(), command: cmd };
  }
}
