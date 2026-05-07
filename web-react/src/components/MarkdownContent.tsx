import { useMemo } from "react";

import { useImageLightbox, type LightboxImage } from "@/components/ImageLightbox";

type MarkdownContentProps = {
  value: string;
};

type InlinePart =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string }
  | { type: "image"; alt: string; src: string };

export function MarkdownContent({ value }: MarkdownContentProps) {
  const images = useMemo(() => collectImages(value), [value]);
  const lightbox = useImageLightbox(images);
  const blocks = useMemo(() => parseBlocks(value), [value]);

  return (
    <div className="markdown-content space-y-3 text-sm leading-6 text-app-text">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const className = "font-semibold leading-tight";
          const content = renderInline(block.text, images, lightbox.openAt);
          if (block.level <= 1) return <h2 key={index} className={className}>{content}</h2>;
          if (block.level === 2) return <h3 key={index} className={className}>{content}</h3>;
          if (block.level === 3) return <h4 key={index} className={className}>{content}</h4>;
          return <h5 key={index} className={className}>{content}</h5>;
        }
        if (block.type === "list") {
          return (
            <ul key={index} className="list-disc space-y-1 pl-5">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item, images, lightbox.openAt)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "ordered-list") {
          return (
            <ol key={index} className="list-decimal space-y-1 pl-5">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item, images, lightbox.openAt)}</li>
              ))}
            </ol>
          );
        }
        if (block.type === "code") {
          return (
            <pre key={index} className="overflow-auto rounded-md border border-app-border bg-app-surface-2 p-3 font-mono text-xs">
              {block.text}
            </pre>
          );
        }
        if (block.type === "table") {
          return <MarkdownTable key={index} rows={block.rows} />;
        }
        return (
          <p key={index} className="whitespace-pre-wrap">
            {renderInline(block.text, images, lightbox.openAt)}
          </p>
        );
      })}
      {lightbox.lightbox}
    </div>
  );
}

type Block =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "code"; text: string }
  | { type: "table"; rows: string[][] };

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableLines: string[] = [];
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }
      const rows = tableLines
        .filter((entry) => !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(entry))
        .map((entry) =>
          entry
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((cell) => cell.trim()),
        );
      blocks.push({ type: "table", rows });
      continue;
    }

    const unorderedItems: string[] = [];
    while (index < lines.length) {
      const match = (lines[index] ?? "").match(/^\s*[-*]\s+(.+)$/);
      if (!match) break;
      unorderedItems.push(match[1]);
      index += 1;
    }
    if (unorderedItems.length > 0) {
      blocks.push({ type: "list", items: unorderedItems });
      continue;
    }

    const orderedItems: string[] = [];
    while (index < lines.length) {
      const match = (lines[index] ?? "").match(/^\s*\d+\.\s+(.+)$/);
      if (!match) break;
      orderedItems.push(match[1]);
      index += 1;
    }
    if (orderedItems.length > 0) {
      blocks.push({ type: "ordered-list", items: orderedItems });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index]?.trim()) {
      const next = lines[index] ?? "";
      if (next.startsWith("```") || next.match(/^(#{1,6})\s+(.+)$/)) break;
      if (paragraph.length > 0 && (next.match(/^\s*[-*]\s+(.+)$/) || next.match(/^\s*\d+\.\s+(.+)$/))) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}

function isTableStart(lines: string[], index: number): boolean {
  const current = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return current.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
}

function MarkdownTable({ rows }: { rows: string[][] }) {
  if (rows.length === 0) return null;
  const [head, ...body] = rows;
  return (
    <div className="overflow-x-auto rounded-md border border-app-border">
      <table className="min-w-full border-collapse text-left text-xs">
        <thead className="bg-app-surface-2 text-app-text">
          <tr>
            {head.map((cell, index) => (
              <th key={index} className="border-b border-app-border px-3 py-2 font-semibold">
                {renderInline(cell, [], () => undefined)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t border-app-border/60">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-3 py-2 align-top text-app-text-muted">
                  {renderInline(cell, [], () => undefined)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderInline(
  text: string,
  images: LightboxImage[],
  openImage: (index: number) => void,
): React.ReactNode[] {
  return parseInline(text).map((part, index) => {
    if (part.type === "bold") return <strong key={index}>{part.text}</strong>;
    if (part.type === "code") {
      return (
        <code key={index} className="rounded bg-app-surface-2 px-1 py-0.5 font-mono text-[0.9em]">
          {part.text}
        </code>
      );
    }
    if (part.type === "link") {
      return (
        <a key={index} href={part.href} target="_blank" rel="noreferrer" className="text-app-accent underline">
          {part.text}
        </a>
      );
    }
    if (part.type === "image") {
      const imageIndex = images.findIndex((image) => image.url === part.src);
      return (
        <button
          key={index}
          type="button"
          onClick={() => imageIndex >= 0 && openImage(imageIndex)}
          className="my-2 block max-w-sm overflow-hidden rounded-md border border-app-border bg-app-surface-2 text-left"
        >
          <img src={part.src} alt={part.alt} className="max-h-52 w-full object-cover" loading="lazy" />
          <span className="block truncate px-2 py-1 text-[11px] text-app-text-muted">{part.alt || part.src}</span>
        </button>
      );
    }
    return <span key={index}>{part.text}</span>;
  });
}

function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const pattern = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|(__([^_]+)__)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(...linkifyText(text.slice(lastIndex, match.index)));
    if (match[1] !== undefined && match[2]) {
      parts.push({ type: "image", alt: match[1], src: match[2] });
    } else if (match[3] !== undefined && match[4]) {
      parts.push({ type: "link", text: match[3], href: match[4] });
    } else if (match[5] !== undefined) {
      parts.push({ type: "code", text: match[5] });
    } else if (match[6] !== undefined) {
      parts.push({ type: "bold", text: match[6] });
    } else if (match[8] !== undefined) {
      parts.push({ type: "bold", text: match[8] });
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) parts.push(...linkifyText(text.slice(lastIndex)));
  return parts;
}

function linkifyText(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const pattern = /(https?:\/\/[^\s)]+|\/api\/[^\s)]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push({ type: "text", text: text.slice(lastIndex, match.index) });
    parts.push({ type: "link", text: match[1], href: match[1] });
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) parts.push({ type: "text", text: text.slice(lastIndex) });
  return parts;
}

function collectImages(markdown: string): LightboxImage[] {
  const images: LightboxImage[] = [];
  const pattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    images.push({ title: match[1] || match[2], url: match[2] });
  }
  return images;
}
