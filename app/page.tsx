'use client';

import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type ToolCall = { name: string; args: any; result: string };
type Msg = {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  timestamp: number;
};

const EXAMPLES = [
  'app/page.tsx को पहिलो 5 line पढ',
  'यो project मा के-के file छन्, ls चलाएर भन',
  'node --version चलाऊ',
  'rm -rf / चलाऊ',
];

function MarkdownBody({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline">
            {children}
          </a>
        ),
        ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        h1: ({ children }) => <h1 className="text-lg font-bold mb-2 mt-3">{children}</h1>,
        h2: ({ children }) => <h2 className="text-base font-bold mb-2 mt-3">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-bold mb-1 mt-2">{children}</h3>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-zinc-700 pl-3 my-2 text-zinc-400 italic">
            {children}
          </blockquote>
        ),
        table: ({ children }) => (
          <div className="overflow-x-auto my-2">
            <table className="border-collapse border border-zinc-800 text-xs">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-zinc-800 px-2 py-1 bg-zinc-900 text-left">{children}</th>
        ),
        td: ({ children }) => <td className="border border-zinc-800 px-2 py-1">{children}</td>,
        hr: () => <hr className="border-zinc-800 my-3" />,
        pre: ({ children }: any) => {
          const codeEl = Array.isArray(children) ? children[0] : children;
          const codeText: string = codeEl?.props?.children ?? '';
          const lang: string =
            (codeEl?.props?.className?.match(/language-(\w+)/) || [])[1] || 'code';
          return (
            <div className="my-2 rounded-lg overflow-hidden border border-zinc-800 bg-zinc-950">
              <div className="flex items-center justify-between text-[10px] text-zinc-500 px-3 py-1 border-b border-zinc-800 bg-zinc-900">
                <span>{lang}</span>
                <button
                  onClick={(e) => {
                    navigator.clipboard.writeText(String(codeText));
                    const b = e.currentTarget;
                    b.textContent = 'copied!';
                    setTimeout(() => (b.textContent = 'copy'), 1200);
                  }}
                  className="hover:text-zinc-200 transition"
                >
                  copy
                </button>
              </div>
              <pre className="p-3 overflow-x-auto text-xs">
                <code className="text-zinc-100">{codeText}</code>
              </pre>
            </div>
          );
        },
        code: ({ children, ...props }: any) => (
          <code className="bg-zinc-800 text-zinc-100 px-1 py-0.5 rounded text-[0.85em]" {...props}>
            {children}
          </code>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [input]);

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading) return;

    const userMsg: Msg = { role: 'user', content, timestamp: Date.now() };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setLoading(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: next.map(({ role, content }) => ({ role, content })),
        }),
        signal: ac.signal,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setMessages([
        ...next,
        {
          role: 'assistant',
          content: data.message.content,
          toolCalls: data.toolCalls || [],
          timestamp: Date.now(),
        },
      ]);
    } catch (e: any) {
      if (e.name === 'AbortError') {
        setMessages([
          ...next,
          { role: 'assistant', content: '_Stopped by user._', timestamp: Date.now() },
        ]);
      } else {
        setMessages([
          ...next,
          { role: 'assistant', content: `**Error:** ${e.message}`, timestamp: Date.now() },
        ]);
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  async function copy(idx: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    } catch {}
  }

  function fmtTime(ts: number) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return (
    <main className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center gap-3 shrink-0">
        <div
          className={`w-2 h-2 rounded-full ${
            loading ? 'bg-amber-400 animate-pulse' : 'bg-green-500'
          }`}
        />
        <h1 className="font-semibold text-sm">Coding Agent · DeepSeek</h1>
        <span className="ml-auto text-xs text-zinc-500">{loading ? 'working…' : 'idle'}</span>
      </header>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
        {messages.length === 0 && (
          <div className="max-w-2xl mx-auto mt-16 text-center">
            <div className="text-zinc-400 text-sm mb-4">Try one of these:</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => send(ex)}
                  className="text-left text-sm bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-lg px-3 py-2 transition"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="max-w-3xl mx-auto space-y-4">
          {messages.map((m, i) => (
            <div
              key={i}
              className={`group ${m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}`}
            >
              <div className={`max-w-[85%] ${m.role === 'user' ? '' : 'w-full'}`}>
                {m.toolCalls && m.toolCalls.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {m.toolCalls.map((tc, j) => (
                      <details
                        key={j}
                        className="text-[11px] font-mono bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden"
                      >
                        <summary className="cursor-pointer px-2.5 py-1.5 text-zinc-400 hover:bg-zinc-800/50 select-none">
                          <span className="text-amber-400">🔧</span>{' '}
                          <span className="text-zinc-200">{tc.name}</span>
                          <span className="text-zinc-500">
                            ({JSON.stringify(tc.args).slice(0, 80)}
                            {JSON.stringify(tc.args).length > 80 ? '…' : ''})
                          </span>
                        </summary>
                        <div className="border-t border-zinc-800 px-2.5 py-1.5">
                          <div className="text-zinc-500 mb-1">result:</div>
                          <pre className="whitespace-pre-wrap break-words text-zinc-300 max-h-48 overflow-y-auto">
                            {tc.result.slice(0, 2000)}
                            {tc.result.length > 2000 ? '\n…(truncated)' : ''}
                          </pre>
                        </div>
                      </details>
                    ))}
                  </div>
                )}

                <div
                  className={`rounded-2xl px-4 py-2.5 text-sm ${
                    m.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-zinc-900 border border-zinc-800 text-zinc-100'
                  }`}
                >
                  {m.role === 'user' ? (
                    <div className="whitespace-pre-wrap">{m.content}</div>
                  ) : (
                    <MarkdownBody content={m.content} />
                  )}
                </div>

                <div
                  className={`flex items-center gap-2 mt-1 text-[10px] text-zinc-500 ${
                    m.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  <span>{fmtTime(m.timestamp)}</span>
                  {m.role === 'assistant' && m.content && (
                    <button
                      onClick={() => copy(i, m.content)}
                      className="opacity-0 group-hover:opacity-100 transition"
                    >
                      {copiedIdx === i ? '✓ copied' : 'copy'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl px-4 py-2.5 text-sm text-zinc-400 flex items-center gap-2">
                <span className="flex gap-1">
                  <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </span>
                सोच्दैछ…
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-zinc-800 p-3 sm:p-4 shrink-0">
        <div className="max-w-3xl mx-auto">
          <div className="flex gap-2 items-end">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Message the agent… (Enter to send, Shift+Enter for newline)"
              rows={1}
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:border-blue-500 min-h-[44px] max-h-[200px]"
            />
            {loading ? (
              <button
                onClick={stop}
                className="bg-red-600 hover:bg-red-500 px-5 h-[44px] rounded-xl text-sm font-medium"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={() => send()}
                disabled={!input.trim()}
                className="bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:cursor-not-allowed px-5 h-[44px] rounded-xl text-sm font-medium"
              >
                Send
              </button>
            )}
          </div>
          <div className="text-[10px] text-zinc-600 mt-1.5 text-center">
            ⚠️ Agent ले तपाईंको project मा file पढ्न र command चलाउन सक्छ।
          </div>
        </div>
      </div>
    </main>
  );
}
