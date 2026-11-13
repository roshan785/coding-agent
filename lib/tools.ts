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
  { type: 'function', function: { name: 'open_url', description: 'Open a URL or project name.', parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } } },
  { type: 'function', function: { name: 'scan_project', description: 'Get project structure.', parameters: { type: 'object', properties: { max_depth: { type: 'number' } } } } },
  { type: 'function', function: { name: 'grep_search', description: 'Search for a text pattern.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, file_glob: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'update_plan', description: 'Create a checklist of steps.', parameters: { type: 'object', properties: { plan: { type: 'array', items: { type: 'string' } } }, required: ['plan'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create a NEW file only.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Surgical replace. Use for NON-core files only.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'self_edit', description: 'SAFE surgical edit for CORE files. Snapshot + tsc validate + auto-rollback.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'self_rewrite', description: 'SAFE full rewrite for CORE files. Snapshot + tsc validate + auto-rollback.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'content', 'reason'] } } },
  { type: 'function', function: { name: 'verify_agent_health', description: 'Check if agent is alive after restart.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'bash', description: 'Run a READ-ONLY bash command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
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
      if (!target.startsWith('/dev/null') && !target.startsWith('/dev/zero') && !target.startsWith('/tmp/') && !target.startsWith('&')) return { isWrite: true, reason: `redirection` };
    }
    if (/>>\s*[^\s&]/.test(trimmed) && !trimmed.includes('/dev/null') && !trimmed.includes('/tmp/')) return { isWrite: true, reason: 'append' };
    if (/\b(sed|perl|ruby|awk)\s+(-\S*i|--in-place)/.test(trimmed)) return { isWrite: true, reason: 'in-place' };
    if (/(^|\s)(tee|truncate)\s/.test(trimmed)) return { isWrite: true, reason: 'tee' };
    if (/^\s*(rm|mv|cp|ln|chmod|chown|chgrp|shred|dd|unlink)\s/.test(trimmed)) return { isWrite: true, reason: 'destructive' };
    if (/^\s*(touch|mkdir|rmdir)\s/.test(trimmed)) return { isWrite: true, reason: 'creation' };
  }
  return { isWrite: false };
}

export function needsApproval(name: string, args: Record<string, unknown>): { need: boolean; reason?: string; blocked?: boolean } {
  if (['read_file', 'update_plan', 'check_build', 'scan_project', 'grep_search', 'open_url', 'verify_agent_health'].includes(name)) return { need: false };
  
  if (name === 'write_file' || name === 'edit_file' || name === 'self_edit' || name === 'self_rewrite') {
    const p = String(args.path || '');
    if ((name === 'edit_file' || name === 'write_file') && isCoreFile(p)) {
      return { need: false, blocked: true, reason: `⛔ ${p} is CORE. Use ${name === 'write_file' ? 'self_rewrite' : 'self_edit'}.` };
    }
    if (name === 'self_rewrite' && !isCoreFile(p)) {
      return { need: false, blocked: true, reason: `⛔ self_rewrite is for CORE only. Use write_file/edit_file.` };
    }
    return { need: true, reason: 'File modification' };
  }
  
  if (name === 'bash') {
    const cmd = String(args.command || '');
    if (HARD_BLOCK.some((d) => cmd.includes(d))) return { need: false, blocked: true, reason: 'catastrophic' };
    if (isShellWrite(cmd).isWrite) return { need: false, blocked: true, reason: `⛔ Shell write FORBIDDEN.` };
    const parts = cmd.trim().split(/\s+/);
    if (parts[0] === 'git') {
      if (READONLY_GIT.includes(parts[1] || '')) return { need: false };
      return { need: true, reason: `git ${parts[1]}` };
    }
    if (SAFE_PREFIXES.includes(parts[0])) return { need: false };
    return { need: true, reason: `command` };
  }
  return { need: true, reason: 'unknown' };
}

function resolveSafe(p: string): string {
  const full = path.resolve(p);
  const isInsideAgent = full.startsWith(WORKSPACE);
  const isInsideDocs = full.startsWith(USER_DOCS);
  if (!isInsideAgent && !isInsideDocs) throw new Error('Path outside allowed');
  if (isInsideAgent && (p.includes('AGENT_RULES.md') || p.includes('.env') || p.includes('.git/'))) throw new Error('Protected');
  return full;
}

export async function loadRules(): Promise<string> {
  try { return await fs.readFile(path.join(WORKSPACE, 'AGENT_RULES.md'), 'utf-8'); } catch { return "No rules."; }
}

export async function loadMemory(): Promise<string> {
  try { return await fs.readFile(path.join(WORKSPACE, '.agent_memory.md'), 'utf-8'); } catch { return "No memory."; }
}

export async function getPreviewDiff(name: string, args: Record<string, unknown>): Promise<string | null> {
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

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function verifyAndSave(fullPath: string, newContent: string) {
  const fileName = path.basename(fullPath);
  let oldContent = '';
  let exists = false;
  try { oldContent = await fs.readFile(fullPath, 'utf-8'); exists = true; } catch {}

  if (!newContent || newContent.trim().length < 10) throw new Error(`SAFETY: ${fileName} too short`);
  if (exists && oldContent.length > 500 && newContent.length / oldContent.length < 0.4) throw new Error(`SAFETY: ${fileName} shrank > 60%`);

  const tmpPath = fullPath + '.agent_tmp';
  await fs.writeFile(tmpPath, newContent, 'utf-8');
  try {
    if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) {
      await execAsync('npx tsc --noEmit', { cwd: WORKSPACE, timeout: 90000 });
    }
    await fs.rename(tmpPath, fullPath);
  } catch (e: unknown) {
    await fs.unlink(tmpPath).catch(() => {});
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = ((err.stdout || '') + (err.stderr || '') + (err.message || '')).trim().slice(0, 3000);
    throw new Error(`SAFETY: TypeScript failed.\n\n${out}`);
  }
}

// ═══════════════════════════════════════════════════════════
// 10/10 SELF-EDIT & SELF-REWRITE
// ═══════════════════════════════════════════════════════════
async function performSelfEdit(filePath: string, oldString: string, newString: string): Promise<string> {
  const full = path.resolve(WORKSPACE, filePath);
  const fileName = path.basename(filePath);
  if (!(await fileExists(full))) throw new Error(`${filePath} does not exist.`);

  const original = await fs.readFile(full, 'utf-8');

  // Snapshot
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.writeFile(path.join(SNAPSHOT_DIR, `${ts}_${fileName}`), original, 'utf-8');

  if (!oldString) throw new Error('old_string is empty');
  const count = original.split(oldString).length - 1;
  if (count === 0) throw new Error(`old_string not found in ${fileName}.`);
  if (count > 1) throw new Error(`old_string appears ${count} times in ${fileName}. Make it unique.`);

  const updated = original.replace(oldString, newString);

  // Critical markers (only 'export default function' for page.tsx, NOT 'use client')
  const MARKERS: Record<string, string[]> = {
    'page.tsx': ['export default function'],
    'route.ts': ['export async function POST'],
    'tools.ts': ['export async function executeTool'],
    'multiAgent.ts': ['export async function runMultiAgent'],
  };
  for (const [key, ms] of Object.entries(MARKERS)) {
    if (fileName === key) {
      for (const m of ms) {
        if (original.includes(m) && !updated.includes(m)) {
          throw new Error(`⛔ BLOCKED: Edit removes critical marker "${m}" from ${fileName}. Snapshot saved.`);
        }
      }
    }
  }

  await fs.writeFile(full, updated, 'utf-8');

  try {
    await execAsync('npx tsc --noEmit', { cwd: WORKSPACE, timeout: 90000 });
  } catch (e: unknown) {
    await fs.writeFile(full, original, 'utf-8');
    const err = e as { stdout?: string; stderr?: string };
    const out = ((err.stdout || '') + (err.stderr || '')).slice(0, 3000);
    throw new Error(`⛔ SELF-EDIT FAILED. Auto-reverted ${fileName}.\n\n${out}\n\n💡 Fix ALL errors in one edit, not one by one.`);
  }

  return `✅ Self-edited ${fileName} safely. Snapshot: ${ts}_${fileName}`;
}

async function performSelfRewrite(filePath: string, content: string, reason: string): Promise<string> {
  const full = path.resolve(WORKSPACE, filePath);
  const fileName = path.basename(filePath);
  if (!(await fileExists(full))) throw new Error(`${filePath} does not exist.`);
  if (!content || content.trim().length < 20) throw new Error('Content too short');

  const original = await fs.readFile(full, 'utf-8');
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.writeFile(path.join(SNAPSHOT_DIR, `${ts}_${fileName}`), original, 'utf-8');

  if (fileName === 'page.tsx' && !content.includes('export default function')) throw new Error('page.tsx must have "export default function"');
  if (fileName === 'route.ts' && !content.includes('export async function POST') && !content.includes('export async function GET')) throw new Error('route.ts must have POST or GET');

  await fs.writeFile(full, content, 'utf-8');

  try {
    await execAsync('npx tsc --noEmit', { cwd: WORKSPACE, timeout: 90000 });
  } catch (e: unknown) {
    await fs.writeFile(full, original, 'utf-8');
    const err = e as { stdout?: string; stderr?: string };
    const out = ((err.stdout || '') + (err.stderr || '')).slice(0, 3000);
    throw new Error(`⛔ SELF-REWRITE FAILED. Auto-reverted.\n\n${out}`);
  }

  return `✅ Self-rewrote ${fileName} (${reason}). Snapshot: ${ts}_${fileName}`;
}

async function verifyHealth(): Promise<string> {
  try {
    const { stdout } = await execAsync('curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000/', { timeout: 8000 });
    return ['200', '304', '301'].includes(stdout.trim()) ? `✅ Agent healthy (HTTP ${stdout.trim()})` : `⚠️ HTTP ${stdout.trim()}`;
  } catch { return `❌ Agent not responding`; }
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
      if (onOutput) { const c = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'); if (c) onOutput(c); }
    };
    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);
    const timer = setTimeout(() => { if (!killed) { killed = true; killReason = 'timeout'; child.kill('SIGKILL'); } }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(`exit: ${code} ${killed ? killReason : ''}\n\n${output.slice(0, 15000)}`);
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
    visible.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of visible) {
      const indent = '  '.repeat(depth);
      if (e.isDirectory()) { out += `${indent}${e.name}/\n`; out += await walkTree(path.join(dir, e.name), base, depth + 1, maxDepth); }
      else out += `${indent}${e.name}\n`;
    }
  } catch {}
  return out;
}

