import type { ProviderCall } from './router';

export async function callClaude(c: ProviderCall): Promise<string> {
  if (!c.apiKey) throw new Error('anthropic key missing');
  const system = c.messages.find((m) => m.role === 'system')?.content;
  const messages = c.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
  const body: Record<string, unknown> = {
    model: c.model,
    max_tokens: c.maxTokens ?? 1024,
    temperature: c.temperature ?? 0.7,
    messages,
  };
  if (system) body.system = system;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': c.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: c.signal,
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { content?: { type: string; text?: string }[] };
  const text = (j.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  return text;
}
