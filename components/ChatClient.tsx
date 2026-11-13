'use client';

import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatStreamEvent, errorMessage, errorName } from '@/types';

type Step =
  | { type: 'text'; content: string }
  | { type: 'tool'; name: string; args: Record<string, unknown>; result: string; running: boolean; liveOutput?: string }
  | { type: 'plan'; plan: string[] }
  | { type: 'verify'; ok: boolean; command: string; output: string }
  | { type: 'review'; ok: boolean; feedback: string };

type Msg = { role: 'user' | 'assistant'; content: string; steps?: Step[]; timestamp: number };
type SessionMeta = { id: string; title: string; updatedAt: number; messageCount: number };

type CodeElProps = { children?: React.ReactNode };

function MarkdownBody({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
        a: ({ children, href }) => (<a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline">{children}</a>),
        ul: ({ children }) => <ul className="list-disc pl-5 mb-2">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-5 mb-2">{children}</ol>,
        li: ({ children }) => <li>{children}</li>,
        pre: ({ children }) => {
          const codeEl = Array.isArray(children) ? children[0] : children;
          const codeText: string =
            codeEl && typeof codeEl === 'object' && 'props' in codeEl
              ? String((codeEl as { props?: CodeElProps }).props?.children ?? '')
              : '';
          return (
            <div className="my-2 rounded-lg overflow-hidden border border-zinc-800 bg-zinc-950">
              <pre className="p-3 overflow-x-auto text-xs"><code>{codeText}</code></pre>
            </div>
          );
        },
        code: ({ children, ...props }) => (<code className="bg-zinc-800 px-1 py-0.5 rounded text-[0.85em]" {...props}>{children}</code>),
      }}>{content}</ReactMarkdown>
  );
}