async function smartOpen(target: string, onOutput?: (s: string) => void): Promise<string> {
  const t = target.trim();
  if (t.startsWith('http://') || t.startsWith('https://')) {
    spawn('xdg-open', [t], { detached: true, stdio: 'ignore' }).unref();
    return `✅ Opened ${t}`;
  }
  if (/^localhost:\d+/.test(t) || /^127\.0\.0\.1:\d+/.test(t)) {
    spawn('xdg-open', [`http://${t}`], { detached: true, stdio: 'ignore' }).unref();
    return `✅ Opened http://${t}`;
  }
  const projectName = t.toLowerCase().replace(/\s+/g, '');
  let projectPath = '';
  try {
    const docs = await fs.readdir(USER_DOCS, { withFileTypes: true });
    const dirs = docs.filter((d) => d.isDirectory());
    const exact = dirs.find((d) => d.name.toLowerCase() === t.toLowerCase());
    if (exact) projectPath = path.join(USER_DOCS, exact.name);
    else {
      const fuzzy = dirs.find((d) => d.name.toLowerCase().includes(projectName));
      if (fuzzy) projectPath = path.join(USER_DOCS, fuzzy.name);
    }
  } catch {}
  if (!projectPath) throw new Error(`Project "${target}" not found`);

  let port = 3000;
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(projectPath, 'package.json'), 'utf-8'));
    const match = String(pkg.scripts?.dev || '').match(/(?:-p|--port)\s+(\d+)/);
    if (match) port = parseInt(match[1], 10);
  } catch {}

  try {
    const check = await execAsync(`curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:${port}`, { timeout: 5000 });
    if (!['200', '304', '301'].includes(check.stdout.trim())) throw new Error();
  } catch {
    spawn('bash', ['-c', `cd "${projectPath}" && nohup npm run dev > /tmp/${path.basename(projectPath)}.log 2>&1 &`], { detached: true, stdio: 'ignore' }).unref();
    let ready = false;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const c = await execAsync(`curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:${port}`, { timeout: 5000 });
        if (['200', '304', '301'].includes(c.stdout.trim())) { ready = true; break; }
      } catch {}
    }
    if (!ready) throw new Error(`Server didn't start on port ${port}`);
  }
  spawn('xdg-open', [`http://localhost:${port}`], { detached: true, stdio: 'ignore' }).unref();
  return `✅ Opened ${path.basename(projectPath)} at http://localhost:${port}`;
}

