'use client';

import { useState, useRef } from 'react';

type Subtask = { id: string; title: string; description: string; files_hint?: string[]; priority: number };
type WorkerState = {
  id: number;
  status: 'idle' | 'waiting' | 'running' | 'done' | 'failed' | 'recovering';
  title?: string;
  lastAction?: string;
  thoughts: string[];
  summary?: string;
  elapsedMs?: number;
};
type OrchestratorState = { id: number; name: string; status: 'idle' | 'running' | 'done' | 'failed'; message?: string };
type RawEvent = { ts: number; type: string; workerId?: number; data: unknown };

const INITIAL_WORKERS: WorkerState[] = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1, status: 'idle', thoughts: [],
}));

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
  const [rawEvents, setRawEvents] = useState<RawEvent[]>([]);
  const [debugMode, setDebugMode] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function addLog(msg: string) {
    setLog((prev) => [...prev.slice(-150), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }

  function recordEvent(ev: any) {
    setRawEvents((prev) => [...prev.slice(-300), { ts: Date.now(), type: ev.type, workerId: ev.workerId, data: ev }]);
  }

  async function run() {
    const req = input.trim(); if (!req || loading) return;

    setPlan([]); setWorkers(INITIAL_WORKERS); setLog([]); setRawEvents([]); setElapsed(0);
    setOrchestrators([
      { id: 1, name: '🧠 Orchestrator 1 — Planner', status: 'idle' },
      { id: 2, name: '🔍 Orchestrator 2 — Reviewer', status: 'idle' },
    ]);
    setInput(''); setLoading(true);

    // Start elapsed timer
    const start = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 100);

    const ac = new AbortController(); abortRef.current = ac;

    try {
      const res = await fetch('/api/multi-chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: req }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += decoder.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim(); if (!raw) continue;
          let ev: any; try { ev = JSON.parse(raw); } catch { continue; }

          recordEvent(ev);

          if (ev.type === 'orchestrator_start') {
            setOrchestrators((p) => p.map((o) => o.id === ev.orchestratorId ? { ...o, status: 'running', message: ev.message } : o));
            addLog(`Orch ${ev.orchestratorId}: ${ev.message}`);
          } else if (ev.type === 'orchestrator_done') {
            setOrchestrators((p) => p.map((o) => o.id === ev.orchestratorId ? { ...o, status: ev.ok ? 'done' : 'failed', message: ev.message } : o));
            addLog(`Orch ${ev.orchestratorId} ${ev.ok ? '✅' : '❌'}: ${ev.message}`);
          } else if (ev.type === 'plan_ready') {
            setPlan(ev.subtasks);
            setWorkers(INITIAL_WORKERS.map((w) => {
              const sub = ev.subtasks[w.id - 1];
              return sub ? { ...w, status: 'waiting' as const, title: sub.title } : w;
            }));
            addLog(`Plan: ${ev.subtasks.length} subtasks`);
          } else if (ev.type === 'worker_start') {
            setWorkers((p) => p.map((w) => w.id === ev.workerId ? { ...w, status: 'running', title: ev.subtask?.title || w.title } : w));
            addLog(`W${ev.workerId} ▶ ${ev.subtask?.title}`);
          } else if (ev.type === 'worker_thought') {
            setWorkers((p) => p.map((w) => w.id === ev.workerId ? { ...w, thoughts: [...w.thoughts.slice(-4), ev.message] } : w));
          } else if (ev.type === 'worker_step') {
            setWorkers((p) => p.map((w) => w.id === ev.workerId ? { ...w, lastAction: ev.message } : w));
          } else if (ev.type === 'worker_done') {
            setWorkers((p) => p.map((w) => w.id === ev.workerId ? { ...w, status: 'done', summary: ev.message, elapsedMs: ev.elapsedMs } : w));
            addLog(`W${ev.workerId} ✅ ${(ev.elapsedMs / 1000).toFixed(1)}s`);
          } else if (ev.type === 'worker_error') {
            setWorkers((p) => p.map((w) => w.id === ev.workerId ? { ...w, status: 'failed', summary: ev.message, elapsedMs: ev.elapsedMs } : w));
            addLog(`W${ev.workerId} ❌ ${(ev.message || '').slice(0, 60)}`);
          } else if (ev.type === 'recovery_start') {
            addLog(`🔁 ${ev.message}`);
          } else if (ev.type === 'recovery_worker_start') {
            setWorkers((p) => p.map((w) => w.id === ev.workerId ? { ...w, status: 'recovering' } : w));
            addLog(`🔁 W${ev.workerId} retry: ${ev.subtask?.title}`);
          } else if (ev.type === 'recovery_worker_done') {
            setWorkers((p) => p.map((w) => w.id === ev.workerId ? { ...w, status: ev.ok ? 'done' : 'failed', summary: ev.message } : w));
            addLog(`🔁 W${ev.workerId} ${ev.ok ? '✅ recovered' : '❌ still failed'}`);
          } else if (ev.type === 'blackboard') {
            addLog(`📋 ${ev.message}`);
          }
        }
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') addLog(`ERROR: ${e.message}`);
    } finally {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setLoading(false); abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }

  const doneCount = workers.filter((w) => w.status === 'done').length;
  const failedCount = workers.filter((w) => w.status === 'failed').length;
  const runningCount = workers.filter((w) => w.status === 'running' || w.status === 'recovering').length;

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-4 md:p-6">
      <header className="max-w-7xl mx-auto mb-4 flex items-center gap-3 flex-wrap">
        <h1 className="text-lg md:text-xl font-bold">🤖 Multi-Agent Orchestrator</h1>
        <span className="text-xs text-zinc-500">2 Orchestrators · 10 Workers · Concurrency 5</span>
        {loading && <span className="text-sm font-mono text-blue-400">⏱ {elapsed}s</span>}
        <button
          onClick={() => setDebugMode(!debugMode)}
          className={`text-xs px-3 py-1 rounded-md ${debugMode ? 'bg-amber-600 text-white' : 'bg-zinc-800 text-zinc-400'}`}
        >
          🐛 Debug {debugMode ? 'ON' : 'OFF'}
        </button>
        <a href="/" className="ml-auto text-xs text-blue-400 hover:underline">← Back to chat</a>
      </header>

      <div className="max-w-7xl mx-auto mb-4 bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Describe the task..."
          rows={3}
          className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 resize-none"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(); }}
        />
        <div className="flex items-center gap-2 mt-2">
          <span className="text-xs text-zinc-500">Ctrl+Enter to run</span>
          <div className="ml-auto flex gap-2">
            {loading && <button onClick={stop} className="bg-red-600 hover:bg-red-500 px-4 py-1.5 rounded-lg text-sm">⏹ Stop</button>}
            <button onClick={run} disabled={loading || !input.trim()} className="bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 px-6 py-1.5 rounded-lg text-sm font-medium">
              {loading ? 'Running…' : '▶ Run Multi-Agent'}
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto mb-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        {orchestrators.map((o) => (
          <div key={o.id} className={`rounded-xl border p-3 ${
            o.status === 'running' ? 'bg-amber-950/30 border-amber-800' :
            o.status === 'done' ? 'bg-emerald-950/30 border-emerald-800' :
            o.status === 'failed' ? 'bg-red-950/30 border-red-800' :
            'bg-zinc-900 border-zinc-800'
          }`}>
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
        <div className="max-w-7xl mx-auto mb-4 bg-zinc-900 border border-zinc-800 rounded-xl p-3">
          <h3 className="text-sm font-semibold mb-2">📋 Plan ({plan.length} subtasks)</h3>
          <div className="space-y-1.5">
            {plan.map((t, i) => (
              <div key={t.id} className="flex items-start gap-2 text-sm">
                <span className="text-zinc-500 text-xs mt-0.5">{i + 1}.</span>
                <div className="flex-1 min-w-0">
                  <div className="text-zinc-200 text-xs">{t.title}</div>
                  <div className="text-[10px] text-zinc-500 truncate">{t.description}</div>
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  t.priority === 1 ? 'bg-red-900/40 text-red-300' :
                  t.priority === 2 ? 'bg-amber-900/40 text-amber-300' :
                  'bg-zinc-800 text-zinc-400'
                }`}>P{t.priority}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto mb-4">
        <div className="flex items-center gap-3 mb-2">
          <h3 className="text-sm font-semibold">👷 Workers</h3>
          <span className="text-xs text-zinc-500">
            ⚡ {runningCount} · ✅ {doneCount} · ❌ {failedCount} · 🔒 max 5
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-2">
          {workers.map((w) => (
            <div key={w.id} className={`rounded-lg border p-2 text-xs ${
              w.status === 'running' ? 'bg-amber-950/30 border-amber-700' :
              w.status === 'recovering' ? 'bg-purple-950/30 border-purple-700' :
              w.status === 'done' ? 'bg-emerald-950/30 border-emerald-700' :
              w.status === 'failed' ? 'bg-red-950/30 border-red-700' :
              w.status === 'waiting' ? 'bg-zinc-900 border-zinc-700' :
              'bg-zinc-900 border-zinc-800 opacity-60'
            }`}>
              <div className="flex items-center gap-1.5 mb-1">
                <span>{w.status === 'running' ? '⚡' : w.status === 'recovering' ? '🔁' : w.status === 'done' ? '✅' : w.status === 'failed' ? '❌' : w.status === 'waiting' ? '⏸' : '💤'}</span>
                <span className="font-mono font-bold">W{w.id}</span>
                <span className="ml-auto text-[9px] uppercase text-zinc-500">{w.status}</span>
                {w.elapsedMs !== undefined && <span className="text-[9px] text-zinc-500">{(w.elapsedMs / 1000).toFixed(1)}s</span>}
              </div>
              {w.title && <div className="text-zinc-300 text-[11px] mb-1 line-clamp-2">{w.title}</div>}
              
              {/* 🆕 Show last thought */}
              {w.thoughts.length > 0 && (w.status === 'running' || w.status === 'recovering') && (
                <div className="text-[10px] text-blue-300/70 italic line-clamp-2 mb-1">
                  💭 {w.thoughts[w.thoughts.length - 1]}
                </div>
              )}
              
              {/* Show last tool action */}
              {w.lastAction && (w.status === 'running' || w.status === 'recovering') && (
                <div className="text-[10px] text-amber-400/80 font-mono truncate">🔧 {w.lastAction}</div>
              )}
              
              {/* Show failure reason */}
              {w.status === 'failed' && w.summary && (
                <div className="text-[10px] text-red-400 line-clamp-3 mt-1">❌ {w.summary.slice(0, 150)}</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {log.length > 0 && (
        <div className="max-w-7xl mx-auto mb-4 bg-zinc-900 border border-zinc-800 rounded-xl p-3">
          <h3 className="text-sm font-semibold mb-2">📜 Activity Log</h3>
          <div className="font-mono text-[10px] text-zinc-400 max-h-48 overflow-y-auto space-y-0.5">
            {log.map((line, i) => (<div key={i}>{line}</div>))}
          </div>
        </div>
      )}

      {/* 🆕 DEBUG PANEL */}
      {debugMode && rawEvents.length > 0 && (
        <div className="max-w-7xl mx-auto bg-amber-950/20 border border-amber-800 rounded-xl p-3">
          <h3 className="text-sm font-semibold mb-2 text-amber-300">🐛 Raw Events ({rawEvents.length})</h3>
          <div className="font-mono text-[10px] text-amber-200/70 max-h-64 overflow-y-auto space-y-0.5">
            {rawEvents.slice(-100).map((e, i) => (
              <div key={i} className="break-all">
                <span className="text-zinc-500">{new Date(e.ts).toLocaleTimeString()}</span>{' '}
                <span className="text-amber-400">{e.type}</span>
                {e.workerId && <span className="text-blue-400"> W{e.workerId}</span>}{' '}
                <span className="text-zinc-400">{JSON.stringify(e.data).slice(0, 200)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
