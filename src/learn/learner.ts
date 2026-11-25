import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontMatter } from '../ext/skills.js';
import { redact } from '../util/redact.js';
import {
  FailureWatch,
  LESSON_NOTE,
  LessonFile,
  lessonPaths,
  modelFamily,
  parseReflection,
  promptBlock,
  reflectionPrompt,
  tokensOf,
  type Lesson,
} from './lessons.js';

/**
 * Self-improvement without training (docs/learning.md): lessons from tool calls that failed and were fixed, and
 * skills saved from long tasks that went well. Everything learned that goes into the prompt shares one token
 * budget, is fixed for the whole session, and can be seen and deleted with /lessons.
 */

export interface LearningConfig {
  enabled: boolean;
  /** Tokens of the system prompt that learned lessons and learned skills may take, together. */
  budget: number;
  /** Lessons kept per project and per model family. */
  maxLessons: number;
  /** Offer to save a skill after a task that took at least this many tool calls and ended well; 0: never. */
  skillAfterCalls: number;
}

export interface LearnedSkill {
  name: string;
  description: string;
  dir: string;
  created: number;
  uses: number;
  lastUsed: number;
}

interface SkillStats {
  created: number;
  uses: number;
  lastUsed: number;
}

/** What the session's prompt carries, fixed when the session starts. */
interface Frozen {
  session: string;
  block: string;
  lessonIds: Set<string>;
  skills: Set<string>;
}

/** How a turn went, for deciding whether to offer a skill. */
interface Tally {
  calls: number;
  failures: number;
  /** Consecutive calls that worked, at the end. */
  cleanTail: number;
  skillsUsed: Set<string>;
  /** A short account of the calls, for the skill draft. */
  steps: string[];
}

const DAY = 86_400_000;
const skillName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

export class Learner {
  private project: LessonFile;
  private model: LessonFile;
  private family: string;
  private readonly watch = new FailureWatch();
  private frozen?: Frozen;
  /** Lessons handed over at a failure this turn (once each), and those whose recurrence was counted this session. */
  private hintedThisTurn = new Set<string>();
  private recurredThisSession = new Set<string>();
  private tally: Tally = this.emptyTally();
  /** The last turn that is worth saving as a skill, if any. */
  offer?: { calls: number; steps: string[]; update?: string; task: string };

