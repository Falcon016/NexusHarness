/**
 * Text from outside (command output, model replies, file contents) made safe to draw: what reaches the terminal
 * must be exactly what Ink measured, or its redraws drift and leave copies behind.
 *
 * - Escape sequences are removed. Colours would only be lost, but cursor moves and line clears (progress bars,
 *   `git clone`, `npm install`) move the real cursor under Ink.
 * - A carriage return inside a line keeps what a terminal would end up showing: the text after the last one.
 * - Tabs become spaces up to the next stop of 4: Ink counts a tab as no width, the terminal as up to 8.
 * - Other control characters are dropped.
 */
const ESCAPES =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const TAB = 4;

export function cleanText(s: string): string {
  if (!/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(s)) return s; // the usual case: nothing to do
  return s
    .replace(ESCAPES, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (line.includes('\r')) {
        const parts = line.split('\r').filter((p) => p.length);
        line = parts.at(-1) ?? '';
      }
      line = line.replace(CONTROLS, '');
      if (!line.includes('\t')) return line;
      let out = '';
      for (const ch of line) out += ch === '\t' ? ' '.repeat(TAB - (out.length % TAB)) : ch;
      return out;
    })
    .join('\n');
}
