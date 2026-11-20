import { describe, expect, it } from 'vitest';
import { draftInfo, partialString } from '../src/agent/draft.js';

describe('reading a tool call that is still being written', () => {
  it('decodes a string field that stops part way, escapes included', () => {
    expect(partialString('{"path":"src/a.ts","content":"line 1\\nline \\"2\\"\\t', 'content')).toBe(
      'line 1\nline "2"\t',
    );
    expect(partialString('{"content":"caf\\u00e9 done"}', 'content')).toBe('café done');
    expect(partialString('{"content":"half an escape \\', 'content')).toBe('half an escape ');
    expect(partialString('{"content":"\\u00', 'content')).toBe('');
    expect(partialString('{"path":"a', 'content')).toBeUndefined();
  });

  it('says what the call acts on, and shows the end of what it writes', () => {
    const json = '{"path":"css/os.css","content":"body {\\n  margin: 0;\\n}\\n.window {\\n  display: fl';
    expect(draftInfo(json)).toEqual({ target: 'css/os.css', tail: '}\n.window {\n  display: fl' });
    expect(draftInfo('{"command":"npm test\\nnpm run lint')).toEqual({
      target: 'npm test',
      tail: 'npm test\nnpm run lint',
    });
    expect(draftInfo('{"pa')).toEqual({});
  });
});
