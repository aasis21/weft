import { describe, expect, it } from 'vitest';
import { createSpeechSanitizer, sanitizeForSpeech } from '../speechText';

describe('sanitizeForSpeech strips markup the engine would otherwise pronounce', () => {
  it('reads inline code as the word it wraps, not "back tick"', () => {
    expect(sanitizeForSpeech('Say `aloft` to start.')).toBe('Say aloft to start.');
  });

  it('drops emphasis markers without eating the words', () => {
    expect(sanitizeForSpeech('This is **very** _important_ and ~~old~~.')).toBe(
      'This is very important and old.',
    );
  });

  it('leaves intra-word underscores and asterisks alone', () => {
    expect(sanitizeForSpeech('call session_runtime with a * b')).toBe('call session_runtime with a * b');
  });

  it('strips heading, quote, bullet and numbered markers', () => {
    expect(sanitizeForSpeech('## Summary')).toBe('Summary');
    expect(sanitizeForSpeech('> quoted')).toBe('quoted');
    expect(sanitizeForSpeech('- first\n* second\n- [x] done')).toBe('first second done');
    expect(sanitizeForSpeech('1. one\n2) two')).toBe('one two');
  });

  it('says a link rather than spelling out a URL, and a path by its name', () => {
    expect(sanitizeForSpeech('see https://example.com/a/b?c=1 for more')).toBe(
      'see a link for more',
    );
    expect(sanitizeForSpeech('edited [the docs](https://example.com)')).toBe('edited the docs');
    expect(sanitizeForSpeech('changed C:\\Users\\me\\weft\\mobile\\src\\App.tsx today')).toBe(
      'changed App.tsx today',
    );
  });

  it('says nothing for a horizontal rule or a table separator row', () => {
    expect(sanitizeForSpeech('---')).toBe('');
    expect(sanitizeForSpeech('| --- | --- |')).toBe('');
  });

  it('announces a fenced block once instead of reading the code', () => {
    const text = 'Here you go:\n```ts\nconst x = 1;\nconsole.log(x);\n```\nThat is it.';
    expect(sanitizeForSpeech(text)).toBe('Here you go: code block. That is it.');
  });
});

describe('createSpeechSanitizer tracks a fence across streaming chunks', () => {
  it('keeps swallowing code when the fence opens in one chunk and closes in another', () => {
    const s = createSpeechSanitizer();
    expect(s.sanitize('Try this:')).toBe('Try this:');
    expect(s.sanitize('```js')).toBe('code block.');
    expect(s.sanitize('const noisy = true;')).toBe('');
    expect(s.sanitize('```')).toBe('');
    expect(s.sanitize('Done.')).toBe('Done.');
  });

  it('reset drops a half-open fence so an abandoned reply cannot swallow the next one', () => {
    const s = createSpeechSanitizer();
    s.sanitize('```js');
    s.reset();
    expect(s.sanitize('A fresh answer.')).toBe('A fresh answer.');
  });
});
