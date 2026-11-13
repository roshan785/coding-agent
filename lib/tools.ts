import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { diffLines } from 'diff';

const execAsync = promisify(exec);
const WORKSPACE = process.cwd();
const BACKUP_DIR = path.join(WORKSPACE, '.agent_backups');

export const toolSchemas = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file from the workspace (relative path).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write full content to a file. Overwrites existing. Use ONLY for NEW files or complete rewrites.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Surgically replace a unique string in a file. PREFERRED over write_file. old_string MUST appear exactly once.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'bash', description: 'Run a bash command in the project root.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
];

const HARD_BLOCK = ['rm -rf /', ':(){', '> /dev/', 'mkfs', 'dd if=/dev/zero', 'shutdown', 'reboot'];
const READONLY_BASH = ['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'pwd', 'echo', 'which', 'file', 'stat', 'du', 'df', 'tree', 'npm', 'npx', 'cargo', 'rustc'];
const READONLY_GIT = ['status', 'diff', 'log', 'show', 'branch', 'remote', 'config', 'rev-parse', 'ls-files'];

export function needsApproval(name: string, args: any): { need: boolean; reason?: string; blocked?: boolean } {
  if (name === 'read_file') return { need: false };
  if (name === 'write_file' || name === 'edit_file') return { need: true, reason: 'File modification' };
  if (name === 'bash') {
    const cmd = String(args.command || '');
    if (HARD_BLOCK.some((d) => cmd.includes(d))) return { need: false, blocked: true };
    const parts = cmd.trim().split(/\s+/);
    const first = parts[0] || '';
    if (first === 'git') {
      const sub = parts[1] || '';
      if (READONLY_GIT.includes(sub)) return { need: false };
      return { need: true, reason: `git ${sub}` };
    }
    if (READONLY_BASH.includes(first)) {
      if (cmd.includes('>') && !cmd.includes('>/dev/null')) return { need: true, reason: 'Shell redirection' };
      return { need: false };
    }
    return { need: true, reason: 'Shell command' };
  }
  return { need: true, reason: 'Unknown tool' };
}

function resolveSafe(p: string): string {
  const full = path.resolve(WORKSPACE, p);
  if (!full.startsWith(WORKSPACE)) throw new Error('Path outside workspace is not allowed');
  return full;
}

// === NAYA: Constitution (Rules) Loader ===
export async function loadRules(): Promise<string> {
  try {
    const rules = await fs.readFile(path.join(WORKSPACE, 'AGENT_RULES.md'), 'utf-8');
    return rules;
  } catch {
    return "No specific rules found. Follow general safety and best practices.";
  }
}

// === Diff & Backup ===
export async function getPreviewDiff(name: string, args: any): Promise<string | null> {
  if (name !== 'write_file' && name !== 'edit_file') return null;
  try {
    const full = resolveSafe(String(args.path || ''));
    let oldStr = '';
    try { oldStr = await fs.readFile(full, 'utf-8'); } catch {}

    let newStr = '';
    if (name === 'write_file') {
      newStr = String(args.content ?? '');
    } else {
      const oldToFind = String(args.old_string ?? '');
      if (!oldStr.includes(oldToFind)) return null;
      newStr = oldStr.replace(oldToFind, String(args.new_string ?? ''));
    }

    const changes = diffLines(oldStr, newStr);
    let diffStr = '';
    changes.forEach((part) => {
      const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
      part.value.split('\n').forEach((line) => {
        if (line) diffStr += prefix + line + '\n';
      });
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
    const backupPath = path.join(BACKUP_DIR, `${time}_${fileName}`);
    await fs.copyFile(fullPath, backupPath);
  } catch {}
}

export type ToolResult = { name: string; args: any; result: string };

export async function executeTool(name: string, args: any): Promise<ToolResult> {
  let result = '';
  try {
    if (name === 'read_file') {
      const full = resolveSafe(String(args.path || ''));
      const content = await fs.readFile(full, 'utf-8');
      result = content.length > 20000 ? content.slice(0, 20000) + '\n...(truncated)' : content;
    } else if (name === 'write_file') {
      const full = resolveSafe(String(args.path || ''));
      await backupFile(full);
      await fs.mkdir(path.dirname(full), { recursive: true });
      const content = String(args.content ?? '');
      await fs.writeFile(full, content, 'utf-8');
      result = `Wrote ${content.length} bytes to ${args.path}`;
    } else if (name === 'edit_file') {
      const full = resolveSafe(String(args.path || ''));
      await backupFile(full);
      const original = await fs.readFile(full, 'utf-8');
      const oldStr = String(args.old_string ?? '');
      const newStr = String(args.new_string ?? '');
      if (!oldStr) {
        result = 'Error: old_string is empty';
      } else {
        const count = original.split(oldStr).length - 1;
        if (count === 0) {
          result = 'Error: old_string not found. Read the file first with read_file and copy exact text.';
        } else if (count > 1) {
          result = `Error: old_string appears ${count} times — must be unique.`;
        } else {
          await fs.writeFile(full, original.replace(oldStr, newStr), 'utf-8');
          result = `Edited ${args.path} (replaced ${oldStr.length} → ${newStr.length} chars)`;
        }
      }
    } else if (name === 'bash') {
      const cmd = String(args.command || '');
      if (HARD_BLOCK.some((d) => cmd.includes(d))) {
        result = 'Blocked: dangerous command';
      } else {
        const { stdout, stderr } = await execAsync(cmd, { cwd: WORKSPACE, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
        result = `stdout:\n${(stdout || '').slice(0, 8000)}\nstderr:\n${(stderr || '').slice(0, 4000)}`;
      }
    } else {
      result = `Unknown tool: ${name}`;
    }
  } catch (e: any) {
    result = `Error: ${e.message}`;
  }
  return { name, args, result };
}

export async function runVerify(): Promise<{ ok: boolean; output: string; command: string }> {
  let cmd = '';
  try {
    const rc = JSON.parse(await fs.readFile(path.join(WORKSPACE, '.agentrc.json'), 'utf-8'));
    if (typeof rc.verify === 'string' && rc.verify.trim()) cmd = rc.verify.trim();
  } catch {}
  if (!cmd) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(WORKSPACE, 'package.json'), 'utf-8'));
      const hasTs = !!(pkg.devDependencies?.typescript || pkg.dependencies?.typescript);
      const hasTsconfig = await fs.access(path.join(WORKSPACE, 'tsconfig.json')).then(() => true).catch(() => false);
      if (hasTs || hasTsconfig) cmd = 'npx tsc --noEmit';
    } catch {}
  }
  if (!cmd) return { ok: true, output: 'No verification command detected. Skipped.', command: '(skipped)' };
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd: WORKSPACE, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
    const out = ((stdout || '') + (stderr || '')).trim();
    return { ok: true, output: out.slice(0, 4000) || 'No errors.', command: cmd };
  } catch (e: any) {
    const out = ((e.stdout || '') + (e.stderr || '') + '\n' + (e.message || '')).trim();
    return { ok: false, output: out.slice(0, 4000), command: cmd };
  }
}
