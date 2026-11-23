// A fast drop-in for makefun-site 1.0.0.
//
// Same answers as the reference, byte for byte, on every case — same front
// matter rules, same template dialect, same Markdown subset, same slug rule,
// same report — but built to spend as little CPU as possible doing it:
//   * the Markdown body is scanned once, block by block, straight to HTML,
//     with inline marks handled by jumping from one special character to the
//     next instead of walking every character through a regex escape;
//   * templates are parsed once per case into a small node tree and walked by
//     a tight interpreter that appends to an array and joins once;
//   * an include whose template only ever reads the site, the tag list or the
//     recent posts is rendered once per case (per include depth) and reused,
//     since those three values never change between pages;
//   * slugs are cached per case, and words are counted by a plain scan instead
//     of a match that allocates an array of every word.
//
// No network, no clock, no randomness, no file access, no cache carried from
// one case to the next: every per-case cache is built fresh inside run().

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
// The characters a backslash may escape inside inline Markdown.
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
// The characters the inline scanner must stop at: a backslash, a code or
// emphasis mark, a link bracket, or one of the HTML escape table's keys.
const SPECIAL_RE = /[\\`*\[&<>"']/g;
const WS_RE = /\s/;
const RESERVED_DIRS = ['posts', 'tags', 'page'];
const MAX_SLUG = 64;

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  let out = '';
  let from = 0;
  ESC_RE.lastIndex = 0;
  let m;
  while ((m = ESC_RE.exec(text)) !== null) {
    out += text.slice(from, m.index) + ESCAPES[m[0]];
    from = m.index + 1;
  }
  if (from === 0) return text;
  return out + text.slice(from);
}

/** Whether code unit `c` is JavaScript whitespace (the \s set). */
function isWs(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, cut to 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Pure-ASCII text skips the normalisation: NFKD is the identity on it.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (ascii) {
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let k = -1;
      if (c >= 65 && c <= 90) k = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) k = c;
      if (k === -1) { if (out.length > 0) gap = true; continue; }
      if (gap) { out += '-'; gap = false; }
      out += String.fromCharCode(k);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let gap = false;
    for (const ch of plain) {
      let k = null;
      if (ch >= 'A' && ch <= 'Z') k = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) k = ch;
      if (k === null) { if (out.length > 0) gap = true; continue; }
      if (gap) { out += '-'; gap = false; }
      out += k;
    }
  }
  out = out.slice(0, MAX_SLUG).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  let n = 2;
  while (taken.has(out)) { out = `${slug}-${n}`; n++; }
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** How many words `text` holds: its runs of characters other than whitespace. */
function wordCount(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWs(text.charCodeAt(i))) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** The directory of `path` ("" at the root). */
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/**
 * `rel` (a link's path, "/"-separated) resolved from the directory `dir` of a
 * source, or null when it climbs out of the root.
 */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_LAYOUT = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringValue(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function keyValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringValue(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_LAYOUT.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` holds only spaces and tabs (or is empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Lines are walked by
 * index so the body is never split and re-joined.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let lineNo = 2;
  let closeAt = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeAt = pos;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = firstNl === -1 ? text.length : firstNl + 1;
  lineNo = 2;
  while (pos < closeAt) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? closeAt : nl;
    const line = text.slice(pos, end);
    if (!isBlank(line) && line.charCodeAt(0) !== 35) {
      // "key: value": a key of a-z and _, a colon, one space and the value.
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || c === 95)) break;
        k++;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` };
      const rest = line.slice(k + 1);
      if (rest !== '' && rest.charCodeAt(0) !== 32) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, k);
      let raw = rest === '' ? '' : rest.slice(1);
      let e = raw.length;
      while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
      raw = raw.slice(0, e);
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = keyValue(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1 || nl >= closeAt) break;
    pos = nl + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  let bodyAt = closeAt + 3;
  if (text.charCodeAt(bodyAt) === 10) bodyAt++;
  return { data, body: text.slice(bodyAt) };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `src[a..b)` holds only spaces and tabs. */
function onlySpaceTab(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag's line goes with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') { tokens.push({ t: 'text', text }); text = ''; }
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = onlySpaceTab(src, lineStart, open) && onlySpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') { tokens.push({ t: 'text', text }); text = ''; }
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** Node kinds: 0 text, 1 var, 2 raw, 3 if, 4 for, 5 include. */
function parseTemplate(name, src) {
  const root = { k: 0, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ k: 0, s: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ k: tok.t === 'var' ? 1 : 2, p: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { k: 4, name: m[1], p: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { k: 3, not: m[1] !== undefined, p: pathOf(name, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.k !== 3 || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 4 : 3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === 0 ? parent.body : parent.k === 4 ? parent.body : parent.els ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ k: 5, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 4 ? 'for' : 'if'} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain, or undefined. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += textOf(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A template rendered once per (name, depth) with the case's root scope, for
 * templates whose output never varies between pages; the string is reused.
 */
function constRender(t, depth, ctx) {
  const key = `${t.name}#${depth}`;
  let s = ctx.constCache.get(key);
  if (s === undefined) {
    const out = [];
    renderNodes(t.nodes, ctx.rootScope, ctx, depth, out);
    s = out.join('');
    ctx.constCache.set(key, s);
  }
  return s;
}

