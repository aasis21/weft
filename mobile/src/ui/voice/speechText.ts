/** Turning written markdown into something worth hearing.
 *
 *  A speech engine reads what it is given, literally. Handing it raw agent output means it announces
 *  every backtick, asterisk and hash as a word — a sentence like "say `aloft` to start" comes out as
 *  "say back tick aloft back tick to start", and a fenced code block is read character by character
 *  for as long as it takes. None of that carries meaning aloud; it is punctuation that exists only
 *  because the same text is also being *shown*.
 *
 *  So this strips the markup rather than pronouncing it, and drops the constructs that have no
 *  spoken form at all (code blocks, tables, URLs) instead of spelling them out. Text is the source of
 *  truth on screen; this is only ever the audio rendering of it. */

/** Trailing path segment of a file path, so a long absolute path is spoken as a name. */
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Strip inline markup from a single line that is already known not to be code. */
function sanitizeLine(line: string): string {
  let out = line;

  // Links and images: keep the words, drop the target. Do this before anything eats the brackets.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Inline code: the ticks are the noise, the contents are usually a real word ("aloft", "Dismiss").
  out = out.replace(/`+([^`]*)`+/g, '$1');

  // Emphasis markers. Bold/italic carry tone that speech can't reproduce anyway.
  out = out.replace(/(\*\*|__)(.*?)\1/g, '$2');
  out = out.replace(/(?<![\w*])\*(?!\s)([^*]+?)\*(?![\w*])/g, '$1');
  out = out.replace(/(?<![\w_])_(?!\s)([^_]+?)_(?![\w_])/g, '$1');
  out = out.replace(/~~(.*?)~~/g, '$1');

  // Line-leading structure: heading hashes, blockquote arrows, bullet and checkbox markers. The
  // marker is a visual cue; read aloud it is just a stray symbol at the start of a thought.
  out = out.replace(/^\s{0,3}#{1,6}\s+/, '');
  out = out.replace(/^\s*>+\s?/, '');
  out = out.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '');
  out = out.replace(/^\s*[-*+]\s+/, '');
  // A numbered marker splits off as its own "sentence" upstream and is read as a bare digit, which
  // sounds like a countdown rather than a list.
  out = out.replace(/^\s*\d+[.)]\s+/, '');

  // A horizontal rule is silence, not "dash dash dash".
  if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(out)) return '';

  // Bare URLs have no useful spoken form; a file path is worth its name only.
  out = out.replace(/\b(?:https?:\/\/|www\.)\S+/gi, 'a link');
  out = out.replace(/(?:[A-Za-z]:)?[\\/][\w.-]+(?:[\\/][\w.-]+)+/g, (m) => lastSegment(m));

  // Table pipes read as "vertical bar" on every cell boundary.
  if (/^\s*\|/.test(out)) out = out.replace(/\|/g, ' ');
  // A table's separator row is pure punctuation.
  if (/^[\s|:-]+$/.test(out) && out.includes('-')) return '';

  return out.replace(/\s+/g, ' ').trim();
}

/** Stateful because a fenced code block can open in one streaming chunk and close in another — the
 *  sanitiser has to remember it is inside one to keep swallowing the lines in between. */
export function createSpeechSanitizer(): { sanitize(text: string): string; reset(): void } {
  let inFence = false;
  let announcedFence = false;
  return {
    reset(): void {
      inFence = false;
      announcedFence = false;
    },
    sanitize(text: string): string {
      const out: string[] = [];
      for (const line of text.split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) {
          inFence = !inFence;
          if (inFence && !announcedFence) {
            // Say that code went past rather than reading it or silently skipping it — a reply that
            // is mostly code would otherwise sound like it answered nothing.
            announcedFence = true;
            out.push('code block.');
          }
          if (!inFence) announcedFence = false;
          continue;
        }
        if (inFence) continue;
        const clean = sanitizeLine(line);
        if (clean) out.push(clean);
      }
      return out.join(' ');
    },
  };
}

/** One-shot form for text that is already complete. */
export function sanitizeForSpeech(text: string): string {
  return createSpeechSanitizer().sanitize(text);
}
