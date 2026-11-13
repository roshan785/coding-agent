import ChatClient from '@/components/ChatClient';

// Server Component — no 'use client' here.
// All interactivity (state, effects, event handlers, streaming) lives in
// components/ChatClient.tsx, which is the single client boundary for this route.
// Benefit: react-markdown / remark-gfm are no longer part of the server bundle,
// and Next.js can prerender this shell.
export default function Home() {
  return <ChatClient />;
}
