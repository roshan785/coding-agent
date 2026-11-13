import { executeTool, needsApproval, runVerify, loadRules, loadMemory, toolSchemas } from './tools';

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_WORKER_TURNS = 12;

export interface Subtask {
  id: string;
  title: string;
  description: string;
  files_hint?: string[];
  priority: number;
}

export type WorkerEvent = {
  type: 'orchestrator_start' | 'orchestrator_done' | 'plan_ready' | 'worker_start' | 'worker_step' | 'worker_done' | 'worker_error';
  orchestratorId?: number;
  workerId?: number;
  message?: string;
  ok?: boolean;
  subtask?: Subtask;
  subtasks?: Subtask[];
  tool?: string;
  args?: unknown;
};

class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];
  constructor(permits: number) { this.permits = permits; }
  async acquire(): Promise<void> {
    if (this.permits > 0) { this.permits--; return; }
    return new Promise((r) => this.waiting.push(r));
  }
  release(): void {
    this.permits++;
    const next = this.waiting.shift();
    if (next) { this.permits--; next(); }
  }
}

export async function runMultiAgent(
  userRequest: string,
  apiKey: string,
  emit: (event: WorkerEvent) => void
): Promise<{ plan: Subtask[]; results: Array<{ subtask: Subtask; ok: boolean; summary: string }> }> {
  const rules = await loadRules();
  const memory = await loadMemory();

  // ─── ORCHESTRATOR 1: PLAN ───
  emit({ type: 'orchestrator_start', orchestratorId: 1, message: 'Breaking task into subtasks...' });

  const plannerPrompt = `You are Orchestrator 1 (Planner). Break the user's request into 3-10 atomic subtasks that 10 workers can execute in parallel (max 5 concurrent).

CONSTITUTION: ${rules}

USER REQUEST: ${userRequest}

OUTPUT STRICT JSON:
{"subtasks":[{"id":"1","title":"short title","description":"what to do","files_hint":["path/to/file"],"priority":1}]}

RULES FOR SUBTASKS:
- 3-10 subtasks total
- Each is ATOMIC (one file, one feature, one fix)
- INDEPENDENT when possible (workers run concurrently — avoid 2 workers editing the same file)
- Priority 1 (critical) → 3 (nice to have)
- files_hint should list which files each subtask will touch
- If the request is small (< 3 subtasks worth), just make 1-2 subtasks`;

  let subtasks: Subtask[] = [];
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: plannerPrompt }], temperature: 0 }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    const content = data.choices[0].message.content as string;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      subtasks = (parsed.subtasks || []).slice(0, 10).map((t: any, i: number) => ({
        id: String(t.id || i + 1),
        title: String(t.title || `Task ${i + 1}`),
        description: String(t.description || ''),
        files_hint: Array.isArray(t.files_hint) ? t.files_hint : [],
        priority: Number(t.priority) || 2,
      }));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    emit({ type: 'orchestrator_done', orchestratorId: 1, ok: false, message: `Planner failed: ${msg}` });
    return { plan: [], results: [] };
  }

  if (subtasks.length === 0) {
    emit({ type: 'orchestrator_done', orchestratorId: 1, ok: false, message: 'No subtasks generated' });
    return { plan: [], results: [] };
  }

  emit({ type: 'plan_ready', subtasks });
  emit({ type: 'orchestrator_done', orchestratorId: 1, ok: true, message: `Planned ${subtasks.length} subtasks` });

  // ─── WORKER POOL (10 workers, concurrency 5) ───
  const semaphore = new Semaphore(5);
  const results: Array<{ subtask: Subtask; ok: boolean; summary: string }> = [];
  const tasks = subtasks.slice(0, 10);

  await Promise.all(tasks.map(async (subtask, idx) => {
    const workerId = idx + 1;
    await semaphore.acquire();
    try {
      emit({ type: 'worker_start', workerId, subtask, message: `Starting: ${subtask.title}` });
      const r = await runWorker(subtask, workerId, apiKey, rules, memory, emit);
      results.push({ subtask, ok: r.ok, summary: r.summary });
      emit({ type: r.ok ? 'worker_done' : 'worker_error', workerId, ok: r.ok, message: r.summary });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown';
      results.push({ subtask, ok: false, summary: msg });
      emit({ type: 'worker_error', workerId, ok: false, message: msg });
    } finally {
      semaphore.release();
    }
  }));

  // ─── ORCHESTRATOR 2: REVIEW ───
  emit({ type: 'orchestrator_start', orchestratorId: 2, message: 'Reviewing worker results...' });
  const okCount = results.filter((r) => r.ok).length;
  emit({
    type: 'orchestrator_done',
    orchestratorId: 2,
    ok: okCount === results.length,
    message: `${okCount}/${results.length} tasks succeeded`,
  });

  return { plan: subtasks, results };
}

async function runWorker(
  subtask: Subtask,
  workerId: number,
  apiKey: string,
  rules: string,
  memory: string,
  emit: (event: WorkerEvent) => void
): Promise<{ ok: boolean; summary: string }> {
  const systemPrompt = `You are Worker #${workerId}. Do ONLY your assigned subtask. Be fast and surgical.

ASSIGNED SUBTASK:
Title: ${subtask.title}
Description: ${subtask.description}
Files to touch: ${(subtask.files_hint || []).join(', ') || '(decide yourself)'}

CONSTITUTION (MUST follow):
${rules}

MEMORY:
${memory}

STRICT RULES:
1. Only touch files relevant to YOUR subtask. Other workers handle other files.
2. Use edit_file for existing files. Use write_file ONLY for brand-new files.
3. After any write, verify with tsc (system auto-runs this).
4. When finished, reply with "DONE: <summary>" or "FAILED: <reason>". Do not keep exploring.`;

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Execute: ${subtask.title}\n\n${subtask.description}` },
  ];

  for (let turn = 0; turn < MAX_WORKER_TURNS; turn++) {
    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages,
          tools: toolSchemas,
          tool_choice: 'auto',
          temperature: 0,
        }),
        signal: AbortSignal.timeout(120000),
      });
    } catch {
      return { ok: false, summary: 'API timeout' };
    }

    if (!res.ok) return { ok: false, summary: `API ${res.status}` };

    const data = await res.json();
    const msg = data.choices[0].message;
    const toolCalls = (msg.tool_calls || []) as Array<{ id: string; function: { name: string; arguments: string } }>;
    const content = (msg.content || '') as string;

    if (toolCalls.length === 0) {
      const ok = /DONE/i.test(content) && !/FAILED/i.test(content);
      return { ok, summary: content.slice(0, 500) || (ok ? 'Done' : 'No output') };
    }

    messages.push({ role: 'assistant', content, tool_calls: toolCalls });

    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}

      const check = needsApproval(tc.function.name, args);
      if (check.blocked) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: `BLOCKED: ${check.reason}` });
        continue;
      }

      emit({
        type: 'worker_step',
        workerId,
        tool: tc.function.name,
        args,
        message: `${tc.function.name}(${JSON.stringify(args).slice(0, 60)})`,
      });

      const result = await executeTool(tc.function.name, args);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result.result });

      if ((tc.function.name === 'edit_file' || tc.function.name === 'write_file') && !result.result.startsWith('Error')) {
        const v = await runVerify();
        if (!v.ok) {
          messages.push({ role: 'user', content: `Verify failed:\n${v.output.slice(0, 1000)}\n\nFix immediately.` });
        }
      }
    }
  }

  return { ok: false, summary: 'Max turns reached' };
}
