import { NextRequest } from 'next/server';
import { listSessions, saveSession } from '@/lib/chatHistory';
import { errorMessage } from '@/types';


export async function GET() {
  const sessions = await listSessions();
  console.log('[GET /api/history] returning', sessions.length, 'sessions');
  return Response.json({ sessions });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.id) return Response.json({ error: 'id required' }, { status: 400 });
    const now = Date.now();
    await saveSession({
      id: body.id,
      title: body.title || 'Untitled',
      messages: Array.isArray(body.messages) ? body.messages : [],
      createdAt: now,
      updatedAt: now,
    });
    return Response.json({ ok: true });
  } catch (e: unknown) {
    console.error('[POST /api/history]', e);
    return Response.json({ error: errorMessage(e) }, { status: 500 });
  }
}