/**
 * A template rendered once per (name, depth, the values its free roots resolve
 * to in the calling scope) and reused: an include's output is a function of
 * exactly those values and the depth, so the same values at the same depth
 * always render the same string. Values are keyed by identity for objects
 * and by value for primitives; a template that reads `loop` is never
 * memoised, since a loop record is one object mutated across elements.
 */
function memoRender(t, scope, depth, ctx) {
  const vals = t.roots.map((r) => lookup(scope, [r]));
  let node = ctx.incCache.get(t.name);
  if (node === undefined) {
    node = new Map();
    ctx.incCache.set(t.name, node);
  }
  let level = node.get(depth);
  if (level === undefined) {
    level = new Map();
    node.set(depth, level);
  }
  for (let i = 0; i < vals.length - 1; i++) {
    let next = level.get(vals[i]);
    if (next === undefined) {
      next = new Map();
      level.set(vals[i], next);
    }
    level = next;
  }
  const last = vals[vals.length - 1];
  let s = level.get(last);
  if (s === undefined) {
    const parts = [];
    renderNodes(t.nodes, scope, ctx, depth, parts);
    s = parts.join('');
    level.set(last, s);
  }
  return s;
}

/** `nodes` rendered in `scope`, appending to `out`. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.k) {
      case 0:
        out.push(n.s);
        break;
      case 1:
        out.push(escapeHtml(textOf(lookup(scope, n.p))));
        break;
      case 2:
        out.push(textOf(lookup(scope, n.p)));
        break;
      case 3: {
        const v = truthy(lookup(scope, n.p));
        const branch = v !== n.not ? n.then : n.els;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 4: {
        const xs = lookup(scope, n.p);
        if (Array.isArray(xs)) {
          // One frame and one loop record per run of the loop, mutated per
          // element: rendering only ever reads them, so sharing them across
          // elements cannot change a single byte of output.
          const frame = { vars: {}, parent: scope };
          const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
          frame.vars[n.name] = xs[0];
          frame.vars.loop = loop;
          for (let k = 0; k < xs.length; k++) {
            if (k > 0) {
              frame.vars[n.name] = xs[k];
              loop.index = k + 1;
              loop.first = false;
              loop.last = k === xs.length - 1;
            }
            renderNodes(n.body, frame, ctx, depth, out);
          }
        }
        break;
      }
      case 5: {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < 8) {
          if (t.constant) out.push(constRender(t, depth + 1, ctx));
          else if (n.memo) out.push(memoRender(t, scope, depth + 1, ctx));
          else renderNodes(t.nodes, scope, ctx, depth + 1, out);
        }
        break;
      }
    }
  }
}

/** The root names `nodes` reads outside the fors that bind them. */
function freeRoots(nodes, bound) {
  const out = new Set();
  for (const n of nodes) {
    if (n.k === 1 || n.k === 2 || n.k === 3 || n.k === 4) {
      if (!bound.has(n.p[0])) out.add(n.p[0]);
    }
    if (n.k === 4) {
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      for (const r of freeRoots(n.body, inner)) out.add(r);
    } else if (n.k === 3) {
      for (const r of freeRoots(n.then, bound)) out.add(r);
      if (n.els !== null) for (const r of freeRoots(n.els, bound)) out.add(r);
    }
  }
  return out;
}

/** Every name a for loop binds anywhere in `nodes`. */
function boundNames(nodes, out) {
  for (const n of nodes) {
    if (n.k === 4) {
      out.add(n.name);
      boundNames(n.body, out);
    } else if (n.k === 3) {
      boundNames(n.then, out);
      if (n.els !== null) boundNames(n.els, out);
    }
  }
  return out;
}

/** Every template name `nodes` includes, directly. */
function includedNames(nodes, out) {
  for (const n of nodes) {
    if (n.k === 5) out.add(n.name);
    else if (n.k === 4) includedNames(n.body, out);
    else if (n.k === 3) {
      includedNames(n.then, out);
      if (n.els !== null) includedNames(n.els, out);
    }
  }
  return out;
}

