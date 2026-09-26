const TOOL_LABELS: Record<string, string> = {
  rg: 'Search',
  glob: 'Find Files',
  view: 'View',
  apply_patch: 'Edit Files',
  powershell: 'Run Command',
  skill: 'Activate Skill',
  task: 'Start Agent',
  read_agent: 'Read Agent',
  write_agent: 'Message Agent',
  web_fetch: 'Fetch Web Page',
  web_search: 'Search Web',
  ask_user: 'Ask User',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function titleCase(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function hideFullPaths(value: string): string {
  return value
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*([^\\\s]+)/g, '$1')
    .replace(/(^|\s)\/(?:[^/\s]+\/)+([^/\s]+)/g, '$1$2');
}

function inferredToolLabel(args: unknown): string | null {
  const record = asRecord(args);
  if (!record) return null;
  if (typeof record.command === 'string') return 'Run Command';
  if (typeof record.old_string === 'string' || typeof record.new_string === 'string') return 'Edit Files';
  if (typeof record.pattern === 'string' || typeof record.query === 'string') return 'Search';
  if (typeof record.url === 'string') return 'Fetch Web Page';
  if (typeof record.path === 'string' || typeof record.file === 'string') return 'View';
  return null;
}

export function toolDisplayName(name: string, args?: unknown): string {
  const normalized = name.trim().toLowerCase();
  if (TOOL_LABELS[normalized]) return TOOL_LABELS[normalized];
  if (!normalized || normalized === 'tool') return inferredToolLabel(args) ?? 'Tool';
  return titleCase(name);
}

export function compactToolDetail(name: string, args: unknown): string | null {
  const record = asRecord(args);
  if (!record) return null;

  const description = typeof record.description === 'string' ? record.description.trim() : '';
  if (description) return hideFullPaths(description);

  const normalized = name.trim().toLowerCase();
  if (normalized === 'view' || normalized === 'read' || normalized === 'edit' || normalized === 'create') {
    const path =
      typeof record.path === 'string' ? record.path :
      typeof record.file === 'string' ? record.file :
      typeof record.file_path === 'string' ? record.file_path :
      null;
    return path ? basename(path) : null;
  }

  return null;
}