  constructor(
    private cfg: LearningConfig,
    private readonly dataDir: string,
    private readonly projectKey: string,
    modelName: string,
  ) {
    this.family = modelFamily(modelName);
    const p = lessonPaths(dataDir, projectKey, this.family);
    this.project = new LessonFile(p.project, cfg.maxLessons);
    this.model = new LessonFile(p.model, cfg.maxLessons);
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  setConfig(cfg: LearningConfig): void {
    this.cfg = cfg;
  }

  get modelFamily(): string {
    return this.family;
  }

  /** The model changed: its family's lessons apply from the next session. */
  setModel(modelName: string): void {
    const family = modelFamily(modelName);
    if (family === this.family) return;
    this.family = family;
    this.model = new LessonFile(
      lessonPaths(this.dataDir, this.projectKey, family).model,
      this.cfg.maxLessons,
    );
  }

  /** Learned skills are kept per project, outside the project folder. */
  get skillsDir(): string {
    return join(this.dataDir, 'learning', 'skills', this.projectKey);
  }

  private files(): LessonFile[] {
    return [this.project, this.model];
  }

  allLessons(): (Lesson & { file: 'project' | 'model' })[] {
    return [
      ...this.project.lessons.map((l) => ({ ...l, file: 'project' as const })),
      ...this.model.lessons.map((l) => ({ ...l, file: 'model' as const })),
    ];
  }

  // ---- the prompt -------------------------------------------------------------------------------------

  /**
   * The learned part of the system prompt for this session: lessons first (up to 60% of the budget), then the
   * learned skills' one-line descriptions in what is left. Worked out once per session, so the prompt does not
   * change under the server's cache when something new is learned; new things apply from the next session.
   */
  freeze(sessionId: string, now = Date.now()): Frozen {
    if (this.frozen?.session === sessionId) return this.frozen;
    const budget = this.cfg.enabled ? this.cfg.budget : 0;
    const lessons = promptBlock(this.allLessons(), Math.floor(budget * 0.6), now);
    let left = budget - tokensOf(lessons.text);
    const skills = new Set<string>();
    for (const s of this.skills().sort((a, b) => b.uses - a.uses || b.lastUsed - a.lastUsed)) {
      const cost = tokensOf(`- ${s.name}: ${s.description}`) + 1;
      if (cost > left) continue;
      left -= cost;
      skills.add(s.name);
    }
    this.frozen = { session: sessionId, block: lessons.text, lessonIds: new Set(lessons.ids), skills };
    this.recurredThisSession.clear();
    return this.frozen;
  }

  /** Whether a learned skill is listed in this session's prompt (the others stay out of it). */
  listsSkill(name: string): boolean {
    return this.frozen?.skills.has(name) ?? false;
  }

  /** Tokens the learned part of the prompt takes this session. */
  promptTokens(skillLines: string[]): number {
    return tokensOf(this.frozen?.block ?? '') + skillLines.reduce((n, l) => n + tokensOf(l) + 1, 0);
  }

  // ---- watching tool calls ------------------------------------------------------------------------------

  /** A tool call finished. Returns text to add to its result: a lesson about this failure, when there is one. */
  observe(name: string, input: unknown, result: { content: string; isError?: boolean }): string {
    if (!this.cfg.enabled) return '';
    this.count(name, input, result);
    const trigger = this.watch.observe(name, input, result, (id) => this.touch(id, (l) => l.helped++));
    if (!trigger) return '';
    for (const f of this.files()) {
      const lesson = f.find(trigger);
      if (!lesson) continue;
      if (!this.recurredThisSession.has(lesson.id)) {
        this.recurredThisSession.add(lesson.id);
        // Its failure came back although the lesson exists: it gets a strike (a lesson that then helps earns
        // it back, one that does not is dropped after a few).
        f.update(lesson.id, (l) => {
          l.recurred++;
          l.lastSeen = Date.now();
        });
      }
      if (this.hintedThisTurn.has(lesson.id) || !f.get(lesson.id)) return '';
      this.hintedThisTurn.add(lesson.id);
      f.update(lesson.id, (l) => l.shown++);
      this.watch.hint(lesson.id, trigger);
      return `\n\n${LESSON_NOTE} ${lesson.text}`;
    }
    return '';
  }

  private touch(id: string, f: (l: Lesson) => void): void {
    for (const file of this.files())
      if (file.get(id))
        file.update(id, (l) => {
          f(l);
          l.lastSeen = Date.now();
        });
  }

  private count(name: string, input: unknown, result: { content: string; isError?: boolean }): void {
    if (name === 'todo_write') return;
    const t = this.tally;
    t.calls++;
    if (result.isError) {
      t.failures++;
      t.cleanTail = 0;
    } else t.cleanTail++;
    const i = (input ?? {}) as Record<string, unknown>;
    if (name === 'skill' && typeof i.name === 'string' && !result.isError) {
      t.skillsUsed.add(i.name);
      this.useSkill(i.name);
    }
    if (t.steps.length < 40) {
      const what =
        typeof i.command === 'string'
          ? i.command
          : typeof i.path === 'string'
            ? i.path
            : typeof i.pattern === 'string'
              ? i.pattern
              : '';
      t.steps.push(
        `${name}${what ? ` ${what.replace(/\s+/g, ' ').slice(0, 120)}` : ''}${result.isError ? ' (failed)' : ''}`,
      );
    }
  }

  private emptyTally(): Tally {
    return { calls: 0, failures: 0, cleanTail: 0, skillsUsed: new Set(), steps: [] };
  }

  // ---- end of turn --------------------------------------------------------------------------------------

  /** The request for lessons, when this turn fixed failures worth asking about. */
  reflection(): string | undefined {
    if (!this.cfg.enabled) return undefined;
    const episodes = this.newEpisodes();
    return episodes.length ? reflectionPrompt(episodes) : undefined;
  }

  /** Fixed failures there is no lesson for yet (one that has a lesson is judged by its counts instead). */
  private newEpisodes() {
    return this.watch.episodes.filter((e) => !this.files().some((f) => f.find(e.trigger)));
  }

  /** Store the lessons the model wrote. Returns them. */
  learn(answer: string): string[] {
    const episodes = this.newEpisodes();
    const lines = parseReflection(answer, episodes.length);
    const out: string[] = [];
    lines.forEach((text, n) => {
      const e = episodes[n];
      if (!text || !e) return;
      (e.scope === 'model' ? this.model : this.project).add(text, e.trigger, e.scope);
      out.push(text);
    });
    return out;
  }

  /**
   * The turn is over. Whether it is worth offering to save as a skill: many tool calls, it ended with calls that
   * worked, and it was not just a learned skill followed without trouble.
   */
  endTurn(task: string, ended: boolean): void {
    const t = this.tally;
    const learnedUsed = [...t.skillsUsed].find((s) => this.skills().some((k) => k.name === s));
    const long = this.cfg.skillAfterCalls > 0 && t.calls >= this.cfg.skillAfterCalls;
    if (this.cfg.enabled && ended && long && t.cleanTail >= 2 && (!learnedUsed || t.failures > 0))
      this.offer = { calls: t.calls, steps: t.steps, task, ...(learnedUsed ? { update: learnedUsed } : {}) };
    this.tally = this.emptyTally();
    this.watch.reset();
    this.hintedThisTurn.clear();
  }

  // ---- learned skills -----------------------------------------------------------------------------------

  skills(): LearnedSkill[] {
    const root = this.skillsDir;
    if (!existsSync(root)) return [];
    const out: LearnedSkill[] = [];
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = join(root, e.name);
      try {
        const { meta } = parseFrontMatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
        if (!meta.description) continue;
        const stats = this.stats(dir);
        out.push({ name: meta.name || e.name, description: meta.description, dir, ...stats });
      } catch {
        /* skipped */
      }
    }
    return out;
  }

