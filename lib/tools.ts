import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { diffLines } from 'diff';

const execAsync = promisify(exec);
const WORKSPACE = process.cwd();
const USER_DOCS = path.join(process.env.HOME || '/home/chau', 'Documents');
const BACKUP_DIR = path.join(WORKSPACE, '.agent_backups');
const IGNORE_DIRS = ['node_modules', '.git', '.next', '.agent_backups', '.agent_chats', 'dist', 'build', 'coverage'];

export const toolSchemas = [
  { type: 'function', function: { name: 'scan_project', description: 'Get full project structure + package.json + tsconfig summary. ALWAYS call this FIRST before any change to understand the codebase.', parameters: { type: 'object', properties: { max_depth: { type: 'number', description: 'Max folder depth (default 3)' } } } } },
  { type: 'function', function: { name: 'grep_search', description: 'Search for a text pattern across project files.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, file_glob: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'update_plan', description: 'Create a checklist of steps for complex tasks.', parameters: { type: 'object', properties: { plan: { type: 'array', items: { type: 'string' } } }, required: ['plan'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create a NEW file only. BLOCKED if file already exists — use edit_file instead.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Surgical string replace in existing file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'bash', description: 'Run a READ-ONLY bash command (or background process).', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'check_build', description: 'Run npm run build to verify.', parameters: { type: 'object', properties: {} } } },
];

const HARD_BLOCK = ['rm -rf /', ':(){', '> /dev/sd', 'mkfs', 'dd if=/dev/zero', 'shutdown', 'reboot'];
const READONLY_GIT = ['status', 'diff', 'log', 'show', 'branch', 'remote', 'config', 'rev-parse', 'ls-files', 'blame'];
const SAFE_PREFIXES = ['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'pwd', 'which', 'file', 'stat', 'du', 'df', 'tree', 'echo', 'node', 'npm', 'npx', 'cargo', 'rustc', 'git', 'nohup', 'xdg-open'];

function isShellWrite(cmd: string): { isWrite: boolean; reason?: string } {
  // Allow background redirection to /tmp
  if (cmd.includes('> /tmp/') || cmd.includes('>> /tmp/')) return { isWrite: false };
  
  const commands = cmd.split(/&&|\|\||;/);
  for (const c of commands) {
    const trimmed = c.trim();
    if (!trimmed) continue;
    const redirectMatch = trimmed.match(/(?<![0-9&])>(?!>)\s*([^\s]+)/);
    if (redirectMatch) {
      const target = redirectMatch[1];
      if (!target.startsWith('/dev/null') && !target.startsWith('/dev/zero') && !target.startsWith('/tmp/') && !target.startsWith('&')) {
        return { isWrite: true, reason: `output redirection (> ${target})` };
      }
    }
    if (/>>\s*[^\s&]/.test(trimmed) && !trimmed.includes('/dev/null') && !trimmed.includes('/tmp/')) return { isWrite: true, reason: 'append redirection (>>)' };
    if (/\b(sed|perl|ruby|awk)\s+(-\S*i|--in-place)/.test(trimmed)) return { isWrite: true, reason: 'in-place editor' };
    if (/(^|\s)(tee|truncate)\s/.test(trimmed)) return { isWrite: true, reason: 'tee/truncate' };
    if (/^\s*(rm|mv|cp|ln|chmod|chown|chgrp|shred|dd|unlink)\s/.test(trimmed)) return { isWrite: true, reason: 'destructive file command' };
    if (/^\s*(touch|mkdir|rmdir)\s/.test(trimmed)) return { isWrite: true, reason: 'file creation' };
  }
  return { isWrite: false };
}

export function needsApproval(name: string, args: any): { need: boolean; reason?: string; blocked?: boolean } {
  if (name === 'read_file' || name === 'update_plan' || name === 'check_build' || name === 'scan_project' || name === 'grep_search') return { need: false };
  if (name === 'write_file' || name === 'edit_file') return { need: true, reason: 'File modification' };
  if (name === 'bash') {
    const cmd = String(args.command || '');
    if (HARD_BLOCK.some((d) => cmd.includes(d))) return { need: false, blocked: true, reason: 'catastrophic command' };
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

// ═══════════════════════════════════════════
// NAYA: Path restriction हटाइयो (Documents भित्र जहाँ पनि काम गर्न दिने)
// ═══════════════════════════════════════════
function resolveSafe(p: string): string {
  const full = path.resolve(p);
  const isInsideAgent = full.startsWith(WORKSPACE);
  const isInsideDocs = full.startsWith(USER_DOCS);

  if (!isInsideAgent && !isInsideDocs) {
    throw new Error('Path outside allowed workspace (Documents folder)');
  }

  // Only protect config files inside coding-agent itself
  if (isInsideAgent) {
    if (p.includes('AGENT_RULES.md') || p.includes('.env') || p.includes('.git/')) {
      throw new Error('Protected file (agent core)');
    }
  }
  return full;
}

export async function loadRules(): Promise<string> {
  try { return await fs.readFile(path.join(WORKSPACE, 'AGENT_RULES.md'), 'utf-8'); } catch { return "No specific rules."; }
}

export async function loadMemory(): Promise<string> {
  try { return await fs.readFile(path.join(WORKSPACE, '.agent_memory.md'), 'utf-8'); } catch { return "No memory yet."; }
}

export async function getPreviewDiff(name: string, args: any): Promise<string | null> {
  if (name !== 'write_file' && name !== 'edit_file') return null;
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
    await fs.rename(tmpPath, fullPath);
  } catch (e: any) {
    await fs.unlink(tmpPath).catch(() => {});
    throw new Error(`SAFETY: Write failed.\n\n${e.message}`);
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
      } else {
        out += `${indent}${e.name}\n`;
      }
    }
  } catch {}
  return out;
}

async function scanProject(maxDepth: number): Promise<string> {
  let result = '=== PROJECT STRUCTURE ===\n';
  result += await walkTree(WORKSPACE, WORKSPACE, 0, maxDepth);
  return result.slice(0, 12000);
}

export type ToolResult = { name: string; args: any; result: string };

export async function executeTool(name: string, args: any, onOutput?: (chunk: string) => void): Promise<ToolResult> {
  let result = '';
  try {
    if (name === 'scan_project') {
      result = await scanProject(args.max_depth || 3);
    } else if (name === 'grep_search') {
      const pattern = String(args.pattern || '');
      onOutput?.(`🔍 Searching: ${args.pattern}\n`);
      const out = await runBashStreaming(`grep -rn --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git -E "${pattern}" . 2>/dev/null | head -50`);
      result = out;
    } else if (name === 'update_plan') {
      result = 'Plan updated.';
    } else if (name === 'read_file') {
      const full = resolveSafe(String(args.path || ''));
      onOutput?.(`📖 Reading ${args.path}...\n`);
      const content = await fs.readFile(full, 'utf-8');
      result = content.length > 20000 ? content.slice(0, 20000) + '\n...(truncated)' : content;
    } else if (name === 'write_file') {
      const full = resolveSafe(String(args.path || ''));
      if (await fileExists(full)) throw new Error(`⛔ REWRITE BLOCKED: ${args.path} already exists. Use edit_file.`);
      onOutput?.(`📝 Creating NEW file ${args.path}...\n`);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await verifyAndSave(full, String(args.content ?? ''));
      result = `✅ Created NEW file ${args.path}.`;
    } else if (name === 'edit_file') {
      const full = resolveSafe(String(args.path || ''));
      if (!(await fileExists(full))) throw new Error(`File ${args.path} does not exist. Use write_file.`);
      onOutput?.(`✏️ Editing ${args.path}...\n`);
      await backupFile(full);
      const original = await fs.readFile(full, 'utf-8');
      const oldStr = String(args.old_string ?? '');
      const newStr = String(args.new_string ?? '');
      if (!oldStr) result = 'Error: old_string is empty';
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
