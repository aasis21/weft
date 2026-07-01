import { Fragment } from 'react';
import type { CSSProperties, JSX, ReactNode } from 'react';

/**
 * Minimal, dependency-free, XSS-safe Markdown -> React renderer.
 * Supports the subset Copilot streams emit: fenced + inline code, bold, italic,
 * links, ordered/unordered lists, tables, headings, blockquotes, and horizontal rules.
 * It renders real React nodes (never dangerouslySetInnerHTML), and only allows
 * http(s)/mailto links. Tolerant of partial markdown while a turn streams in
 * (e.g. an unterminated ``` fence is treated as code to the end of the text).
 */

const SAFE_URL = /^(https?:|mailto:)/i;
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)/;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest.length > 0) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    const key = `${keyBase}-${n++}`;
    if (tok.startsWith('`')) {
      out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('**')) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('[')) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (lm && SAFE_URL.test(lm[2].trim())) {
        out.push(
          <a key={key} href={lm[2].trim()} target="_blank" rel="noreferrer noopener">
            {lm[1]}
          </a>,
        );
      } else {
        out.push(lm ? lm[1] : tok);
      }
    } else {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

type TableAlign = CSSProperties['textAlign'];

const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function indentationWidth(indent: string): number {
  return Array.from(indent).reduce((width, char) => width + (char === '\t' ? 2 : 1), 0);
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

function splitTableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '';

  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|' && !isEscaped(line, i)) {
      cells.push(cell);
      cell = '';
    } else {
      cell += line[i];
    }
  }
  cells.push(cell);

  const trimmed = cells.map((part) => part.trim().replace(/\\\|/g, '|'));
  if (trimmed[0] === '') trimmed.shift();
  if (trimmed[trimmed.length - 1] === '') trimmed.pop();
  return trimmed;
}

function parseTableAlignments(line: string): (TableAlign | undefined)[] | null {
  if (!/^[\s|:-]+$/.test(line)) return null;

  const cells = splitTableCells(line);
  if (cells.length === 0) return null;

  const alignments: (TableAlign | undefined)[] = [];
  for (const cell of cells) {
    const marker = cell.replace(/\s/g, '');
    if (!/^:?-+:?$/.test(marker)) return null;

    if (marker.startsWith(':') && marker.endsWith(':')) {
      alignments.push('center');
    } else if (marker.startsWith(':')) {
      alignments.push('left');
    } else if (marker.endsWith(':')) {
      alignments.push('right');
    } else {
      alignments.push(undefined);
    }
  }

  return alignments;
}

function alignmentStyle(textAlign: TableAlign | undefined): CSSProperties | undefined {
  return textAlign ? { textAlign } : undefined;
}

function isTableStart(lines: string[], start: number): boolean {
  return lines[start].includes('|') && start + 1 < lines.length && parseTableAlignments(lines[start + 1]) !== null;
}

function renderTable(lines: string[], start: number, blockKey: string): { element: JSX.Element; next: number } | null {
  if (!isTableStart(lines, start)) return null;

  const alignments = parseTableAlignments(lines[start + 1]);
  if (!alignments) return null;

  const headers = splitTableCells(lines[start]);
  const rows: string[][] = [];
  let next = start + 2;

  while (next < lines.length && lines[next].includes('|')) {
    rows.push(splitTableCells(lines[next]));
    next++;
  }

  return {
    element: (
      <table key={blockKey}>
        <thead>
          <tr>
            {headers.map((cell, cellIndex) => (
              <th key={`${blockKey}-h${cellIndex}`} style={alignmentStyle(alignments[cellIndex])}>
                {renderInline(cell, `${blockKey}-h${cellIndex}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${blockKey}-r${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${blockKey}-r${rowIndex}c${cellIndex}`} style={alignmentStyle(alignments[cellIndex])}>
                  {renderInline(cell, `${blockKey}-r${rowIndex}c${cellIndex}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    ),
    next,
  };
}

function renderList(lines: string[], start: number, blockKey: string): { element: JSX.Element; next: number } {
  type ListItem = { key: string; children: ReactNode[] };
  type ListParse = { element: JSX.Element; next: number };

  function parseLevel(index: number, indent: number, ordered: boolean, keyBase: string): ListParse {
    const items: ListItem[] = [];
    let next = index;

    while (next < lines.length) {
      const match = LIST_ITEM.exec(lines[next]);
      if (!match) break;

      const itemIndent = indentationWidth(match[1]);
      const itemOrdered = /^\d+\.$/.test(match[2]);

      if (itemIndent < indent || (itemIndent === indent && itemOrdered !== ordered)) break;

      if (itemIndent > indent) {
        if (items.length === 0) break;
        const nested = parseLevel(next, itemIndent, itemOrdered, `${keyBase}-${items.length - 1}n`);
        items[items.length - 1].children.push(nested.element);
        next = nested.next;
        continue;
      }

      const itemKey = `${keyBase}-i${items.length}`;
      items.push({ key: itemKey, children: renderInline(match[3], itemKey) });
      next++;
    }

    const renderedItems = items.map((item) => <li key={item.key}>{item.children}</li>);
    return {
      element: ordered ? <ol key={keyBase}>{renderedItems}</ol> : <ul key={keyBase}>{renderedItems}</ul>,
      next,
    };
  }

  const first = LIST_ITEM.exec(lines[start]);
  const indent = first ? indentationWidth(first[1]) : 0;
  const ordered = first ? /^\d+\.$/.test(first[2]) : false;
  return parseLevel(start, indent, ordered, blockKey);
}

export function Markdown({ text }: { text: string }): JSX.Element {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: JSX.Element[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block (tolerant of a missing closing fence while streaming).
    const fence = /^```(\w+)?\s*$/.exec(line.trim());
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume closing fence if present
      blocks.push(
        <pre key={`b${key++}`}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    if (/^---+\s*$/.test(line.trim())) {
      blocks.push(<hr key={`b${key++}`} />);
      i++;
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = (`h${level}` as 'h1' | 'h2' | 'h3');
      blocks.push(<Tag key={`b${key++}`}>{renderInline(heading[2], `h${key}`)}</Tag>);
      i++;
      continue;
    }

    const table = renderTable(lines, i, `b${key}`);
    if (table) {
      blocks.push(table.element);
      key++;
      i = table.next;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote key={`b${key++}`}>{renderInline(quote.join(' '), `q${key}`)}</blockquote>,
      );
      continue;
    }

    // Unordered / ordered list.
    if (LIST_ITEM.test(line)) {
      const list = renderList(lines, i, `b${key}`);
      blocks.push(list.element);
      key++;
      i = list.next;
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-block lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i].trim()) &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !isTableStart(lines, i) &&
      !LIST_ITEM.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i].trim())
    ) {
      para.push(lines[i]);
      i++;
    }
    const parts = renderInline(para.join('\n'), `p${key}`);
    blocks.push(
      <p key={`b${key++}`}>
        {parts.map((part, idx) =>
          typeof part === 'string'
            ? part.split('\n').map((seg, j, arr) => (
                <Fragment key={`s${idx}-${j}`}>
                  {seg}
                  {j < arr.length - 1 ? <br /> : null}
                </Fragment>
              ))
            : part,
        )}
      </p>,
    );
  }

  return <>{blocks}</>;
}
