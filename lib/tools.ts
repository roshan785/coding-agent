import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { diffLines } from 'diff';

const execAsync = promisify(exec);
const WORKSPACE = process.cwd();
const BACKUP_DIR = path.join(WORKSPACE, '.agent_backups');

export const toolSchemas = [
  { type: 'function', function: { name: 'update_memory', description: 'Save project context.', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } } },
  { type: 'function', function: { name: 'update_plan', description: 'Create a checklist of steps.', parameters: { type: 'object', properties: { plan: { type: 'array', items: { type: 'string' } } }, required: ['plan'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write full content to a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Surgical replace in a file (PREFERRED).', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'bash', description: 'Run a bash command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'check_build', description: 'Run npm run build to verify.', parameters: { type: 'object', properties: {} } } },
];

const HARD_BLOCK = ['rm -rf /', ':(){', '> /dev/sd', 'mkfs', 'dd if=/dev/zero', 'shutdown', 'reboot'];
const READONLY_GIT = ['status', 'diff', 'log', 'show', 'branch', 'remote', 'config', 'rev-parse', 'ls-files', 'blame'];
const SAFE_PREFIXES = ['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'pwd', 'which', 'file', 'stat', 'du', 'df', 'tree', 'echo', 'node', 'npm', 'npx', 'cargo', 'rustc', 'git'];

function isShellWrite(cmd: string): { isWrite: boolean; reason?: string } {
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
  if (name === 'read_file' || name === 'update_plan' || name === 'update_memory' || name === 'check_build') return { need: false };
  
  // No more config protection. Agent can edit everything.
  if (name === 'write_file' || name === 'edit_file') return { need: true, reason: 'File modification' };

  if (name === 'bash') {
    const cmd = String(args.command || '');
    if (HARD_BLOCK.some((d) => cmd.includes(d))) return { need: false, blocked: true, reason: 'catastrophic command' };
    const writeCheck = isShellWrite(cmd);
    if (writeCheck.isWrite) return { need: false, blocked: true, reason: `⛔ ${writeCheck.reason} FORBIDDEN. Use write_file or edit_file.` };
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
  const full = path.resolve(WORKSPACE, p);
  if (!full.startsWith(WORKSPACE)) throw new Error('Path outside workspace');
  if (p.includes('AGENT_RULES.md') || p.includes('.env') || p.includes('.git/')) throw new Error('Protected file');
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

async function verifyAndSave(fullPath: string, newContent: string) {
  const fileName = path.basename(fullPath);
  let oldContent = '';
  let exists = false;
  try { oldContent = await fs.readFile(fullPath, 'utf-8'); exists = true; } catch {}

  if (!newContent || newContent.trim().length < 50) throw new Error(`SAFETY: ${fileName} too short (${newContent.length} bytes)`);

  const MIN_SIZES: Record<string, number> = { 'page.tsx': 2000, 'layout.tsx': 300, 'route.ts': 500, 'tools.ts': 3000 };
  for (const [key, minSize] of Object.entries(MIN_SIZES)) {
    if (fileName === key && newContent.length < minSize) throw new Error(`SAFETY: ${fileName} too small (${newContent.length} < ${minSize})`);
  }

  if (exists && oldContent.length > 500) {
    const shrinkRatio = newContent.length / oldContent.length;
    if (shrinkRatio < 0.4) throw new Error(`SAFETY: ${fileName} shrank to ${Math.round(shrinkRatio * 100)}% — use edit_file`);
  }

  const criticalMarkers: Record<string, string[]> = {
    'page.tsx': ['export default function', "'use client'"],
    'layout.tsx': ['export default function'],
    'route.ts': ['export async function POST'],
  };
  for (const [key, markers] of Object.entries(criticalMarkers)) {
    if (fileName === key) {
      for (const marker of markers) {
        if (oldContent.includes(marker) && !newContent.includes(marker)) throw new Error(`SAFETY: ${fileName} missing '${marker}'`);
      }
    }
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
    const errOutput = ((e.stdout || '') + (e.stderr || '') + '\n' + (e.message || '')).trim();
    throw new Error(`SAFETY: TypeScript failed.\n\n${errOutput}`);
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
      if (onOutput) {
        const cleaned = cleanOutput(s);
        if (cleaned) onOutput(cleaned);
      }
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);

    const timer = setTimeout(() => {
      if (!killed) { killed = true; killReason = 'timeout'; child.kill('SIGKILL'); }
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const suffix = killed ? ` (${killReason})` : '';
      resolve(`exit: ${code}${suffix}\n\n${cleanOutput(output).slice(0, 15000)}`);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`Error: ${err.message}`);
    });
  });
}

export type ToolResult = { name: string; args: any; result: string };

export async function executeTool(
  name: string,
  args: any,
  onOutput?: (chunk: string) => void
): Promise<ToolResult> {
  let result = '';
  try {
    if (name === 'update_memory') {
      await fs.appendFile(path.join(WORKSPACE, '.agent_memory.md'), `\n\n## Memory (${new Date().toLocaleDateString()})\n${args.content}`, 'utf-8');
      result = 'Memory saved.';
    } else if (name === 'update_plan') {
      result = 'Plan updated.';
    } else if (name === 'read_file') {
      const full = resolveSafe(String(args.path || ''));
      onOutput?.(`📖 Reading ${args.path}...\n`);
      const content = await fs.readFile(full, 'utf-8');
      result = content.length > 20000 ? content.slice(0, 20000) + '\n...(truncated)' : content;
    } else if (name === 'write_file') {
      const full = resolveSafe(String(args.path || ''));
      onOutput?.(`📝 Writing ${args.content?.length || 0} bytes to ${args.path}...\n`);
      await backupFile(full);
      await fs.mkdir(path.dirname(full), { recursive: true });
      onOutput?.(`⏳ TypeScript check...\n`);
      await verifyAndSave(full, String(args.content ?? ''));
      result = `✅ Wrote ${args.path} (${args.content?.length} bytes).`;
    } else if (name === 'edit_file') {
      const full = resolveSafe(String(args.path || ''));
      onOutput?.(`✏️ Editing ${args.path}...\n`);
      await backupFile(full);
      const original = await fs.readFile(full, 'utf-8');
      const oldStr = String(args.old_string ?? '');
      const newStr = String(args.new_string ?? '');
      if (!oldStr) result = 'Error: old_string is empty';
      else {
        const count = original.split(oldStr).length - 1;
        if (count === 0) result = 'Error: old_string not found. Read the file first.';
        else if (count > 1) result = `Error: old_string appears ${count} times — must be unique.`;
        else {
          onOutput?.(`⏳ TypeScript check...\n`);
          await verifyAndSave(full, original.replace(oldStr, newStr));
          result = `✅ Edited ${args.path}.`;
        }
      }
    } else if (name === 'bash') {
      const cmd = String(args.command || '');
      if (HARD_BLOCK.some((d) => cmd.includes(d))) result = 'Blocked: catastrophic command';
      else {
        onOutput?.(`$ ${cmd}\n\n`);
        result = await runBashStreaming(cmd, onOutput);
      }
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
