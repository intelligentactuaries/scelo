import type { ProviderCall } from './router';

export async function callGemini(c: ProviderCall): Promise<string> {
  if (!c.apiKey) throw new Error('gemini key missing');
  const sys = c.messages.find((m) => m.role === 'system')?.content;
  const contents = c.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: c.temperature ?? 0.7,
      maxOutputTokens: c.maxTokens ?? 1024,
    },
  };
  if (sys) body.systemInstruction = { role: 'system', parts: [{ text: sys }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    c.model,
  )}:generateContent?key=${encodeURIComponent(c.apiKey)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: c.signal,
  });
  if (!r.ok) throw new Error(`gemini ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return (j.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('');
}
