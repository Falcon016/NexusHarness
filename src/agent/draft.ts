/**
 * What a tool call is about while the model is still writing it. Its arguments arrive as JSON a few characters
 * at a time; a large file can take many minutes to write on a local model, and without this the screen would
 * show nothing but a spinner for all of it.
 */

/** Fields that say what the call acts on, in order of preference. */
const TARGET_KEYS = ['path', 'file_path', 'url', 'command', 'pattern', 'query', 'name'];
/** Fields whose text is worth previewing as it is written. */
const BODY_KEYS = ['content', 'new_string', 'command', 'text', 'code', 'script'];

/**
 * The value of a string field in JSON that may stop in the middle of it, decoded. Undefined when the field has
 * not started yet. Only top-level-looking `"key": "` occurrences are matched; good enough for a preview.
 */
export function partialString(json: string, key: string): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (!m) return undefined;
  let out = '';
  for (let i = m.index + m[0].length; i < json.length; i++) {
    const c = json[i]!;
    if (c === '"') return out;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = json[i + 1];
    if (n === undefined) return out; // an escape cut in half
    i++;
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === 'b' || n === 'f') continue;
    else if (n === 'u') {
      const hex = json.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += n; // \" \\ \/
  }
  return out;
}

export interface DraftInfo {
  /** The file, URL or command the call acts on, as far as it is written. */
  target?: string;
  /** The last few lines of what it is writing (file contents, a replacement, a script). */
  tail?: string;
}

export function draftInfo(json: string, tailLines = 3): DraftInfo {
  const out: DraftInfo = {};
  for (const k of TARGET_KEYS) {
    const v = partialString(json, k);
    if (v?.trim()) {
      out.target = v.split('\n')[0]!.slice(0, 200);
      break;
    }
  }
  let body: string | undefined;
  for (const k of BODY_KEYS) {
    const v = partialString(json, k);
    if (v && v.length > (body?.length ?? 0)) body = v;
  }
  if (body?.trim()) {
    const lines = body.replace(/\s+$/, '').split('\n');
    out.tail = lines.slice(-tailLines).join('\n');
  }
  return out;
}
