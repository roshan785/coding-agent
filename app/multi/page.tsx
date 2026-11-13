'use client';

import { useState, useRef } from 'react';

type Subtask = { id: string; title: string; description: string; files_hint?: string[]; priority: number };
type WorkerState = { id: number; status: 'idle' | 'waiting' | 'running' | 'done' | 'failed'; title?: string; lastAction?: string; summary?: string };
type OrchestratorState = { id: number; name: string; status: 'idle' | 'running' | 'done' | 'failed'; message?: string };

const INITIAL_WORKERS: WorkerState[] = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, status: 'idle' }));

export default function MultiPage() {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [plan, setPlan] = useState<Subtask[]>([]);
  const [workers, setWorkers] = useState<WorkerState[]>(INITIAL_WORKERS);
  const [orchestrators, setOrchestrators] = useState<OrchestratorState[]>([
    { id: 1, name: '🧠 Orchestrator 1 — Planner', status: 'idle' },
    { id: 2, name: '🔍 Orchestrator 2 — Reviewer', status: 'idle' },
  ]);
  const [log, setLog] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  function addLog(msg: string) { setLog((prev) => [...prev.slice(-80), `[${new Date().toLocaleTimeString()}] ${msg}`]); }

  async function run() {
    const req = input.trim(); if (!req || loading) return;
    setPlan([]); setWorkers(INITIAL_WORKERS); setLog([]);
    setOrchestrators([{ id: 1, name: '🧠 Orchestrator 1 — Planner', status: 'idle' }, { id: 2, name: '🔍 Orchestrator 2 — Reviewer', status: 'idle' }]);
    setInput(''); setLoading(true);
    const ac = new AbortController(); abortRef.current = ac;
    try {
      const res = await fetch('/api/multi-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request: req }), signal: ac.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += decoder.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue; const raw = line.slice(6).trim(); if (!raw) continue;
          let ev: any; try { ev = JSON.parse(raw); } catch { continue; }
          if (ev.type === 'orchestrator_start') {
            setOrchestrators((p) => p.map((o) => o.id === ev.orchestratorId ? { ...o, status: 'running', message: ev.message } : o));
            addLog(`Orchestrator ${ev.orchestratorId}: ${ev.message}`);
          } else if (ev.type === 'orchestrator_done') {
            setOrchestrators((p) => p.map((o) => o.id === ev.orchestratorId ? { ...o, status: ev.ok ? 'done' : 'failed', message: ev.message } : o));
            addLog(`Orchestrator ${ev.orchestratorId} done: ${ev.message}`);
          } else if (ev.type === 'plan_ready') {
            setPlan(ev.subtasks);
            setWorkers(INITIAL_WORKERS.map((w) => { const sub = ev.subtasks[w.id - 1]; return sub ? { ...w, status: 'waiting' as const, title: sub.title } : w; }));
            addLog(`Plan ready: ${ev.subtasks.length} subtasks`);
          } else if (ev.type === 'worker_start') {
            setWorkers((p) => p.map((w) => w.id === ev.workerId ? { ...w, status: 'running', title: ev.subtask?.title || w.title } : w));
            addLog(`Worker ${ev.workerId} started: ${ev.subtask?.title}`);
          } else if (ev.type === 'worker_step') {
            setWorkers((p) => p.map((w) => w.id === ev.workerId ? { ...w, lastAction: ev.message } : w));
          } else if (ev.type === 'worker_done') {
            setWorkers((p) => p.map((w) => w.id === ev.workerId ? { ...w, status: 'done', summary: ev.message } : w));
            addLog(`Worker ${ev.workerId} done`);
          } else if (ev.type === 'worker_error') {
            setWorkers((p) => p.map((w) => w.id === ev.workerId ? { ...w, status: 'failed', summary: ev.message } : w));
            addLog(`Worker ${ev.workerId} failed: ${ev.message}`);
          }
        }
      }
    } catch (e: any) { if (e.name !== 'AbortError') addLog(`ERROR: ${e.message}`); }
    finally { setLoading(false); abortRef.current = null; }
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <header className="max-w-6xl mx-auto mb-6 flex items-center gap-3">
        <h1 className="text-xl font-bold">🤖 Multi-Agent Orchestrator</h1>
        <span className="text-xs text-zinc-500">2 Orchestrators · 10 Workers · Concurrency 5</span>
        <a href="/" className="ml-auto text-xs text-blue-400 hover:underline">← Back to chat</a>
      </header>
      <div className="max-w-6xl mx-auto mb-6 bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder="Describe the task..." rows={3} className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 resize-none" />
        <div className="flex items-center gap-2 mt-2">
          <div className="ml-auto flex gap-2">
            {loading && <button onClick={() => abortRef.current?.abort()} className="bg-red-600 hover:bg-red-500 px-4 py-1.5 rounded-lg text-sm">⏹ Stop</button>}
            <button onClick={run} disabled={loading || !input.trim()} className="bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 px-6 py-1.5 rounded-lg text-sm font-medium">{loading ? 'Running…' : '▶ Run Multi-Agent'}</button>
          </div>
        </div>
      </div>
      <div className="max-w-6xl mx-auto mb-6 grid grid-cols-1 md:grid-cols-2 gap-3">
        {orchestrators.map((o) => (
          <div key={o.id} className={`rounded-xl border p-4 ${o.status === 'running' ? 'bg-amber-950/30 border-amber-800' : o.status === 'done' ? 'bg-emerald-950/30 border-emerald-800' : o.status === 'failed' ? 'bg-red-950/30 border-red-800' : 'bg-zinc-900 border-zinc-800'}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-lg">{o.status === 'running' ? '⏳' : o.status === 'done' ? '✅' : o.status === 'failed' ? '❌' : '💤'}</span>
              <h3 className="font-semibold text-sm">{o.name}</h3>
              <span className="ml-auto text-[10px] uppercase text-zinc-500">{o.status}</span>
            </div>
            {o.message && <div className="text-xs text-zinc-400 mt-1">{o.message}</div>}
          </div>
        ))}
      </div>
      {plan.length > 0 && (
        <div className="max-w-6xl mx-auto mb-6 bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold mb-3">📋 Plan ({plan.length} subtasks)</h3>
          <div className="space-y-2">
            {plan.map((t, i) => (
              <div key={t.id} className="flex items-start gap-2 text-sm">
                <span className="text-zinc-500 text-xs mt-0.5">{i + 1}.</span>
                <div className="flex-1">
                  <div className="text-zinc-200">{t.title}</div>
                  <div className="text-xs text-zinc-500">{t.description}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="max-w-6xl mx-auto mb-6">
        <h3 className="text-sm font-semibold mb-3">👷 Workers</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
          {workers.map((w) => (
            <div key={w.id} className={`rounded-lg border p-3 text-xs ${w.status === 'running' ? 'bg-amber-950/30 border-amber-700 animate-pulse' : w.status === 'done' ? 'bg-emerald-950/30 border-emerald-700' : w.status === 'failed' ? 'bg-red-950/30 border-red-700' : w.status === 'waiting' ? 'bg-zinc-900 border-zinc-700' : 'bg-zinc-900 border-zinc-800 opacity-60'}`}>
              <div className="flex items-center gap-1.5 mb-1">
                <span>{w.status === 'running' ? '⚡' : w.status === 'done' ? '✅' : w.status === 'failed' ? '❌' : w.status === 'waiting' ? '⏸' : '💤'}</span>
                <span className="font-mono font-bold">W{w.id}</span>
                <span className="ml-auto text-[9px] uppercase text-zinc-500">{w.status}</span>
              </div>
              {w.title && <div className="text-zinc-300 text-[11px] mb-1 line-clamp-2">{w.title}</div>}
              {w.lastAction && w.status === 'running' && <div className="text-[10px] text-amber-400/80 font-mono truncate">{w.lastAction}</div>}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