/**
 * Marks each include node with whether memoising it can ever hit: every root
 * the included template reads must be the site, the tag list or the recent
 * posts, or a name an enclosing for loop binds at that point (a loop element
 * repeats across renders; a page, pager or tag is fresh every render and
 * would never hit). A template that reads `loop` is never memoised: a loop
 * record is one object mutated across elements.
 */
function annotateIncludes(nodes, bound, ctx) {
  for (const n of nodes) {
    if (n.k === 4) {
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      annotateIncludes(n.body, inner, ctx);
    } else if (n.k === 3) {
      annotateIncludes(n.then, bound, ctx);
      if (n.els !== null) annotateIncludes(n.els, bound, ctx);
    } else if (n.k === 5) {
      const t = ctx.templates.get(n.name);
      n.memo =
        t !== undefined &&
        !t.roots.includes('loop') &&
        t.roots.every((r) => r === 'site' || r === 'tags' || r === 'recent' || bound.has(r));
    }
  }
}

// ---------------------------------------------------------------- Markdown

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** A fence's language, or null when `line` does not open one. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    j++;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let j = 0;
  while (j < 6 && line.charCodeAt(j) === 35) j++;
  if (j === 0) return null;
  const c = line.charCodeAt(j);
  if (c !== 32 && c !== 9) return null;
  let k = j;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  let end = line.length;
  while (end > k && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === k) return null;
  return { depth: j, text: line.slice(k, end) };
}

