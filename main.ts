// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON edits), finds the lines each edit names at the first of
// three matching tiers (exact, trailing-whitespace-insensitive, then
// leading-and-trailing-whitespace-insensitive), and writes every change or
// none, printing what it changed or why it failed. SPEC.md is the contract.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files, lines and matching (SPEC.md sections 3 and 5)
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function fileState(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trimEndWs(line);
  return trimWs(line);
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Positions where O occurs in `lines` at one tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const want = o.map((l) => norm(l, tier));
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (norm(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (const tier of tiers(strict)) {
    const occ = occurrences(lines, o, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/**
 * One aligned old/new pair. A context line appears in both, linked by
 * index; every other old line is only in `o`, every other new line only
 * in `n`.
 */
interface Aligned {
  o: string[];
  n: string[];
  oCtx: boolean[];
  nCtx: boolean[];
  /** For each line of n, the index in o when it is a context line, else -1. */
  nToO: number[];
}

function alignedFromBody(items: { kind: string; text: string }[]): Aligned {
  const o: string[] = [];
  const n: string[] = [];
  const oCtx: boolean[] = [];
  const nCtx: boolean[] = [];
  const nToO: number[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      nToO.push(o.length);
      o.push(it.text);
      oCtx.push(true);
      n.push(it.text);
      nCtx.push(true);
    } else if (it.kind === 'old') {
      o.push(it.text);
      oCtx.push(false);
    } else if (it.kind === 'new') {
      nToO.push(-1);
      n.push(it.text);
      nCtx.push(false);
    }
  }
  return { o, n, oCtx, nCtx, nToO };
}

/**
 * The lines N becomes when it replaces O at `pos` in `fileLines` at
 * `tier`: context lines are the file's own matched lines; at tier 2 every
 * other line is re-indented from O's first line's leading whitespace to
 * the file's first matched line's.
 */
function transformN(a: Aligned, fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  if (a.o.length === 0) return a.n.slice();
  const p = leadingWs(a.o[0]!);
  const f = leadingWs(fileLines[pos]!);
  for (let j = 0; j < a.n.length; j += 1) {
    const line = a.n[j]!;
    if (a.nCtx[j]!) {
      out.push(fileLines[pos + a.nToO[j]!]!);
    } else if (tier === 2) {
      if (line !== '' && line.replace(/^[ \t]+$/, '') !== '' && line.startsWith(p)) out.push(f + line.slice(p.length));
      else out.push(line);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** The same re-indent for a plain old/new pair with no context lines. */
function transformPlain(o: string[], n: string[], fileLines: string[], pos: number, tier: number): string[] {
  return transformN({ o, n, oCtx: o.map(() => false), nCtx: n.map(() => false), nToO: n.map(() => -1) }, fileLines, pos, tier);
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  items: { kind: string; text: string }[];
  aligned: Aligned;
  backslashAfterLast: boolean;
}

interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  oldHdr: string | null;
  newHdr: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hasHdrPair: boolean;
  hunks: Hunk[];
}

function uniPath(line: string): string {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:$| .*)/.exec(line);
  if (m === null) return null;
  return Number(m[1]);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let current: UniSection | null = null;
  let i = 0;
  const fresh = (): UniSection => ({ gitOld: null, gitNew: null, oldHdr: null, newHdr: null, renameFrom: null, renameTo: null, isNew: false, isDeleted: false, hasHdrPair: false, hunks: [] });
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec = fresh();
      sec.gitOld = m[1]!;
      sec.gitNew = m[2]!;
      sections.push(sec);
      current = sec;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (current !== null && current.hunks.length === 0 && !current.hasHdrPair) {
        current.oldHdr = uniPath(line);
        current.newHdr = uniPath(lines[i + 1]!);
        current.hasHdrPair = true;
        i += 2;
        continue;
      }
      const sec = fresh();
      sec.oldHdr = uniPath(line);
      sec.newHdr = uniPath(lines[i + 1]!);
      sec.hasHdrPair = true;
      sections.push(sec);
      current = sec;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (current === null || current.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (current === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const items: { kind: string; text: string }[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') {
          items.push({ kind: 'ctx', text: '' });
          j += 1;
        } else if (l[0] === ' ') {
          items.push({ kind: 'ctx', text: l.slice(1) });
          j += 1;
        } else if (l[0] === '-') {
          items.push({ kind: 'old', text: l.slice(1) });
          j += 1;
        } else if (l[0] === '+') {
          items.push({ kind: 'new', text: l.slice(1) });
          j += 1;
        } else if (l[0] === '\\') {
          items.push({ kind: 'backslash', text: l.slice(1) });
          j += 1;
        } else break;
      }
      while (items.length > 0 && items[items.length - 1]!.kind === 'ctx' && items[items.length - 1]!.text === '') items.pop();
      // The flag is about the hunk's last context or + line.
      let backslashAfterLast = false;
      for (let k = items.length - 1; k >= 0; k -= 1) {
        if (items[k]!.kind === 'ctx' || items[k]!.kind === 'new') {
          backslashAfterLast = items[k + 1] !== undefined && items[k + 1]!.kind === 'backslash';
          break;
        }
      }
      current.hunks.push({ a, items, aligned: alignedFromBody(items), backslashAfterLast });
      i = j;
      continue;
    }
    if (current !== null && current.hunks.length === 0) {
      if (line.startsWith('rename from ')) current.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) current.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) current.isNew = true;
      else if (line.startsWith('deleted file mode')) current.isDeleted = true;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function applyHunks(state: FileState, hunks: Hunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const hunk of hunks) {
    const a = hunk.aligned;
    if (a.o.length === 0) {
      const insertPos = Math.min(Math.max(hunk.a + d, 0), state.lines.length);
      const atEnd = insertPos === state.lines.length;
      const add = a.n.slice();
      state.lines.splice(insertPos, 0, ...add);
      if (atEnd) state.final = !hunk.backslashAfterLast;
      d += a.n.length;
      continue;
    }
    const found = findTier(state.lines, a.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const runsToEnd = pos + a.o.length === state.lines.length;
    const repl = transformN(a, state.lines, pos, found.tier);
    state.lines.splice(pos, a.o.length, ...repl);
    if (runsToEnd) state.final = !hunk.backslashAfterLast;
    d += a.n.length - a.o.length;
  }
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  const oldRaw = sec.oldHdr ?? sec.renameFrom ?? sec.gitOld;
  const newRaw = sec.newHdr ?? sec.renameTo ?? sec.gitNew;
  const isCreate = oldRaw === '/dev/null' || sec.isNew;
  const isDelete = newRaw === '/dev/null' || sec.isDeleted;
  return (tree) => {
    if (isCreate) {
      const path = newRaw ?? '';
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const plus: string[] = [];
      let lastBackslash = false;
      for (const hunk of sec.hunks) {
        let hasNew = false;
        for (const it of hunk.items) {
          if (it.kind === 'new') {
            plus.push(it.text);
            hasNew = true;
          }
        }
        if (hasNew) lastBackslash = hunk.backslashAfterLast;
      }
      // A created file ends with a line break unless a \ line follows its
      // last + line; with no + lines at all the file is empty.
      const text = plus.length === 0 ? '' : plus.join('\n') + (lastBackslash ? '' : '\n');
      tree.now.set(path, text);
      return;
    }
    if (isDelete) {
      const path = oldRaw ?? '';
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    const oldPath = oldRaw ?? '';
    const newPath = newRaw ?? '';
    if (oldPath !== newPath) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const state = fileState(before);
      applyHunks(state, sec.hunks, oldPath, strict);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, joinFile(state));
      tree.moves.push({ from: oldPath, to: newPath });
      return;
    }
    const path = oldPath;
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const state = fileState(before);
    applyHunks(state, sec.hunks, path, strict);
    tree.now.set(path, joinFile(state));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (blocks.length === 0) throw new Exit2(`error: parse ${s + 1}`);
      path = blocks[blocks.length - 1]!.path;
    }
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const state = fileState(before);
    const found = findTier(state.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length !== 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const repl = transformPlain(b.oldLines, b.newLines, state.lines, pos, found.tier);
    state.lines.splice(pos, b.oldLines.length, ...repl);
    tree.now.set(b.path, joinFile(state));
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4Chunk {
  anchor: string;
  body: string[];
  eof: boolean;
}

type V4Section =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4Chunk[]; updateLine: number };

function isV4SectionStart(line: string): boolean {
  return line.startsWith('*** Add File:') || line.startsWith('*** Delete File:') || line.startsWith('*** Update File:');
}

function v4Edits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4Section[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      const content: string[] = [];
      i += 1;
      while (i < last && !isV4SectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l.startsWith('+')) {
          content.push(l.slice(1));
          i += 1;
        } else if (l === '') {
          content.push('');
          i += 1;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      sections.push({ kind: 'add', path, lines: content });
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      sections.push({ kind: 'delete', path });
      i += 1;
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i += 1;
      }
      const chunks: V4Chunk[] = [];
      let current: V4Chunk | null = null;
      while (i < last) {
        const l = lines[i]!;
        if (isV4SectionStart(l)) break;
        if (l.startsWith('@@')) {
          if (current !== null) chunks.push(current);
          current = { anchor: l.slice(2).trim(), body: [], eof: false };
          i += 1;
          continue;
        }
        if (l === '*** End of File') {
          if (current === null) throw new Exit2(`error: parse ${i + 1}`);
          current.eof = true;
          chunks.push(current);
          current = null;
          i += 1;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (current === null) {
            // Only the first chunk may start at a body line; after a
            // chunk ended with *** End of File a body line is an error.
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            current = { anchor: '', body: [], eof: false };
          }
          current.body.push(l);
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (current !== null) chunks.push(current);
      if (chunks.length > 0) {
        const tail = chunks[chunks.length - 1]!;
        while (tail.body.length > 0) {
          const b = tail.body[tail.body.length - 1]!;
          if (b === '' || b === ' ') tail.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ kind: 'update', path, moveTo, chunks, updateLine });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => v4Edit(sec, strict));
}

function v4Edit(sec: V4Section, strict: boolean): Edit {
  if (sec.kind === 'add') {
    const path = sec.path;
    const content = sec.lines;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    const path = sec.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  const path = sec.path;
  const moveTo = sec.moveTo;
  const chunks = sec.chunks;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const state = fileState(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== '') {
        let foundPos: number | null = null;
        for (const tier of tiers(strict)) {
          for (let k = cursor; k < state.lines.length; k += 1) {
            if (norm(state.lines[k]!, tier) === norm(chunk.anchor, tier)) {
              foundPos = k;
              break;
            }
          }
          if (foundPos !== null) break;
        }
        if (foundPos === null) throw new Fail('no-match', path);
        cursor = foundPos + 1;
      }
      const items = chunk.body.map((l): { kind: string; text: string } => {
        if (l === '') return { kind: 'ctx', text: '' };
        if (l[0] === ' ') return { kind: 'ctx', text: l.slice(1) };
        if (l[0] === '-') return { kind: 'old', text: l.slice(1) };
        return { kind: 'new', text: l.slice(1) };
      });
      const a = alignedFromBody(items);
      if (a.o.length === 0) {
        const insertPos = chunk.eof ? state.lines.length : cursor;
        state.lines.splice(insertPos, 0, ...a.n.slice());
        cursor = insertPos + a.n.length;
        continue;
      }
      let found: { tier: number; occ: number[] } | null = null;
      for (const tier of tiers(strict)) {
        const occ: number[] = [];
        for (let k = cursor; k + a.o.length <= state.lines.length; k += 1) {
          if (chunk.eof && k + a.o.length !== state.lines.length) continue;
          let ok = true;
          for (let j = 0; j < a.o.length; j += 1) {
            if (norm(state.lines[k + j]!, tier) !== norm(a.o[j]!, tier)) {
              ok = false;
              break;
            }
          }
          if (ok) occ.push(k);
        }
        if (occ.length > 0) {
          found = { tier, occ };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const pos = found.occ[0]!;
      const repl = transformN(a, state.lines, pos, found.tier);
      state.lines.splice(pos, a.o.length, ...repl);
      cursor = pos + repl.length;
    }
    const text = joinFile(state);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

// ---------------------------------------------------------------------------
// Command line, output and exit codes (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4Edits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const m of beforeMoves) tree.moves.push(m);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: a moved file is one `R <old> -> <new>` line, sorting by
  // the new path, replacing that pair's `D` and `A` lines.
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const rPairs: { old: string; nw: string }[] = [];
  for (const m of tree.moves) {
    let old = m.from;
    let nw = m.to;
    for (let guard = 0; guard < tree.moves.length + 2; guard += 1) {
      const prev = tree.moves.find((x) => x.to === old);
      if (prev === undefined) break;
      old = prev.from;
    }
    for (let guard = 0; guard < tree.moves.length + 2; guard += 1) {
      const next = tree.moves.find((x) => x.from === nw);
      if (next === undefined) break;
      nw = next.to;
    }
    if (usedOld.has(old) || usedNew.has(nw)) continue;
    if (tree.original(old) !== null && tree.original(nw) === null && tree.get(old) === null && tree.get(nw) !== null) {
      rPairs.push({ old, nw });
      usedOld.add(old);
      usedNew.add(nw);
    }
  }
  const rows: { key: string; text: string }[] = [];
  for (const p of changed) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const r of rPairs) rows.push({ key: r.nw, text: `R ${r.old} -> ${r.nw}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