export type ToolResult = { name: string; args: Record<string, unknown>; result: string };

export async function executeTool(name: string, args: Record<string, unknown>, onOutput?: (chunk: string) => void): Promise<ToolResult> {
  let result = '';
  try {
    if (name === 'open_url') result = await smartOpen(String(args.target || args.url || ''), onOutput);
    else if (name === 'verify_agent_health') result = await verifyHealth();
    else if (name === 'self_edit') result = await performSelfEdit(String(args.path || ''), String(args.old_string || ''), String(args.new_string || ''));
    else if (name === 'self_rewrite') result = await performSelfRewrite(String(args.path || ''), String(args.content || ''), String(args.reason || 'user request'));
    else if (name === 'scan_project') result = '=== PROJECT ===\n' + await walkTree(WORKSPACE, WORKSPACE, 0, Number(args.max_depth) || 3);
    else if (name === 'grep_search') result = await runBashStreaming(`grep -rn --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git -E "${args.pattern}" . 2>/dev/null | head -50`);
    else if (name === 'update_plan') result = 'Plan updated.';
    else if (name === 'read_file') {
      const content = await fs.readFile(resolveSafe(String(args.path || '')), 'utf-8');
      result = content.length > 20000 ? content.slice(0, 20000) + '...(truncated)' : content;
    }
    else if (name === 'write_file') {
      const full = resolveSafe(String(args.path || ''));
      if (await fileExists(full)) throw new Error(`⛔ REWRITE BLOCKED: ${args.path} exists. Use edit_file/self_edit.`);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await verifyAndSave(full, String(args.content ?? ''));
      result = `✅ Created ${args.path}`;
    }
    else if (name === 'edit_file') {
      const full = resolveSafe(String(args.path || ''));
      if (!(await fileExists(full))) throw new Error(`File missing.`);
      const original = await fs.readFile(full, 'utf-8');
      const count = original.split(String(args.old_string)).length - 1;
      if (count === 0) result = 'Error: old_string not found.';
      else if (count > 1) result = `Error: old_string appears ${count} times.`;
      else {
        await verifyAndSave(full, original.replace(String(args.old_string), String(args.new_string)));
        result = `✅ Edited ${args.path}`;
      }
    }
    else if (name === 'bash') result = await runBashStreaming(String(args.command || ''), onOutput);
    else if (name === 'check_build') {
      const out = await runBashStreaming('NODE_ENV=production npm run build', onOutput, 180000);
      result = out.includes('exit: 0') ? `✅ BUILD SUCCESSFUL` : `❌ BUILD FAILED\n\n${out.slice(0, 8000)}`;
    }
  } catch (e: unknown) {
    result = `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
  return { name, args, result };
}

export async function runVerify(): Promise<{ ok: boolean; output: string; command: string }> {
  try {
    const { stdout, stderr } = await execAsync('npx tsc --noEmit', { cwd: WORKSPACE, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, output: ((stdout || '') + (stderr || '')).trim() || 'OK', command: 'tsc' };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: ((err.stdout || '') + (err.stderr || '') + (err.message || '')).trim(), command: 'tsc' };
  }
}
