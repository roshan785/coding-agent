import { NextRequest } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function POST(req: NextRequest) {
  const { action } = await req.json();
  try {
    if (action === 'undo') {
      // Reset to the previous commit
      await execAsync('git reset --hard HEAD~1', { cwd: process.cwd() });
      return Response.json({ ok: true, message: 'Reverted to previous checkpoint.' });
    } 
    return Response.json({ error: 'Invalid action' }, { status: 400 });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
