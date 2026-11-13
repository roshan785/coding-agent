import { NextRequest } from 'next/server';
import { loadSession, deleteSession } from '@/lib/chatHistory';


export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await loadSession(id);
  if (!session) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json({ session });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await deleteSession(id);
  return Response.json({ ok: true });
}
