import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const WORKSPACE = process.cwd();

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get('path') || '';
  
  const full = path.resolve(WORKSPACE, filePath);
  if (!full.startsWith(WORKSPACE)) return Response.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const content = await fs.readFile(full, 'utf-8');
    return Response.json({ content: content.slice(0, 20000) });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
