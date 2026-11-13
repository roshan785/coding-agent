import { NextRequest } from 'next/server';
import { toolSchemas, executeTool, ToolResult } from '@/lib/tools';

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_TURNS = 10;

type ChatMsg = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
};

export async function POST(req: NextRequest) {
  const { messages } = await req.json();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'DEEPSEEK_API_KEY not set' },
      { status: 500 }
    );
  }

  const convo: ChatMsg[] = [
    {
      role: 'system',
      content:
        'You are a coding agent running inside a Next.js app on the user\'s Linux machine. ' +
        'You have tools: read_file (read files from the workspace) and bash (run commands in the project root). ' +
        'Rules:\n' +
        '- Always read a file before making claims about its contents.\n' +
        '- Use bash for ls, grep, cat, git status, npm/cargo commands.\n' +
        '- If a tool returns an error, read it carefully and adapt.\n' +
        '- Be concise. Do not fabricate file contents.\n' +
        '- When you cannot proceed without user input, ask clearly.',
    },
    ...messages,
  ];

  const toolCalls: ToolResult[] = [];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const body = {
        model: MODEL,
        messages: convo,
        tools: toolSchemas,
        tool_choice: 'auto',
        temperature: 0.2,
      };

      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const txt = await res.text();
        return Response.json(
          { error: `DeepSeek ${res.status}: ${txt}` },
          { status: res.status }
        );
      }

      const data = await res.json();
      const msg = data.choices[0].message;
      const tcs = msg.tool_calls || [];

      if (tcs.length === 0) {
        // Final answer — done
        return Response.json({
          message: { content: msg.content || '' },
          toolCalls,
        });
      }

      // Push assistant message with tool_calls
      convo.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: tcs,
      });

      // Execute each tool call
      for (const tc of tcs) {
        let args: any = {};
        try {
          args = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          args = {};
        }
        const result = await executeTool(tc.function?.name || '', args);
        toolCalls.push(result);
        convo.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result.result,
        });
      }
    }

    return Response.json({
      message: { content: '⚠️ Max turns reached without final answer.' },
      toolCalls,
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
