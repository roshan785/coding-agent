import { NextRequest } from 'next/server';
import { resolveApproval } from '@/lib/permissions';

export async function POST(req: NextRequest) {
  const { id, approved } = await req.json();
  const ok = resolveApproval(String(id || ''), !!approved);
  return Response.json({ ok });
}
