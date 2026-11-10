import { describe, expect, it } from 'vitest';
import { cleanText } from '../src/tui/clean.js';
import { drawColumns } from '../src/tui/size.js';

describe('text cleaned for drawing', () => {
  it('leaves ordinary text alone', () => {
    const s = 'Hello — naïve café 🚀\nsecond line';
    expect(cleanText(s)).toBe(s);
  });

  it('removes colours, cursor moves, line clears and terminal titles', () => {
    expect(cleanText('\x1b[31mred\x1b[0m \x1b[1;4mbold\x1b[m')).toBe('red bold');
    expect(cleanText('up\x1b[1A\x1b[2Kover')).toBe('upover');
    expect(cleanText('\x1b]0;my title\x07after')).toBe('after');
    expect(cleanText('\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\')).toBe('link');
  });

  it('keeps what a terminal would show after carriage returns', () => {
    expect(cleanText('progress 10%\rprogress 55%\rprogress 100%\ndone')).toBe('progress 100%\ndone');
    expect(cleanText('windows line\r\nnext\r\n')).toBe('windows line\nnext\n');
    expect(cleanText('trailing\r')).toBe('trailing');
  });

  it('turns tabs into spaces up to the next stop of 4', () => {
    expect(cleanText('\tx')).toBe('    x');
    expect(cleanText('ab\tc\t\td')).toBe('ab  c       d');
    expect(cleanText('target:\n\t$(CC) main.c')).toBe('target:\n    $(CC) main.c');
  });

  it('drops other control characters', () => {
    expect(cleanText('a\x00b\x07c\x08d\x7fe\x85f')).toBe('abcdef');
  });
});

describe('draw width', () => {
  it('never uses the last column', () => {
    expect(drawColumns(80)).toBe(79);
    expect(drawColumns(120)).toBe(119);
    expect(drawColumns(10)).toBe(20); // a floor for absurdly small windows
  });
});
