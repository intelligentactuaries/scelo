import type { ProviderCall } from './router';

export async function callOpenAI(c: ProviderCall): Promise<string> {
  if (!c.apiKey) throw new Error('openai key missing');
  const body = {
    model: c.model,
    messages: c.messages,
    temperature: c.temperature ?? 0.7,
    max_tokens: c.maxTokens ?? 1024,
  };
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${c.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: c.signal,
  });
  if (!r.ok) throw new Error(`openai ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content ?? '';
}
