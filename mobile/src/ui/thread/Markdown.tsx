import { Fragment, useCallback, useMemo, useState } from 'react';
import type { CSSProperties, JSX, ReactNode } from 'react';
import '@/ui/styles/markdown-code.css';

/**
 * Minimal, dependency-free, XSS-safe Markdown -> React renderer.
 * Supports the subset Copilot streams emit: fenced + inline code, bold, italic,
 * strikethrough, links, images, ordered/unordered/task lists, tables, headings,
 * blockquotes, and horizontal rules.
 * It renders real React nodes (never dangerouslySetInnerHTML), and only allows
 * http(s)/mailto links. Tolerant of partial markdown while a turn streams in
 * (e.g. an unterminated ``` fence is treated as code to the end of the text).
 */

const SAFE_URL = /^(https?:|mailto:)/i;
const INLINE = /(`[^`]+`)|(~~[^~]+~~)|(\*\*[^*]+\*\*)|(!\[[^\]]*\]\([^)]+\))|(\[[^\]]+\]\([^)]+\))|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)/;

const HL_LANGS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'javascript', 'typescript', 'json', 'py', 'python', 'go', 'golang',
  'rust', 'rs', 'java', 'c', 'cpp', 'c++', 'cs', 'csharp', 'sh', 'bash', 'shell', 'zsh', 'yaml',
  'yml', 'php', 'rb', 'ruby', 'kt', 'kotlin', 'swift', 'sql',
]);

const HASH_COMMENT_LANGS = new Set([
  'py', 'python', 'sh', 'bash', 'shell', 'zsh', 'yaml', 'yml', 'rb', 'ruby',
]);

const CODE_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'class', 'extends', 'new', 'this', 'super', 'import', 'export', 'from',
  'default', 'async', 'await', 'yield', 'typeof', 'instanceof', 'in', 'of', 'try', 'catch', 'finally',
  'throw', 'void', 'delete', 'static', 'public', 'private', 'protected', 'interface', 'type', 'enum',
  'implements', 'package', 'func', 'def', 'elif', 'lambda', 'pass', 'with', 'as', 'not', 'and', 'or',
  'is', 'fn', 'mut', 'use', 'struct', 'impl', 'match', 'pub', 'trait', 'where', 'defer', 'select',
  'chan', 'range', 'echo', 'then', 'fi', 'done', 'local', 'require', 'module', 'namespace', 'val',
]);

const CODE_LITERALS = new Set([
  'true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil', 'NaN', 'self',
]);

// One pass: comment | string | number | identifier. Everything else is emitted verbatim,
// so the exact source (whitespace, punctuation) is preserved and nothing is injected as HTML.
const CODE_TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|--[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(0[xX][0-9a-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_$][\w$]*)/g;

function isRealComment(token: string, lang: string): boolean {
  if (token.startsWith('//') || token.startsWith('/*')) return true;
  if (token.startsWith('#')) return HASH_COMMENT_LANGS.has(lang);
  if (token.startsWith('--')) return lang === 'sql';
  return false;
}

/** Zero-dependency, XSS-safe highlighter: tokenizes into React <span>s, never HTML. */
function highlightCode(code: string, lang: string): ReactNode {
  if (!HL_LANGS.has(lang)) return code;
  const nodes: ReactNode[] = [];
  let last = 0;
  let n = 0;
  CODE_TOKEN.lastIndex = 0;
  for (let m = CODE_TOKEN.exec(code); m !== null; m = CODE_TOKEN.exec(code)) {
    if (m.index > last) nodes.push(code.slice(last, m.index));
    const key = `h${n++}`;
    const [full, comment, str, num, word] = m;
    if (comment) {
      nodes.push(
        isRealComment(comment, lang) ? (
          <span key={key} className="tok-comment">
            {comment}
          </span>
        ) : (
          comment
        ),
      );
    } else if (str) {
      nodes.push(
        <span key={key} className="tok-string">
          {str}
        </span>,
      );
    } else if (num) {
      nodes.push(
        <span key={key} className="tok-number">
          {num}
        </span>,
      );
    } else if (CODE_KEYWORDS.has(word)) {
      nodes.push(
        <span key={key} className="tok-keyword">
          {word}
        </span>,
      );
    } else if (CODE_LITERALS.has(word)) {
      nodes.push(
        <span key={key} className="tok-literal">
          {word}
        </span>,
      );
    } else {
      nodes.push(word);
    }
    last = m.index + full.length;
  }
  if (last < code.length) nodes.push(code.slice(last));
  return nodes;
}

/** Fenced code block with a language label (#13), Copy button (#12), and highlighting (#14). */
function CodeBlock({ code, lang }: { code: string; lang: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const normalizedLang = lang.trim().toLowerCase();
  const highlighted = useMemo(() => highlightCode(code, normalizedLang), [code, normalizedLang]);
  const onCopy = useCallback((): void => {
    const done = navigator.clipboard?.writeText(code);
    if (!done) return;
    void done.then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  }, [code]);
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang.trim() || 'code'}</span>
        <button
          type="button"
          className="md-code-copy"
          onClick={onCopy}
          aria-label={copied ? 'Code copied' : 'Copy code to clipboard'}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="md-code-pre">
        <code>{highlighted}</code>
      </pre>
    </div>
  );
}

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
    } else if (tok.startsWith('~~')) {
      out.push(<del key={key}>{tok.slice(2, -2)}</del>);
    } else if (tok.startsWith('**')) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('![')) {
      const im = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(tok);
      if (im && /^https?:/i.test(im[2].trim())) {
        out.push(<img key={key} src={im[2].trim()} alt={im[1]} loading="lazy" />);
      } else {
        out.push(im ? im[1] || tok : tok);
      }
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
  type ListItem = { key: string; children: ReactNode[]; checked?: boolean | null };
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
      const task = /^\[([ xX])\]\s+(.*)$/.exec(match[3]);
      if (task) {
        items.push({ key: itemKey, checked: task[1].toLowerCase() === 'x', children: renderInline(task[2], itemKey) });
      } else {
        items.push({ key: itemKey, checked: null, children: renderInline(match[3], itemKey) });
      }
      next++;
    }

    const renderedItems = items.map((item) =>
      item.checked === null || item.checked === undefined ? (
        <li key={item.key}>{item.children}</li>
      ) : (
        <li key={item.key} className="task-item">
          <input type="checkbox" checked={item.checked} readOnly disabled />
          {item.children}
        </li>
      ),
    );
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
      blocks.push(<CodeBlock key={`b${key++}`} code={body.join('\n')} lang={fence[1] ?? ''} />);
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
