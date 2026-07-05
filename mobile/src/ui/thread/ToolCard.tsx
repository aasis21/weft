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

/**
 * When the relay couldn't resolve a real tool name (falls back to the literal "tool"), infer a
 * friendlier generic label from the argument shape instead of showing bare "Tool" in the header.
 */
function labelFromArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  if (typeof record.command === 'string') return 'Run';
  if (typeof record.old_string === 'string' || typeof record.new_string === 'string') return 'Edit';
  if (typeof record.pattern === 'string' || typeof record.query === 'string') return 'Search';
  if (typeof record.url === 'string') return 'Fetch';
  if (typeof record.path === 'string' || typeof record.file === 'string') return 'View';
  return null;
}

function label(name: string, args?: unknown): string {
  const known = TOOL_LABELS[name];
  if (known) return known;
  if (!name || name.trim().toLowerCase() === 'tool') {
    return labelFromArgs(args) ?? 'Tool';
  }
  return titleCase(name);
}

interface ArgSummary {
  primary: string;
  isPath: boolean;
}

const PATH_KEYS = new Set(['path', 'file']);
const EDIT_TOOL_NAMES = new Set(['edit', 'create', 'str_replace', 'str-replace-editor', 'str_replace_editor']);
const DIFF_PATH_KEYS = ['path', 'file', 'file_path', 'filepath', 'filePath', 'target_file', 'targetFile'];
const OLD_TEXT_KEYS = ['old_string', 'old_str', 'oldString', 'oldText', 'old_text', 'old'];
const NEW_TEXT_KEYS = ['new_string', 'new_str', 'newString', 'newText', 'new_text', 'replacement', 'replacement_string', 'content', 'file_text', 'text'];

type DiffLineKind = 'header' | 'hunk' | 'context' | 'added' | 'removed';

interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

interface EditDiff {
  path: string;
  oldText: string;
  newText: string;
  lines: DiffLine[];
}

const SHELL_TOOL_NAMES = new Set(['powershell', 'bash', 'shell']);

/**
 * One-line summary of the most useful argument, flagging file-path args for basename styling.
 * For shell-style tools, the human-authored `description` is favored over the raw `command`
 * (often a long/noisy one-liner) so the collapsed header reads like "Check disk usage" rather
 * than "df -h | grep ...". The raw command is still available in the expanded ARGUMENTS section.
 */
function describeArg(args: unknown, name = ''): ArgSummary {
  if (!args || typeof args !== 'object') return { primary: '', isPath: false };
  const record = args as Record<string, unknown>;
  const keys = SHELL_TOOL_NAMES.has(name.trim().toLowerCase())
    ? ['description', 'command', 'path', 'file', 'pattern', 'query', 'url']
    : ['command', 'path', 'file', 'pattern', 'query', 'url', 'description'];
  for (const key of keys) {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function getStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function diffCandidateRecords(args: unknown): Record<string, unknown>[] {
  const root = asRecord(args);
  if (!root) return [];
  return [root, root.input, root.params, root.arguments]
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => record !== null);
}

function isEditToolName(name: string): boolean {
  return EDIT_TOOL_NAMES.has(name.trim().toLowerCase());
}

function commandLooksLikeCreate(record: Record<string, unknown>, name: string): boolean {
  return isEditToolName(name) && (name.trim().toLowerCase() === 'create' || record.command === 'create');
}

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, '\n').split('\n');
}

function lineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const lengths = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      lengths[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? lengths[oldIndex + 1][newIndex + 1] + 1
          : Math.max(lengths[oldIndex + 1][newIndex], lengths[oldIndex][newIndex + 1]);
    }
  }

  const lines: DiffLine[] = [
    { kind: 'header', text: '--- before' },
    { kind: 'header', text: '+++ after' },
    { kind: 'hunk', text: `@@ -1,${oldLines.length} +1,${newLines.length} @@` },
  ];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
      lines.push({ kind: 'context', text: ` ${oldLines[oldIndex]}` });
      oldIndex += 1;
      newIndex += 1;
    } else if (newIndex < newLines.length && (oldIndex === oldLines.length || lengths[oldIndex][newIndex + 1] >= lengths[oldIndex + 1][newIndex])) {
      lines.push({ kind: 'added', text: `+${newLines[newIndex]}` });
      newIndex += 1;
    } else if (oldIndex < oldLines.length) {
      lines.push({ kind: 'removed', text: `-${oldLines[oldIndex]}` });
      oldIndex += 1;
    }
  }
  return lines;
}

function getEditDiff(name: string, args: unknown): EditDiff | null {
  for (const record of diffCandidateRecords(args)) {
    const path = getStringField(record, DIFF_PATH_KEYS) ?? 'edited file';
    const oldText = getStringField(record, OLD_TEXT_KEYS);
    const newText = getStringField(record, NEW_TEXT_KEYS);
    const create = commandLooksLikeCreate(record, name);
    const hasOldNewShape = typeof oldText === 'string' && typeof newText === 'string';
    if (!hasOldNewShape && !(create && typeof newText === 'string')) continue;
    if (!isEditToolName(name) && !hasOldNewShape) continue;
    const before = create && oldText === undefined ? '' : (oldText ?? '');
    return { path, oldText: before, newText, lines: lineDiff(before, newText) };
  }
  return null;
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
  const arg = describeArg(item.args, item.name);
  const argLine = arg.primary;
  const argPath = arg.isPath ? splitPath(argLine) : null;
  const hasDetail = !!argLine || !!item.resultPreview;
  const argsText = formatArgs(item.args);
  const resultText = item.resultPreview ?? '';
  const canViewFull = isLongOutput(resultText);
  const editDiff = getEditDiff(item.name, item.args);

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
        <span className="tc-name">{label(item.name, item.args)}</span>
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
          {editDiff ? (
            <>
              <div className="tc-section">
                <span>DIFF</span>
                <button
                  type="button"
                  className="tc-copy"
                  aria-label="Copy diff"
                  onClick={() => void copyText('args', editDiff.lines.map((line) => line.text).join('\n'))}
                >
                  {copied === 'args' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="tc-diff" role="region" aria-label={`Diff for ${editDiff.path}`}>
                <div className="tc-diff-file">{editDiff.path}</div>
                {editDiff.lines.map((line, index) => (
                  <div key={`${line.kind}-${index}`} className={`tc-diff-line ${line.kind}`}>
                    {line.text || ' '}
                  </div>
                ))}
              </div>
            </>
          ) : argLine ? (
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
