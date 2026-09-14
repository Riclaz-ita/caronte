#!/usr/bin/env node
/**
 * apply-queue.mjs — the single state machine for the apply pipeline.
 *
 * Every stage reads and writes data/apply-queue.tsv and nothing else, so any
 * stage can crash and resume: state lives in the file, never in memory.
 *
 * Usage:
 *   node apply-queue.mjs --list                 # print the queue
 *   node apply-queue.mjs --validate             # exit 1 if any row is malformed
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

export const QUEUE_COLUMNS = [
  'slug', 'url', 'company', 'role', 'location', 'archetype',
  'level', 'score', 'summary_line', 'pack', 'apply', 'date',
];

export const PACK_STATES = ['pending', 'built', 'failed', 'jd_failed'];
// 'partial' means: build the documents, then stop. The role never reaches the
// form phase, so the candidate reads the generated CV and letter before
// anything is typed into a company's website. It is a decision, not a failure.
// 'queued' is the state every imported row starts in: in the queue, nobody has
// decided anything yet. 'chosen' is the candidate saying yes to this one.
// Keeping them apart is what lets a front-end show "still to decide" honestly;
// collapsing them made every freshly imported row look like a deliberate pick.
export const APPLY_STATES = ['queued', 'chosen', 'partial', 'opened', 'submitted', 'skipped', 'dead'];

/** Collapse anything that would corrupt a TSV cell. */
function cell(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

/** Read the queue, returning [] when the file does not exist yet. */
export function readQueue(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const fields = line.split('\t');
      const row = {};
      QUEUE_COLUMNS.forEach((col, i) => { row[col] = fields[i] ?? ''; });
      row.score = row.score === '' ? '' : Number(row.score);
      return row;
    });
}

/** Write the queue, neutralising any tab or newline inside a value. */
export function writeQueue(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  const body = rows.map((r) => QUEUE_COLUMNS.map((c) => cell(r[c])).join('\t')).join('\n');
  writeFileSync(path, `# ${QUEUE_COLUMNS.join('\t')} — written by apply-queue.mjs, do not edit by hand\n${body}\n`);
}

/** Replace the row with the same slug, or append it. Returns a new array. */
export function upsertRow(rows, row) {
  const i = rows.findIndex((r) => r.slug === row.slug);
  if (i === -1) return [...rows, row];
  const next = [...rows];
  next[i] = row;
  return next;
}

/** Return a list of human-readable problems with a row; empty means valid. */
export function validateRow(row) {
  const problems = [];
  if (!cell(row.slug)) problems.push('slug is empty');
  if (!cell(row.url)) problems.push('url is empty');
  // company and role are the identity the apply session checks the page
  // against and the cover letter names. A row with neither disables the
  // identity gate and renders "the  role at ." — so once a row has moved past
  // import, both are mandatory.
  if (row.pack !== 'pending') {
    if (!cell(row.company)) problems.push('company is empty (needed once the row leaves pending)');
    if (!cell(row.role)) problems.push('role is empty (needed once the row leaves pending)');
  }
  if (!PACK_STATES.includes(row.pack)) problems.push(`pack state "${row.pack}" is not one of ${PACK_STATES.join('/')}`);
  if (!APPLY_STATES.includes(row.apply)) problems.push(`apply state "${row.apply}" is not one of ${APPLY_STATES.join('/')}`);
  if (row.score !== '' && (Number.isNaN(Number(row.score)) || Number(row.score) < 1 || Number(row.score) > 5)) {
    problems.push(`score ${row.score} is outside 1-5`);
  }
  return problems;
}

/** Validate a complete queue for integrity: all rows valid, slugs unique. */
export function validateQueue(rows) {
  const problems = [];
  const seen = new Set();
  for (const r of rows) {
    const rowProblems = validateRow(r);
    problems.push(...rowProblems);
    if (seen.has(r.slug)) problems.push(`duplicate slug: "${r.slug}"`);
    seen.add(r.slug);
  }
  return problems;
}

/**
 * Extract the pending entries from data/pipeline.md.
 *
 * Pending lines are variable width: a bare `- [ ] {url}` is valid, and the
 * scanner adds `| {company} | {title}` plus optional `| {location}` and
 * `| {compensation}`. Only `- [ ]` counts: `- [x]` is processed and `- [!]` is
 * an entry that could not be read.
 */
