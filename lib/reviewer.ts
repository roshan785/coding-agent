import fs from 'fs/promises';
import path from 'path';
import { ChatCompletionResponse, errorMessage } from '@/types';

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';

export async function reviewCode(filePath: string, content: string): Promise<{ ok: boolean; feedback: string }> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return { ok: false, feedback: 'No API key' };

  const prompt = `You are a strict Senior Code Reviewer. Your job is to ensure code quality, security, and rule compliance.
Review the following file: ${filePath}

Code:
\`\`\`
${content.slice(0, 8000)}
\`\`\`

Review Checklist:
1. TypeScript: Is 'any' used? (Strictly Forbidden).
2. React/Next.js: Are 'use client' directives missing for hooks/events?
3. Security: Are there any hardcoded secrets or API keys?
4. Truthfulness: Did the developer write empty functions or fake logic?
5. Code Quality: Are there obvious bugs or missing edge cases?

If the code is GOOD and complies with all rules, reply with exactly: "PASS"
If the code has issues, reply with: "FAIL: <brief explanation of issues>"`;

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      }),
    });
    const data = (await res.json()) as ChatCompletionResponse;
    const result = (data.choices[0]?.message.content ?? '').trim();
    
    if (result.startsWith('PASS')) {
      return { ok: true, feedback: 'Code passed review.' };
    } else {
      return { ok: false, feedback: result };
    }
  } catch (e) {
    return { ok: false, feedback: `Review failed: ${errorMessage(e)}` };
  }
}
