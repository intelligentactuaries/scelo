import { type ReactNode } from 'react';

// Lightweight Markdown renderer for chatbot output.
//
// Scans lines top-to-bottom and groups runs into blocks. Handles:
//   - ATX headers (#, ##, ### → h3; ####+ → h4)
//   - Bullet lists with `-` or `*`, ordered lists with `1.`, one nested level
//   - Blockquotes (`> …`), including the indented form the swarm emits
//     inside nested bullets
//   - Inline **bold**, *italic*, `code`
// HTML is escaped by React (we return text nodes, never dangerouslySetInnerHTML).
export function renderChatMarkdown(text: string): ReactNode {
  if (!text) return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  const isHeader = (s: string) => HEADER_RE.test(s);
  const isBullet = (s: string) => BULLET_RE.test(s) || ORDERED_RE.test(s);
  const isQuote = (s: string) => QUOTE_RE.test(s);

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      i++;
      const buf: string[] = [];
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      out.push(
        <pre key={key++} className="chat-md-pre">
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const h = HEADER_RE.exec(line);
    if (h) {
      const level = h[1].length;
      const inner = parseInlines(h[2]);
      if (level <= 3) {
        out.push(<h3 key={key++} className="chat-md-h3">{inner}</h3>);
      } else {
        out.push(<h4 key={key++} className="chat-md-h4">{inner}</h4>);
      }
      i++;
      continue;
    }

    if (isQuote(line)) {
      const buf: string[] = [];
      while (i < lines.length && isQuote(lines[i])) {
        const q = QUOTE_RE.exec(lines[i])!;
        buf.push(q[1]);
        i++;
      }
      out.push(
        <blockquote key={key++} className="chat-md-quote">
          {parseInlines(buf.join(' '))}
        </blockquote>,
      );
      continue;
    }

    if (isBullet(line)) {
      const collected: Array<{ indent: number; text: string; ordered: boolean }> = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') {
          // peek: if the next non-blank line is still a bullet at any indent, continue
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === '') j++;
          if (j < lines.length && isBullet(lines[j])) {
            i = j;
            continue;
          }
          break;
        }
        const ord = ORDERED_RE.exec(l);
        const unord = BULLET_RE.exec(l);
        if (!ord && !unord) break;
        const m = (ord ?? unord)!;
        collected.push({ indent: m[1].length, text: m[3], ordered: !!ord });
        i++;
      }
      const ordered = collected[0]?.ordered ?? false;
      const items = buildBulletTree(collected);
      const Tag = ordered ? 'ol' : 'ul';
      out.push(
        <Tag key={key++} className="chat-md-list">
          {items.map((it, idx) => renderBullet(it, idx))}
        </Tag>,
      );
      continue;
    }

    // Paragraph: consume until blank line or a structural marker.
    const buf: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') break;
      if (isHeader(l) || isBullet(l) || isQuote(l)) break;
      buf.push(l);
      i++;
    }
    out.push(
      <p key={key++} className="chat-md-p">
        {buf.map((ln, idx) => (
          <span key={idx}>
            {parseInlines(ln)}
            {idx < buf.length - 1 ? ' ' : null}
          </span>
        ))}
      </p>,
    );
  }

  return out;
}

const HEADER_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*:?\s*$/;
const BULLET_RE = /^(\s*)([-*])\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d+)\.\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const FENCE_RE = /^\s{0,3}`{3,}\s*\w*\s*$/;

interface BulletNode {
  text: string;
  children: BulletNode[];
}

function buildBulletTree(
  items: Array<{ indent: number; text: string }>,
): BulletNode[] {
  if (items.length === 0) return [];
  const baseIndent = Math.min(...items.map((it) => it.indent));
  const root: BulletNode[] = [];
  for (const it of items) {
    const node: BulletNode = { text: it.text, children: [] };
    if (it.indent === baseIndent || root.length === 0) {
      root.push(node);
    } else {
      root[root.length - 1].children.push(node);
    }
  }
  return root;
}

function renderBullet(item: BulletNode, key: number): ReactNode {
  return (
    <li key={key}>
      {parseInlines(item.text)}
      {item.children.length > 0 && (
        <ul className="chat-md-list chat-md-list-nested">
          {item.children.map((c, j) => (
            <li key={j}>{parseInlines(c.text)}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

// Order matters: code first, then **bold**, then *italic*.
const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\*[^*\n]+?\*)/g;

function parseInlines(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('`')) {
      out.push(<code key={key++}>{tok.slice(1, -1)}</code>);
    } else {
      out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
