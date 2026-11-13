import { NextRequest } from 'next/server';
import { runMultiAgent, WorkerEvent } from '@/lib/multiAgent';

export async function POST(req: NextRequest) {
  const { request } = await req.json();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return Response.json({ error: 'No API key' }, { status: 500 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: WorkerEvent) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch {}
      };
      try {
        await runMultiAgent(String(request || ''), apiKey, emit);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown';
        emit({ type: 'orchestrator_done', orchestratorId: 2, ok: false, message: msg });
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
