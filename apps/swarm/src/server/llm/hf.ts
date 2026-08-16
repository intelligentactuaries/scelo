import type { ProviderCall } from './router';

export async function callHF(c: ProviderCall): Promise<string> {
  if (!c.apiKey) throw new Error('hf key missing');
  const body = {
    model: c.model,
    messages: c.messages,
    temperature: c.temperature ?? 0.7,
    max_tokens: c.maxTokens ?? 1024,
    stream: false,
  };
  const r = await fetch('https://router.huggingface.co/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${c.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: c.signal,
  });
  if (!r.ok) throw new Error(`hf ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content ?? '';
}
