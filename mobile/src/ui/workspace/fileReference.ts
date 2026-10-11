export interface FileReference { path: string; line?: number }

export function fileReference(href: string): FileReference | null {
  const raw = href.trim();
  if (!raw || /^(?:https?:|mailto:|javascript:|data:|blob:|\/\/|\\\\)/i.test(raw)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw) && !/^file:\/\/\//i.test(raw)) return null;
  let path: string;
  const [target, anchor] = raw.split('#', 2);
  try {
    path = decodeURIComponent(target);
    if (/^file:\/\/\//i.test(path)) {
      path = path.replace(/^file:\/\//i, '');
      if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);
    }
  } catch { return null; }
  if (/[\0\r\n?]/.test(path) || !/\.[a-z0-9]{1,12}$/i.test(path)) return null;
  const line = anchor && /^L(\d+)(?:-L?\d+)?$/.exec(anchor)?.[1];
  return { path, ...(line ? { line: Number(line) } : {}) };
}

export function referencedFilePath(currentFile: string, reference: FileReference): string {
  if (/^(?:[a-z]:[\\/]|\/)/i.test(reference.path)) return reference.path + (reference.line ? `#L${reference.line}` : '');
  const parts = currentFile.replace(/\\/g, '/').split('/').slice(0, -1);
  for (const part of reference.path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/') + (reference.line ? `#L${reference.line}` : '');
}
