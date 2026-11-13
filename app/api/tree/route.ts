import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const WORKSPACE = process.cwd();
const IGNORE = ['node_modules', '.git', '.next', '.agent_backups', 'dist', 'build', '.env'];

async function walk(dir: string, base: string): Promise<any[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const result = [];
  
  for (const entry of entries) {
    if (IGNORE.includes(entry.name)) continue;
    
    const relPath = path.relative(base, path.join(dir, entry.name));
    
    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        path: relPath,
        type: 'dir',
        children: await walk(path.join(dir, entry.name), base),
      });
    } else {
      result.push({
        name: entry.name,
        path: relPath,
        type: 'file',
      });
    }
  }
  
  // Folders first, then files
  return result.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'dir' ? -1 : 1;
  });
}

export async function GET() {
  try {
    const tree = await walk(WORKSPACE, WORKSPACE);
    return NextResponse.json({ tree });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
