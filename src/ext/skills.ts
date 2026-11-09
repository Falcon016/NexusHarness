import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Skill {
  name: string;
  description: string;
  body: string;
  path: string;
  /** Where it came from: `built-in`, `user` or `project`. */
  source: string;
}

/** Skills shipped with NexusHarness (`skills/` beside `src/` and `dist/`). User and project skills override them. */
export const BUILTIN_SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');

/** Parse the tiny `---\nkey: value\n---` front-matter subset used by SKILL.md files. */
export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0)
      meta[line.slice(0, i).trim()] = line
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2]! };
}

export class SkillStore {
  private skills = new Map<string, Skill>();

  /** Later dirs override earlier ones (built-in first, then user skills, project skills last). */
  load(dirs: (string | { dir: string; source: string })[]): string[] {
    const warnings: string[] = [];
    this.skills.clear();
    for (const d of dirs) {
      const { dir, source } = typeof d === 'string' ? { dir: d, source: 'user' } : d;
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = join(dir, entry.name, 'SKILL.md');
        if (!existsSync(file)) continue;
        try {
          const { meta, body } = parseFrontMatter(readFileSync(file, 'utf8'));
          const name = meta.name || entry.name;
          if (!meta.description) {
            warnings.push(`Skill ${file} has no description and was skipped`);
            continue;
          }
          this.skills.set(name, {
            name,
            description: meta.description,
            body: body.trim(),
            path: file,
            source,
          });
        } catch (e) {
          warnings.push(`Could not load skill ${file}: ${(e as Error).message}`);
        }
      }
    }
    return warnings;
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }
  names(): string[] {
    return [...this.skills.keys()];
  }
  /**
   * A skill's instructions. When its folder holds more than SKILL.md (playbooks, scripts, templates), they are
   * listed at the end, to be read with `file` when a step needs one: a large skill costs context only for the
   * parts a task uses.
   */
  get(name: string): string | undefined {
    const s = this.skills.get(name);
    if (!s) return undefined;
    const files = this.files(name);
    const dir = dirname(s.path);
    return (
      `# Skill: ${s.name}\n\n${s.body}` +
      (files.length
        ? `\n\n---\nFiles in this skill (read one with the skill tool: name "${s.name}", file "<path>"):\n` +
          files.map((f) => `- ${f}`).join('\n') +
          `\nThey are in ${dir}. Run a script from there with bash (for example \`bash "${join(dir, 'scripts', '<script>')}"\`), ` +
          'or, in the container sandbox where that folder is not mounted, read it and run its text.'
        : '')
    );
  }

  /** Other files in a skill's folder, relative to it (no hidden files, at most 3 levels and 60 files). */
  files(name: string): string[] {
    const s = this.skills.get(name);
    if (!s) return [];
    const root = dirname(s.path);
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= 60 || e.name.startsWith('.')) continue;
        const p = join(dir, e.name);
        if (e.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (e.isFile() && p !== s.path) out.push(relative(root, p).replaceAll('\\', '/'));
      }
    };
    walk(root, 1);
    return out;
  }

  /** One file from a skill's folder. Paths that leave the folder (`..`, absolute, links out) are refused. */
  file(name: string, path: string): { text: string } | { error: string } {
    const s = this.skills.get(name);
    if (!s) return { error: `No skill named "${name}".` };
    const root = realpathSync(dirname(s.path));
    const target = resolve(root, path);
    if (!(target + sep).startsWith(root + sep) && target !== root)
      return { error: `"${path}" is outside the skill's folder.` };
    try {
      if (lstatSync(target).isSymbolicLink() || !realpathSync(target).startsWith(root + sep))
        return { error: `"${path}" is outside the skill's folder.` };
      const text = readFileSync(target, 'utf8');
      return { text: text.length > 60_000 ? `${text.slice(0, 60_000)}\n… (truncated)` : text };
    } catch {
      const have = this.files(name);
      return {
        error: `No file "${path}" in skill ${name}.${have.length ? ` It has: ${have.join(', ')}` : ''}`,
      };
    }
  }
}