/** The text after a bullet marker ("- " or "* "), or null. */
function bulletText(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered list's number and item text, or null. */
function orderedText(line) {
  let j = 0;
  while (j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j < line.length && !isWs(line.charCodeAt(j));
}

/**
 * What block `line` starts, in one pass over its first characters, so a
 * paragraph line costs one call instead of six: 0 blank, 1 fence, 2 heading,
 * 3 thematic break, 4 blockquote, 5 bullet item, 6 ordered item, 7 anything else.
 */
function lineKind(line) {
  const c = line.charCodeAt(0);
  if (c !== c) return 0;
  if (c === 32 || c === 9) {
    for (let i = 1; i < line.length; i++) {
      const d = line.charCodeAt(i);
      if (d !== 32 && d !== 9) return 7;
    }
    return 0;
  }
  switch (c) {
    case 96: {
      if (line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return 7;
      let j = 3;
      while (j < line.length) {
        const d = line.charCodeAt(j);
        if (!((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95 || d === 43 || d === 45)) break;
        j++;
      }
      for (let k = j; k < line.length; k++) {
        const d = line.charCodeAt(k);
        if (d !== 32 && d !== 9) return 7;
      }
      return 1;
    }
    case 35: {
      let j = 0;
      while (j < 6 && line.charCodeAt(j) === 35) j++;
      const d = line.charCodeAt(j);
      if (d !== 32 && d !== 9) return 7;
      let k = j;
      while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
      let e = line.length;
      while (e > k && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
      return e > k ? 2 : 7;
    }
    case 45:
    case 42: {
      if (line.charCodeAt(1) === c && line.charCodeAt(2) === c) {
        for (let k = 3; k < line.length; k++) {
          const d = line.charCodeAt(k);
          if (d !== 32 && d !== 9) return 7;
        }
        return 3;
      }
      if (line.charCodeAt(1) === 32) return 5;
      return 7;
    }
    case 62:
      return 4;
    default: {
      if (c >= 48 && c <= 57) {
        let j = 0;
        while (j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
        if (j > 0 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) return 6;
      }
      return 7;
    }
  }
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  const k = lineKind(line);
  return k === 0 || k === 1 || k === 2 || k === 3;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` resolves a link's href. */
function inline(s, env, ctx) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    if (m === null) {
      out += s.slice(i);
      break;
    }
    const j = m.index;
    out += s.slice(i, j);
    const c = s[j];
    if (c === '&') { out += '&amp;'; i = j + 1; }
    else if (c === '<') { out += '&lt;'; i = j + 1; }
    else if (c === '>') { out += '&gt;'; i = j + 1; }
    else if (c === '"') { out += '&quot;'; i = j + 1; }
    else if (c === "'") { out += '&#39;'; i = j + 1; }
    else if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) { out += escapeHtml(s[j + 1]); i = j + 2; }
      else { out += '\\'; i = j + 1; }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) { out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`; i = k + 1; }
      else { out += '`'; i = j + 1; }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) { out += `<strong>${inline(s.slice(j + 2, k), env, ctx)}</strong>`; i = k + 2; }
        else { out += '**'; i = j + 2; }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) { out += `<em>${inline(s.slice(j + 1, k), env, ctx)}</em>`; i = k + 1; }
        else { out += '*'; i = j + 1; }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env, ctx)}</a>`;
        i = mm + 1;
      } else {
        out += '[';
        i = j + 1;
      }
    }
  }
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, ctx) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const kind = lineKind(line);
    if (kind === 0) { i++; continue; }
    if (kind === 1) {
      const lang = fenceLang(line);
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      let s = `<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>`;
      for (const l of body) { s += escapeHtml(l); s += '\n'; }
      s += '</code></pre>\n';
      blocks.push(s);
      continue;
    }
    if (kind === 2) {
      const hd = headingOf(line);
      const id = uniqueSlug(slugify(hd.text, ctx.slugCache), ids);
      const html = inline(hd.text, env, ctx);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (kind === 3) { blocks.push('<hr>\n'); i++; continue; }
    if (kind === 4) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        body.push(trimLine(l));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env, ctx)}</p>\n</blockquote>\n`);
      continue;
    }
    if (kind === 5 || kind === 6) {
      const isOrdered = kind === 6;
      const first = isOrdered ? orderedText(line) : bulletText(line);
      const items = [];
      while (i < n) {
        const m = isOrdered ? orderedText(lines[i]) : bulletText(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m.text : m)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && first.num !== 1 ? `<ol start="${first.num}">` : `<${tag}>`;
      let s = `${open}\n`;
      for (const it of items) s += `<li>${inline(it.join('\n'), env, ctx)}</li>\n`;
      s += `</${tag}>\n`;
      blocks.push(s);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env, ctx);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
function linkOf(s) {
  return s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const ctx = {
    slugCache: new Map(),
    constCache: new Map(),
    incCache: new Map(),
    templates: new Map(),
    rootScope: null,
  };
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      ctx.templates.set(name, { name, nodes: parseTemplate(name, input.templates[name]), constant: false });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // A template is constant when everything it (transitively) reads is the
  // site, the tag list or the recent posts, and no for loop anywhere binds
  // one of those names — then its output is the same on every page.
  {
    const suspect = new Set(['loop']);
    const ownRoots = new Map();
    const includes = new Map();
    for (const t of ctx.templates.values()) {
      ownRoots.set(t.name, freeRoots(t.nodes, new Set()));
      includes.set(t.name, includedNames(t.nodes, new Set()));
      boundNames(t.nodes, suspect);
    }
    const trans = new Map();
    for (const name of ownRoots.keys()) trans.set(name, new Set(ownRoots.get(name)));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [name, deps] of includes) {
        const acc = trans.get(name);
        for (const dep of deps) {
          const sub = trans.get(dep);
          if (sub === undefined) continue;
          for (const r of sub) {
            if (!acc.has(r)) { acc.add(r); changed = true; }
          }
        }
      }
    }
    for (const t of ctx.templates.values()) {
      const roots = trans.get(t.name);
      let ok = true;
      for (const r of roots) {
        if (r !== 'site' && r !== 'tags' && r !== 'recent') { ok = false; break; }
        if (suspect.has(r)) { ok = false; break; }
      }
      t.constant = ok;
      t.roots = [...roots].sort(byCodeUnits);
    }
    for (const t of ctx.templates.values()) annotateIncludes(t.nodes, new Set(), ctx);
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order: a refused source is reported and dropped,
  // and so is a draft; the first failing check is the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED_DIRS.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!ctx.templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug, made unique in its directory, in order.
  const bySource = new Map();
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED_DIRS : []));
      return taken.get(dir);
    };
    for (const s of kept) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, ctx.slugCache), takenIn(dir));
      s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
      s.url = `${base}/${s.outDir}/`;
      bySource.set(s.path, s);
    }
  }

  // Markdown: each body's HTML, its links resolved, its table of contents.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, ctx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, then by slug; neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTagNames = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, ctx.slugCache);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTagNames(p)) {
      const slug = slugify(name, ctx.slugCache);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTagNames(s).map((name) => {
      const slug = slugify(name, ctx.slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index and tag pages, statics.
  const output = {};
  const cards = new Map();
  const cardOf = (s) => {
    let c = cards.get(s);
    if (c === undefined) {
      c = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordCount(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cards.set(s, c);
    }
    return c;
  };
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  ctx.rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    const t = ctx.templates.get(name);
    if (t === undefined) return null;
    const out = [];
    renderNodes(t.nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) {
    const page = {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
