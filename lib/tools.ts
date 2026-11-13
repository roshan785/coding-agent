import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);
const WORKSPACE = process.cwd();

export const toolSchemas = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a file from the workspace. Path is relative to the project root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path, e.g. app/page.tsx' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a bash command in the project root. Use for ls, grep, cat, cargo check, npm test, git status, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Bash command' },
        },
        required: ['command'],
      },
    },
  },
];

const BLOCKED = [
  'rm -rf /',
  'sudo ',
  ':(){',
  '> /dev/',
  'mkfs',
  'dd if=/dev/zero',
  'shutdown',
  'reboot',
];

function resolveSafe(p: string): string {
  const full = path.resolve(WORKSPACE, p);
  if (!full.startsWith(WORKSPACE)) {
    throw new Error('Path outside workspace is not allowed');
  }
  return full;
}

export type ToolResult = { name: string; args: any; result: string };

export async function executeTool(
  name: string,
  args: any
): Promise<ToolResult> {
  let result = '';
  try {
    if (name === 'read_file') {
      const full = resolveSafe(String(args.path || ''));
      const content = await fs.readFile(full, 'utf-8');
      result =
        content.length > 20000
          ? content.slice(0, 20000) + '\n...(truncated)'
          : content;
    } else if (name === 'bash') {
      const cmd = String(args.command || '');
      if (BLOCKED.some((b) => cmd.includes(b))) {
        result = 'Blocked: dangerous command detected';
      } else {
        const { stdout, stderr } = await execAsync(cmd, {
          cwd: WORKSPACE,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        });
        const out = (stdout || '').slice(0, 8000);
        const err = (stderr || '').slice(0, 4000);
        result = `stdout:\n${out}\nstderr:\n${err}`;
      }
    } else {
      result = `Unknown tool: ${name}`;
    }
  } catch (e: any) {
    result = `Error: ${e.message}`;
  }
  return { name, args, result };
}
