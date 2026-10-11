export function diffRows(patch: string): { text: string; kind: string; before: number | null; after: number | null }[] {
  let before = 0, after = 0, hunk = false;
  return patch.split('\n').map((text) => {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) { before = Number(header[1]); after = Number(header[2]); hunk = true; }
    if (text.startsWith('diff --git')) hunk = false;
    if (!hunk || header || text.startsWith('\\')) return { text, kind: '', before: null, after: null };
    if (text.startsWith('+')) return { text, kind: 'insert', before: null, after: after++ };
    if (text.startsWith('-')) return { text, kind: 'delete', before: before++, after: null };
    if (text.startsWith(' ')) return { text, kind: '', before: before++, after: after++ };
    return { text, kind: '', before: null, after: null };
  });
}
