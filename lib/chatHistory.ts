import fs from 'fs/promises';
import path from 'path';

const CHATS_DIR = path.join(process.cwd(), '.agent_chats');

export interface ChatSession {
  id: string;
  title: string;
  messages: unknown[];
  createdAt: number;
  updatedAt: number;
}

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

async function ensureDir() {
  try { await fs.mkdir(CHATS_DIR, { recursive: true }); } catch {}
}

export async function listSessions(): Promise<SessionMeta[]> {
  try {
    await ensureDir();
    const files = await fs.readdir(CHATS_DIR);
    const sessions: SessionMeta[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(CHATS_DIR, f), 'utf-8');
        const data = JSON.parse(raw) as ChatSession;
        sessions.push({
          id: data.id,
          title: data.title || 'Untitled',
          updatedAt: data.updatedAt,
          messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
        });
      } catch {}
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (e) {
    console.error('[listSessions]', e);
    return [];
  }
}

export async function saveSession(session: ChatSession): Promise<void> {
  await ensureDir();
  const file = path.join(CHATS_DIR, `${session.id}.json`);
  await fs.writeFile(file, JSON.stringify(session, null, 2), 'utf-8');
  console.log('[saveSession]', file);
}

export async function loadSession(id: string): Promise<ChatSession | null> {
  try {
    const raw = await fs.readFile(path.join(CHATS_DIR, `${id}.json`), 'utf-8');
    return JSON.parse(raw) as ChatSession;
  } catch { return null; }
}

export async function deleteSession(id: string): Promise<void> {
  try { await fs.unlink(path.join(CHATS_DIR, `${id}.json`)); } catch {}
}