export default function ChatClient() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [savingStatus, setSavingStatus] = useState<string>('');

  const sessionIdRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    refreshSessions();
    const last = typeof window !== 'undefined' ? localStorage.getItem('lastSessionId') : null;
    if (last) loadChat(last);
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, loading]);

  async function refreshSessions() {
    try {
      const res = await fetch('/api/history', { cache: 'no-store' });
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch {}
  }

  async function loadChat(id: string) {
    if (loading) return;
    // Abort any in-flight stream so its `finally` persist cannot write the
    // previous conversation into the session we are about to load.
    abortRef.current?.abort();
    try {
      const res = await fetch(`/api/history/${id}`);
      const data = await res.json();
      if (data.session) {
        setMessages(data.session.messages || []);
        setCurrentSessionId(id);
        sessionIdRef.current = id;
        localStorage.setItem('lastSessionId', id);
      }
    } catch {}
  }

  function newChat() {
    if (loading) return;
    abortRef.current?.abort();
    setMessages([]);
    setCurrentSessionId(null);
    sessionIdRef.current = null;
    localStorage.removeItem('lastSessionId');
    setInput('');
  }

  // 🗑 DELETE - No confirmation, instant delete
  async function deleteChat(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    // Optimistically remove from UI immediately
    setSessions((prev) => prev.filter((s) => s.id !== id));
    // If deleting current chat, clear it
    if (sessionIdRef.current === id) {
      abortRef.current?.abort();
      setMessages([]);
      setCurrentSessionId(null);
      sessionIdRef.current = null;
      localStorage.removeItem('lastSessionId');
    }
    try {
      const res = await fetch(`/api/history/${id}`, { method: 'DELETE' });
      // fetch only rejects on network errors — a 4xx/5xx still resolves.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      // If delete failed, refresh to restore the true server state
      await refreshSessions();
    }
  }

  async function persistSession(msgs: Msg[]) {
    if (msgs.length === 0) return;
    setSavingStatus('saving...');
    try {
      let id = sessionIdRef.current;
      if (!id) {
        id = `chat_${Date.now()}`;
        sessionIdRef.current = id;
        setCurrentSessionId(id);
      }
      const firstUser = msgs.find((m) => m.role === 'user');
      const title = firstUser ? firstUser.content.slice(0, 60) : 'Chat';
      const cleanMsgs = msgs.map((m) => ({
        ...m,
        steps: m.steps?.map((s) => s.type === 'tool' ? { ...s, running: false, liveOutput: undefined } : s),
      }));
      await fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, title, messages: cleanMsgs }),
      });
      localStorage.setItem('lastSessionId', id);
      await refreshSessions();
      setSavingStatus('✓ saved');
      setTimeout(() => setSavingStatus(''), 1500);
    } catch {
      setSavingStatus('✗ save failed');
    }
  }

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading) return;
    const userMsg: Msg = { role: 'user', content, timestamp: Date.now() };
    const baseMessages = [...messages, userMsg];
    const assistantIdx = baseMessages.length;

    setMessages([...baseMessages, { role: 'assistant', content: '', steps: [], timestamp: Date.now() }]);
    setInput('');
    setLoading(true);

    const ac = new AbortController();
    abortRef.current = ac;
    let currentSteps: Step[] = [];
    let activeText: { type: 'text'; content: string } | null = null;

    const updateAssistant = () => {
      setMessages((prev) => {
        // Guard: if the array shrank (chat switched/deleted mid-stream) or the
        // target slot is missing, do not write — avoids spreading `undefined`.
        if (assistantIdx >= prev.length || !prev[assistantIdx]) return prev;
        const copy = [...prev];
        copy[assistantIdx] = { ...copy[assistantIdx], steps: currentSteps.map((s) => ({ ...s })) };
        return copy;
      });
    };

    const onEvent = (data: ChatStreamEvent) => {
      if (data.type === 'text') {
        if (!activeText) { activeText = { type: 'text', content: '' }; currentSteps.push(activeText); }
        activeText.content += data.chunk;
        updateAssistant();
      } else if (data.type === 'plan') {
        activeText = null;
        currentSteps.push({ type: 'plan', plan: data.plan });
        updateAssistant();
      } else if (data.type === 'tool_start') {
        activeText = null;
        currentSteps.push({ type: 'tool', name: data.name, args: data.args, result: '', running: true, liveOutput: '' });
        updateAssistant();
      } else if (data.type === 'tool_output') {
        for (let i = currentSteps.length - 1; i >= 0; i--) {
          const s = currentSteps[i];
          if (s.type === 'tool' && s.name === data.name && s.running) {
            s.liveOutput = (s.liveOutput || '') + data.chunk;
            break;
          }
        }
        updateAssistant();
      } else if (data.type === 'tool_result') {
        for (let i = currentSteps.length - 1; i >= 0; i--) {
          const s = currentSteps[i];
          if (s.type === 'tool' && s.name === data.name && s.running) {
            s.result = data.result; s.running = false; s.liveOutput = undefined; break;
          }
        }
        updateAssistant();
      } else if (data.type === 'verify') {
        currentSteps.push({ type: 'verify', ok: data.ok, command: data.command, output: data.output });
        updateAssistant();
      } else if (data.type === 'review_result') {
        currentSteps.push({ type: 'review', ok: data.ok, feedback: data.feedback });
        updateAssistant();
      }
    };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: baseMessages.map(({ role, content }) => ({ role, content })) }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim(); if (!raw) continue;
          try { onEvent(JSON.parse(raw)); } catch {}
        }
      }
    } catch (e: unknown) {
      if (errorName(e) === 'AbortError') currentSteps.push({ type: 'text', content: '_⏹ Stopped_' });
      else currentSteps.push({ type: 'text', content: `_⚠️ ${errorMessage(e)}_` });
      updateAssistant();
    } finally {
      setLoading(false);
      abortRef.current = null;
      const finalAssistant: Msg = { role: 'assistant', content: '', steps: currentSteps.map((s) => ({ ...s })), timestamp: Date.now() };
      await persistSession([...baseMessages, finalAssistant]);
    }
  }

  function stop() { abortRef.current?.abort(); }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Ignore Enter while an IME composition is active (Nepali/Chinese/etc.),
    // otherwise the message is sent mid-composition.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }
  function fmt(ts: number) { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }

  return (
    <main className="flex h-screen bg-zinc-950 text-zinc-100">
      {historyOpen && (
        <aside className="w-72 border-r border-zinc-800 flex flex-col bg-zinc-900/50 shrink-0">
          <div className="px-3 py-3 border-b border-zinc-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Chats ({sessions.length})</h2>
            <div className="flex items-center gap-2">
              <button onClick={() => refreshSessions()} className="text-zinc-500 hover:text-zinc-200 text-sm" title="Reload">↻</button>
              <button onClick={() => setHistoryOpen(false)} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none" title="Hide">×</button>
            </div>
          </div>
          <div className="p-3">
            <button onClick={newChat} disabled={loading} className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 text-sm font-medium px-3 py-2 rounded-lg">+ New Chat</button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
            {sessions.length === 0 && (
              <div className="text-xs text-zinc-500 px-2 py-4 text-center">No chats yet<br/><span className="text-[10px]">Send a message to start</span></div>
            )}
            {sessions.map((s) => (
              <div key={s.id} onClick={() => loadChat(s.id)}
                className={`group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer ${
                  currentSessionId === s.id ? 'bg-blue-600/20 border border-blue-600/40' : 'hover:bg-zinc-800 border border-transparent'
                }`}>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-zinc-100 truncate">{s.title}</div>
                  <div className="text-[10px] text-zinc-500 mt-0.5">{fmt(s.updatedAt)} · {s.messageCount} msg</div>
                </div>
                {/* 🗑 DELETE BUTTON - Always visible */}
                <button
                  onClick={(e) => deleteChat(s.id, e)}
                  className="shrink-0 text-zinc-600 hover:text-red-400 text-sm px-1.5 py-0.5 rounded hover:bg-red-500/10 transition"
                  title="Delete chat"
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        </aside>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <header className="border-b border-zinc-800 px-4 py-3 flex items-center gap-3 shrink-0">
          {!historyOpen && <button onClick={() => setHistoryOpen(true)} className="text-zinc-400 hover:text-zinc-100 text-lg">☰</button>}
          <div className={`w-2 h-2 rounded-full ${loading ? 'bg-amber-400 animate-pulse' : 'bg-green-500'}`} />
          <h1 className="font-semibold text-sm">Advanced Agent</h1>
          {savingStatus && <span className="text-[10px] text-zinc-500">{savingStatus}</span>}
          <a href="/multi" className="text-xs text-blue-400 hover:underline px-2">🤖 Multi-Agent</a>
          <span className="ml-auto text-xs text-zinc-500">{loading ? 'working…' : 'idle'}</span>
        </header>

        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
          {messages.length === 0 && (
            <div className="max-w-2xl mx-auto mt-16 text-center text-zinc-500 text-sm">
              Send a message to start. Chats are saved automatically.
            </div>
          )}
          <div className="max-w-5xl mx-auto space-y-6">
            {messages.map((m, i) => {
              if (m.role === 'user') {
                return (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm bg-blue-600 text-white whitespace-pre-wrap">{m.content}</div>
                  </div>
                );
              }
              return (
                <div key={i} className="flex flex-col gap-3">
                  {m.steps?.map((step, j) => {
                    if (step.type === 'text') {
                      if (!step.content.trim()) return null;
                      return <div key={j} className="max-w-[85%] w-full"><div className="rounded-2xl px-4 py-2.5 text-sm bg-zinc-900 border border-zinc-800"><MarkdownBody content={step.content} /></div></div>;
                    }
                    if (step.type === 'plan') {
                      return (
                        <div key={j} className="bg-zinc-900 border border-zinc-700 rounded-xl p-3 max-w-[85%]">
                          <div className="text-xs font-semibold mb-2">📋 Plan</div>
                          <ul className="space-y-1">{step.plan.map((s, k) => <li key={k} className="text-sm text-zinc-400">• {s}</li>)}</ul>
                        </div>
                      );
                    }
                    if (step.type === 'tool') {
                      const isBash = step.name === 'bash' || step.name === 'check_build';
                      const out = step.result || step.liveOutput || (step.running ? 'running…' : '');
                      const cmd = typeof step.args?.command === 'string' ? step.args.command : '';
                      return (
                        <details key={j} open={step.running || undefined} className={`text-[11px] font-mono rounded-lg border ${step.running ? 'bg-amber-950/20 border-amber-800' : 'bg-zinc-900 border-zinc-800'}`}>
                          <summary className="cursor-pointer px-2.5 py-1.5">
                            <span>{step.running ? '⚡' : '🔧'}</span> <b>{step.name}</b>{' '}
                            <span className="text-zinc-500">{isBash && cmd ? `$ ${cmd}` : JSON.stringify(step.args).slice(0, 80)}</span>
                          </summary>
                          <pre className="border-t border-zinc-800 px-2.5 py-2 max-h-72 overflow-y-auto whitespace-pre-wrap text-zinc-300">{out.slice(-12000)}</pre>
                        </details>
                      );
                    }
                    if (step.type === 'verify') {
                      return (
                        <details key={j} className={`text-[11px] font-mono rounded-lg border ${step.ok ? 'bg-emerald-950/40 border-emerald-800' : 'bg-red-950/40 border-red-800'}`}>
                          <summary className="cursor-pointer px-2.5 py-1.5">{step.ok ? '✅' : '❌'} {step.ok ? 'verify passed' : 'verify failed'} — {step.command}</summary>
                          <pre className="border-t px-2.5 py-1.5 whitespace-pre-wrap text-zinc-300 max-h-48 overflow-y-auto">{step.output}</pre>
                        </details>
                      );
                    }
                    if (step.type === 'review') {
                      return (
                        <details key={j} className={`text-[11px] font-mono rounded-lg border ${step.ok ? 'bg-blue-950/40 border-blue-800' : 'bg-orange-950/40 border-orange-800'}`}>
                          <summary className="cursor-pointer px-2.5 py-1.5">{step.ok ? '👀' : '⚠️'} {step.ok ? 'review passed' : 'review rejected'}</summary>
                          <pre className="border-t px-2.5 py-1.5 whitespace-pre-wrap text-zinc-300 max-h-48 overflow-y-auto">{step.feedback}</pre>
                        </details>
                      );
                    }
                    return null;
                  })}
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="border-t border-zinc-800 p-3 sm:p-4">
          <div className="max-w-5xl mx-auto flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Message the agent…"
              rows={1}
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:border-blue-500 min-h-[44px] max-h-[200px]"
            />
            {loading
              ? <button onClick={stop} className="bg-red-600 hover:bg-red-500 px-5 h-[44px] rounded-xl text-sm">Stop</button>
              : <button onClick={() => send()} disabled={!input.trim()} className="bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 px-5 h-[44px] rounded-xl text-sm">Send</button>}
          </div>
        </div>
      </div>
    </main>
  );
}