  private stats(dir: string): SkillStats {
    try {
      return JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8')) as SkillStats;
    } catch {
      return { created: 0, uses: 0, lastUsed: 0 };
    }
  }

  private useSkill(name: string): void {
    const s = this.skills().find((k) => k.name === name);
    if (!s) return;
    writeFileSync(
      join(s.dir, 'stats.json'),
      JSON.stringify({ created: s.created, uses: s.uses + 1, lastUsed: Date.now() }),
    );
  }

  /** Learned skills not used for a while: /lessons suggests deleting them. */
  unusedSkills(now = Date.now()): LearnedSkill[] {
    return this.skills().filter((s) => now - Math.max(s.lastUsed, s.created) > 45 * DAY);
  }

  /** The request for a skill draft, from the turn on offer. */
  skillPrompt(): string | undefined {
    const o = this.offer;
    if (!o) return undefined;
    const existing = o.update ? this.skills().find((s) => s.name === o.update) : undefined;
    const body = existing ? readFileSync(join(existing.dir, 'SKILL.md'), 'utf8') : '';
    return (
      `[Learning] The user wants ${existing ? `the skill "${existing.name}" updated with` : 'a reusable skill saved from'} ` +
      `how the last task was done ("${o.task.slice(0, 200)}"). The tool calls were:\n` +
      o.steps.map((s) => `- ${s}`).join('\n') +
      (existing ? `\n\nThe skill as it is now:\n${body}` : '') +
      '\n\nWrite the skill as a SKILL.md file and nothing else, in this form:\n---\nname: short-kebab-case-name\n' +
      'description: one line, under 120 characters, saying when to use it\n---\n# Title\n\nSteps\n1. …\n\n' +
      'Pitfalls\n- what went wrong and how to avoid it\n\nKeep it general enough for the next similar task in ' +
      'this project, specific about commands and files that matter, and under 40 lines. No secrets. Do not call ' +
      'any tools.'
    );
  }

  /** Check a draft: its name and description, and that it holds nothing secret. */
  checkDraft(text: string): { name: string; description: string; body: string } | { error: string } {
    const clean = text
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/^\s*```(?:markdown|md)?\s*\n/, '')
      .replace(/\n```\s*$/, '')
      .trim();
    const { meta, body } = parseFrontMatter(clean);
    const name = skillName(meta.name ?? '');
    if (!name || !meta.description || !body.trim())
      return { error: 'The model did not write a usable skill (it needs a name, a description and steps).' };
    if (redact(clean) !== clean) return { error: 'The draft contained something that looks like a secret.' };
    return { name, description: meta.description.slice(0, 160), body: body.trim() };
  }

  /** Save a checked draft. */
  saveSkill(d: { name: string; description: string; body: string }): string {
    const dir = join(this.skillsDir, d.name);
    mkdirSync(dir, { recursive: true });
    const old = this.stats(dir);
    const tmp = join(dir, `.SKILL.md.${process.pid}.tmp`);
    writeFileSync(tmp, `---\nname: ${d.name}\ndescription: ${d.description}\n---\n\n${d.body}\n`);
    renameSync(tmp, join(dir, 'SKILL.md'));
    writeFileSync(
      join(dir, 'stats.json'),
      JSON.stringify({ created: old.created || Date.now(), uses: old.uses, lastUsed: old.lastUsed }),
    );
    this.offer = undefined;
    return join(dir, 'SKILL.md');
  }

  // ---- /lessons ---------------------------------------------------------------------------------------

  forget(id: string): boolean {
    return this.project.remove(id) || this.model.remove(id);
  }

  forgetSkill(name: string): boolean {
    const s = this.skills().find((k) => k.name === name);
    if (!s) return false;
    rmSync(s.dir, { recursive: true, force: true });
    return true;
  }

  forgetAll(): void {
    this.project.clear();
    this.model.clear();
  }
}
