import type { ProviderCall } from './router';

const HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

export async function listOllamaModels(): Promise<string[]> {
  try {
    const r = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return [];
    const j = (await r.json()) as { models?: { name: string }[] };
    return (j.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

const PREFERENCE = ['gemma3', 'qwen2.5', 'llama3.1', 'llama3.2', 'qwen2.5vl', 'gpt-oss'];

export function pickOllamaModel(available: string[]): string | null {
  if (!available.length) return null;
  for (const pref of PREFERENCE) {
    const match = available.find((m) => m.toLowerCase().startsWith(pref));
    if (match) return match;
  }
  return available[0];
}

export async function callOllama(c: ProviderCall): Promise<string> {
  const body = {
    model: c.model,
    messages: c.messages,
    stream: false,
    options: {
      temperature: c.temperature ?? 0.7,
      num_predict: c.maxTokens ?? 512,
    },
  };
  const r = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: c.signal,
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { message?: { content?: string } };
  return j.message?.content ?? '';
}

export async function* callOllamaStream(c: ProviderCall): AsyncGenerator<string> {
  const body = {
    model: c.model,
    messages: c.messages,
    stream: true,
    options: {
      temperature: c.temperature ?? 0.7,
      num_predict: c.maxTokens ?? 512,
    },
  };
  const r = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: c.signal,
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
  if (!r.body) throw new Error('ollama: no response body');
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        try {
          const j = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
          if (j.message?.content) yield j.message.content;
        } catch {
          // skip malformed line
        }
      }
      nl = buf.indexOf('\n');
    }
  }
  if (buf.trim()) {
    try {
      const j = JSON.parse(buf) as { message?: { content?: string } };
      if (j.message?.content) yield j.message.content;
    } catch {
      // ignore
    }
  }
}