export function parsePipeline(text) {
  const pendingSection = String(text).split(/^## Processed/m)[0];
  return pendingSection
    .split('\n')
    .filter((line) => line.startsWith('- [ ] '))
    .map((line) => {
      const [url, company = '', role = '', location = ''] = line.slice(6).split('|').map((p) => p.trim());
      return { url, company, role, location };
    })
    .filter((e) => e.url);
}

/**
 * Turn pipeline entries into fresh queue rows, untriaged and unbuilt.
 *
 * `takenSlugs` must carry the slugs already in the queue. The slug is the pack
 * directory name, so two postings that collide on it overwrite each other's CV
 * and cover letter — and a repost is exactly that: same company, same title,
 * new URL. De-duping only within one batch let the second repost land on the
 * first one's directory and mutate its row.
 */
export function rowsFromPipeline(entries, today, takenSlugs = []) {
  const taken = new Set(takenSlugs);
  return entries.map((e) => {
    const base = slugify(e.company && e.role ? `${e.company} ${e.role}` : e.url);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    return {
      slug,
      url: e.url, company: e.company, role: e.role, location: e.location,
      archetype: '', level: '', score: '', summary_line: '',
      pack: 'pending', apply: 'queued', date: today,
    };
  });
}

/**
 * Fold text into the one shape the focus filter compares against.
 *
 * Accents, case and punctuation all collapse, and the result is padded with a
 * space at each end so a leading space is a whole word boundary.
 */
function normalise(text) {
  return ` ${String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/**
 * Turn what the candidate typed into the groups the filter uses.
 *
 * Two separators, because a filter needs two answers. A comma adds a
 * requirement: "part time, marketing" wants both. A pipe offers a way of
 * meeting one: "part time | tempo parziale" wants either wording. So groups are
 * ANDed and the alternatives inside a group are ORed, which is what makes
 * ticking both "Part time" and "Full time" mean "either" rather than "neither".
 */
export function parseFocus(text) {
  return String(text || '')
    .split(',')
    .map((group) => group.split('|').map((t) => normalise(t).trim()).filter(Boolean))
    .filter((group) => group.length);
}

/**
 * Say a parsed focus back in words, for the confirmation to show.
 *
 * A group with alternatives gets brackets. Without them the list flattens into
 * "part time o tempo parziale e milano", which reads as three equal options and
 * hides the fact that Milano is a separate requirement.
 */
export function describeFocus(groups) {
  return groups
    .map((alts) => (alts.length > 1 ? `(${alts.join(' o ')})` : alts[0]))
    .join(' e ');
}

/**
 * Whether one posting answers every term of the focus.
 *
 * `jdText` is part of the haystack when there is one: "part time" is almost
 * never in a title, it is in the third paragraph of the description. At import
 * time there is no description on disk yet, so the filter sees the company,
 * the role and the location, which are what the scanner wrote into
 * pipeline.md. A term must start a word and may run past its end: "market"
 * catches marketing and marketer, while "intern" does not catch "external".
 */
export function matchesFocus(row, jdText, groups) {
  if (!groups.length) return true;
  const hay = normalise(`${row.role} ${row.company} ${row.location} ${jdText || ''}`);
  return groups.every((alts) => alts.some((t) => hay.includes(` ${t}`)));
}

/**
 * Narrow a batch of pipeline entries down to a limit, a portal at a time.
 *
 * Taking the first N off the list would hand back N postings from whichever
 * board answers first: of the 270 postings the scanner had ever found, Ashby
 * and Greenhouse accounted for 78% between them, so "give me five" meant five
 * Ashby postings every time. This deals them round-robin instead — one per
 * host, then round again — so five postings come from up to five boards.
 *
 * Order inside a host is left alone: the scanner appends what it finds, so
 * file order is the closest thing to recency that pipeline.md carries. There
 * is no posting date in an entry to sort on.
 *
 * A limit of `undefined` means no limit. A malformed URL is its own host
 * rather than an exception: a bad line should cost its own slot, not the run.
 */
export function pickAcrossPortals(entries, limit) {
  if (limit === undefined || limit === null || limit >= entries.length) return [...entries];
  if (limit <= 0) return [];

  const byHost = new Map();
  for (const entry of entries) {
    let host;
    try { host = new URL(entry.url).host; } catch { host = String(entry.url); }
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(entry);
  }

  const queues = [...byHost.values()];
  const picked = [];
  for (let round = 0; picked.length < limit; round++) {
    let servedThisRound = false;
    for (const queue of queues) {
      if (round >= queue.length) continue;
      picked.push(queue[round]);
      servedThisRound = true;
      if (picked.length === limit) return picked;
    }
    if (!servedThisRound) break;
  }
  return picked;
}

/** Filesystem-safe id. Mirrors jdSlug in fetch-jds.mjs; kept local so this module has no imports. */
function slugify(text) {
  const s = String(text).toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 80) || 'untitled';
}

if (isMainModule(import.meta.url)) {
  const { resolve } = await import('path');
  const { fileURLToPath } = await import('url');
  const here = dirname(fileURLToPath(import.meta.url));
  const QUEUE = resolve(getCareerOpsRoot(), 'data', 'apply-queue.tsv');
  const args = process.argv.slice(2);
  const rows = readQueue(QUEUE);

  if (args.includes('--import-pipeline')) {
    const { readFileSync } = await import('fs');
    const pipelinePath = resolve(getCareerOpsRoot(), 'data', 'pipeline.md');
    const entries = parsePipeline(readFileSync(pipelinePath, 'utf-8'));

    const flag = (name) => {
      const i = args.indexOf(name);
      return i === -1 ? undefined : args[i + 1];
    };
    const rawLimit = flag('--limit');
    const limit = rawLimit === undefined ? undefined : Math.max(0, Number(rawLimit) || 0);
    const groups = parseFocus(flag('--focus'));

    // De-dupe by url, then filter, then deal a portal at a time. Whatever is
    // left stays `- [ ]` in pipeline.md: nothing here rewrites that file, so
    // the remainder is the inbox the next run serves from without rescanning.
    const known = new Set(rows.map((r) => r.url));
    const fresh = entries.filter((e) => !known.has(e.url));
    const focused = groups.length ? fresh.filter((e) => matchesFocus(e, '', groups)) : fresh;
    const chosen = pickAcrossPortals(focused, limit);

    const added = rowsFromPipeline(
      chosen,
      new Date().toISOString().slice(0, 10),
      rows.map((r) => r.slug),
    );
    writeQueue(QUEUE, [...rows, ...added]);

    const portals = new Set(added.map((r) => { try { return new URL(r.url).host; } catch { return r.url; } }));
    const parts = [`Imported ${added.length} new rows from ${portals.size} portals`];
    if (groups.length) parts.push(`focus "${describeFocus(groups)}" kept ${focused.length} of ${fresh.length} fresh`);
    if (limit !== undefined && focused.length > added.length) parts.push(`${focused.length - added.length} left pending for the next run`);
    parts.push(`${entries.length} pending, ${entries.length - fresh.length} already in the queue`);
    console.log(`${parts.join('; ')}.`);
  } else if (args.includes('--list')) {
    for (const r of rows) {
      console.log(`${String(r.score).padStart(4)}  ${r.pack.padEnd(10)} ${r.apply.padEnd(10)} ${r.company} — ${r.role}`);
    }
    console.log(`\n${rows.length} rows`);
  } else if (args.includes('--validate')) {
    const problems = validateQueue(rows);
    if (problems.length) {
      for (const p of problems) console.log(`  ${p}`);
      process.exit(1);
    }
    console.log(`${rows.length} rows, all valid`);
    process.exit(0);
  } else if (args.includes('--set')) {
    const slug = args[args.indexOf('--set') + 1];
    const assignment = args[args.indexOf('--set') + 2] || '';
    const [key, value] = assignment.split('=');
    if (!slug || !key || value === undefined) {
      console.error('Usage: node apply-queue.mjs --set <slug> <column>=<value>');
      process.exit(1);
    }
    if (!QUEUE_COLUMNS.includes(key)) { console.error(`Unknown column "${key}"`); process.exit(1); }
    if (key === 'slug') { console.error(`slug is the row identity and cannot be changed`); process.exit(1); }
    const row = rows.find((r) => r.slug === slug);
    if (!row) { console.error(`No row with slug "${slug}"`); process.exit(1); }
    const next = { ...row, [key]: value };
    const problems = validateRow(next);
    if (problems.length) { console.error(problems.join('; ')); process.exit(1); }
    writeQueue(QUEUE, upsertRow(rows, next));
    console.log(`${slug}: ${key} = ${value}`);
  } else {
    console.error('Usage: node apply-queue.mjs --import-pipeline [--limit N] [--focus "terms"] | --list | --validate | --set <slug> <column>=<value>');
    process.exit(1);
  }
}
