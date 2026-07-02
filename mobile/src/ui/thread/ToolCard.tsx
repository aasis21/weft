import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ToolItem } from '@/lib/timeline';

interface ToolCardProps {
  item: ToolItem;
}

const TOOL_LABELS: Record<string, string> = {
  powershell: 'Run',
  bash: 'Run',
  shell: 'Run',
  view: 'View',
  read: 'Read',
  str_replace: 'Edit',
  edit: 'Edit',
  create: 'Create',
  write: 'Write',
  grep: 'Search',
  glob: 'Find',
  ls: 'List',
};

function titleCase(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function label(name: string): string {
  return TOOL_LABELS[name] ?? titleCase(name);
}

interface ArgSummary {
  primary: string;
  isPath: boolean;
}

const PATH_KEYS = new Set(['path', 'file']);

/** One-line summary of the most useful argument, flagging file-path args for basename styling. */
function describeArg(args: unknown): ArgSummary {
  if (!args || typeof args !== 'object') return { primary: '', isPath: false };
  const record = args as Record<string, unknown>;
  for (const key of ['command', 'path', 'file', 'pattern', 'query', 'url', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return { primary: value.trim(), isPath: PATH_KEYS.has(key) };
    }
  }
  const primary = Object.entries(record)
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${summarizeValue(value)}`)
    .join(', ');
  return { primary, isPath: false };
}

/** Split a path into a dimmable directory prefix and its highlighted basename. */
function splitPath(value: string): { dir: string; base: string } {
  const idx = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (idx === -1) return { dir: '', base: value };
  return { dir: value.slice(0, idx + 1), base: value.slice(idx + 1) };
}

function summarizeValue(value: unknown): string {
  if (typeof value === 'string') return shorten(value.trim());
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === 'object') return '{…}';
  if (typeof value === 'undefined') return 'undefined';
  return String(value);
}

function shorten(value: string): string {
  return value.length > 40 ? `${value.slice(0, 39)}…` : value;
}

function isLongOutput(value: string): boolean {
  return value.length > 600 || value.split('\n').length > 12;
}

function formatArgs(args: unknown): string {
  const text = typeof args === 'object' ? JSON.stringify(args, null, 2) : String(args);
  return text ?? '';
}

function elapsed(item: ToolItem): string {
  if (item.finishedAt) {
    const ms = Math.max(0, item.finishedAt - item.startedAt);
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  }
  return item.status === 'running' ? 'running…' : '';
}

export function ToolCard({ item }: ToolCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState<'args' | 'result' | null>(null);
  const [fullResult, setFullResult] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const icon = item.status === 'running' ? '↻' : item.status === 'success' ? '✓' : '✕';
  const arg = describeArg(item.args);
  const argLine = arg.primary;
  const argPath = arg.isPath ? splitPath(argLine) : null;
  const hasDetail = !!argLine || !!item.resultPreview;
  const argsText = formatArgs(item.args);
  const resultText = item.resultPreview ?? '';
  const canViewFull = isLongOutput(resultText);

  useEffect(() => {
    return () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    };
  }, []);

  async function copyText(kind: 'args' | 'result', text: string): Promise<void> {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(kind);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(null), 1200);
    } catch {
      setCopied(null);
    }
  }

  return (
    <div className={`tool-card ${item.status}${expanded ? ' open' : ''}`}>
      <button
        type="button"
        className="tc-head"
        aria-expanded={expanded}
        onClick={() => hasDetail && setExpanded((v) => !v)}
      >
        <span className="tc-icon" aria-hidden="true">{icon}</span>
        <span className="tc-name">{label(item.name)}</span>
        {argLine ? (
          argPath ? (
            <span className="tc-args is-path">
              {argPath.dir ? <span className="tc-dir">{argPath.dir}</span> : null}
              <span className="tc-base">{argPath.base}</span>
            </span>
          ) : (
            <span className="tc-args">{argLine}</span>
          )
        ) : (
          <span className="tc-args" />
        )}
        <span className="tc-time">{elapsed(item)}</span>
        {hasDetail ? <span className="tc-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span> : null}
      </button>
      {expanded ? (
        <div className="tc-detail">
          {argLine ? (
            <>
              <div className="tc-section">
                <span>ARGUMENTS</span>
                <button
                  type="button"
                  className="tc-copy"
                  aria-label="Copy arguments"
                  onClick={() => void copyText('args', argsText)}
                >
                  {copied === 'args' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="tc-pre">{argsText}</pre>
            </>
          ) : null}
          {item.resultPreview ? (
            <>
              <div className="tc-section">
                <span>{item.status === 'error' ? 'ERROR' : 'RESULT'}</span>
                <button
                  type="button"
                  className="tc-copy"
                  aria-label={item.status === 'error' ? 'Copy error' : 'Copy result'}
                  onClick={() => void copyText('result', resultText)}
                >
                  {copied === 'result' ? 'Copied' : 'Copy'}
                </button>
                {canViewFull ? (
                  <button
                    type="button"
                    className="tc-viewfull"
                    onClick={() => setFullResult((v) => !v)}
                  >
                    {fullResult ? 'Collapse' : 'View full'}
                  </button>
                ) : null}
              </div>
              <pre className={`tc-pre${fullResult && canViewFull ? ' full' : ''}`}>{item.resultPreview}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
