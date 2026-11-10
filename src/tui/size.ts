import { useWindowSize } from 'ink';

/**
 * The size the UI draws in: the window, less its last column.
 *
 * Nothing may be drawn in the last column. Terminals differ on what writing there does: most wait for the next
 * character before wrapping, but the classic Windows console (and some others) move the cursor to the next line
 * at once, so a full-width line takes two rows there. Ink redraws the live area by moving up as many rows as it
 * drew lines; every full-width line then leaves a row of the previous frame behind, which shows up as repeated
 * text and runs of blank lines in scrollback.
 */
export function drawColumns(columns: number): number {
  return Math.max(20, columns - 1);
}

export function useDrawSize(): { columns: number; rows: number } {
  const { columns, rows } = useWindowSize();
  return { columns: drawColumns(columns), rows };
}
