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
    // De-dupe by url first, then mint slugs against the slugs already in the
    // queue so a repost gets its own pack directory instead of the original's.
    const known = new Set(rows.map((r) => r.url));
    const added = rowsFromPipeline(
      entries.filter((e) => !known.has(e.url)),
      new Date().toISOString().slice(0, 10),
      rows.map((r) => r.slug),
    );
    writeQueue(QUEUE, [...rows, ...added]);
    console.log(`Imported ${added.length} new rows from ${pipelinePath} (${entries.length} pending, ${entries.length - added.length} already in the queue).`);
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
    console.error('Usage: node apply-queue.mjs --import-pipeline | --list | --validate | --set <slug> <column>=<value>');
    process.exit(1);
  }
}
