#!/usr/bin/env node
/**
 * build-packs.mjs — render the CV and cover letter for every queued role.
 *
 * No role gets a CV written from scratch. Each one gets the base CV closest to
 * its archetype, with only the Professional Summary line swapped for the one
 * triage wrote against that posting. The cover letter is the part that is
 * genuinely per-role.
 *
 * Usage:
 *   node build-packs.mjs                  # build every row with score >= threshold and pack=pending
 *   node build-packs.mjs --slug acme-ai   # build one row
 *   node build-packs.mjs --threshold 4.0  # override the score gate
 */
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readQueue, writeQueue, upsertRow } from './apply-queue.mjs';
import { renderHtmlToPdf } from './generate-pdf.mjs';
import { buildHtml as buildCoverHtml } from './generate-cover-letter.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE = resolve(getCareerOpsRoot(), 'data', 'apply-queue.tsv');

/** Escape text destined for an HTML text node. */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Pick the base CV for an archetype, falling back to the required default entry. */
export function pickCvVariant(archetype, variants) {
  const want = String(archetype || '').trim().toLowerCase();
  const hit = variants.find((v) => v.archetype.toLowerCase() === want && v.archetype !== 'default');
  if (hit) return hit;
  const fallback = variants.find((v) => v.archetype === 'default');
  if (!fallback) throw new Error('cv-variants.yml has no default entry');
  return fallback;
}

/**
 * Replace the Professional Summary line. An empty or n/a line leaves the CV untouched.
 *
 * The replace has no /g flag ON PURPOSE: one summary slot is the contract. A CV
 * with two <div class="summary-text"> blocks is a broken CV, and silently
 * filling both would hide that. Do not "fix" this by adding /g.
 */
export function injectSummary(html, line) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'n/a') return html;
  return html.replace(
    /(<div class="summary-text">)([\s\S]*?)(<\/div>)/,
    `$1${escapeHtml(trimmed)}$3`,
  );
}

/** Whether a base CV has the slot injectSummary needs to land the tailored line. */
export function hasSummarySlot(html) {
  return /<div class="summary-text">/.test(html);
}

/** Absolute output directory for one role's pack. */
export function packDir(slug) {
  return resolve(getCareerOpsRoot(), 'output', 'apply', slug);
}

/**
 * Assemble the cover-letter payload for one role.
 *
 * Only the opening and the profile intro are per-role. The achievements come
 * from cover-base.json, which is derived from cv.md and never invented here:
 * a generated letter must not contain a claim the CV cannot support.
 */
export function buildCoverPayload(row, base) {
  const summary = String(row.summary_line || '').trim();
  const usable = summary && summary.toLowerCase() !== 'n/a';
  return {
    candidate: base.candidate,
    letter: {
      role_title: row.role,
      company: row.company,
      date: new Date().toISOString().slice(0, 10),
      greeting: 'Hello,',
      opening: `I am applying for the ${row.role} role at ${row.company}.`,
      profile_intro: usable ? `${summary} ${base.profile_intro}` : base.profile_intro,
      achievements: base.achievements,
      closing: base.closing,
    },
  };
}

/**
 * Choose which rows to build, honouring the candidate's batch size.
 *
 * Highest score first, capped at `limit`, and never padded: a row below the
 * threshold is not built to reach the number. Rows that are already built, or
 * that triage has not scored yet, are never selected.
 *
 * Nor is a row the candidate discarded. A high score is the model's opinion and
 * `apply` is the candidate's, and the candidate's is the one that decides
 * whether a CV and a letter are worth rendering.
 */
export function selectTargets(rows, { limit, threshold = 3.5 } = {}) {
  const qualifying = rows
    .filter((r) => r.pack === 'pending' && r.score !== '' && Number(r.score) >= threshold
      && r.apply !== 'skipped' && r.apply !== 'dead')
    .sort((a, b) => Number(b.score) - Number(a.score));
  return limit === undefined ? qualifying : qualifying.slice(0, Math.max(0, limit));
}

/**
 * Minimal reader for the variants list in cv-variants.yml.
 *
 * An entry with `archetype:` but no `html:` used to be dropped silently by the
 * two-line regex, so that archetype fell through to `default` and the candidate
 * mailed a generic CV while the console said ✅. A malformed entry throws now.
 */
export function loadVariants(path = resolve(__dirname, 'cv-variants.yml')) {
  if (!existsSync(path)) {
    throw new Error(`${path} is missing. Copy cv-variants.example.yml to cv-variants.yml and point it at your own CV files.`);
  }
  const text = readFileSync(path, 'utf-8');
  const variants = [];
  let current = null;
  for (const line of text.split('\n')) {
    const a = line.match(/^\s*-\s*archetype:\s*(.+)$/);
    if (a) { current = { archetype: yamlValue(a[1]), html: '' }; variants.push(current); continue; }
    const h = line.match(/^\s*html:\s*(.+)$/);
    if (h && current && !current.html) current.html = yamlValue(h[1]);
  }
  if (!variants.length) throw new Error(`no variants parsed from ${path}`);
  for (const v of variants) {
    if (!v.html) throw new Error(`${path}: archetype "${v.archetype}" has no html: path — every archetype must name a base CV.`);
  }
  return variants;
}

/** One scalar YAML value: quoted as written, unquoted minus any trailing ` # comment`. */
function yamlValue(raw) {
  const quoted = String(raw).match(/^\s*(["'])([\s\S]*?)\1/);
  return quoted ? quoted[2] : String(raw).replace(/\s+#.*$/, '').trim();
}

/** Build one pack. Returns the updated row. */
export async function buildPack(row, variants) {
  // Without a company and a role there is no letter to write: the opening
  // renders "I am applying for the  role at ." and the apply session's identity
  // gate has nothing to check the page against. Fail the row instead.
  if (!String(row.company || '').trim() || !String(row.role || '').trim()) {
    throw new Error(
      `${row.slug}: the row has no company and/or no role, so the cover letter would name neither and ` +
      'the identity gate would have nothing to check. Fill them in data/apply-queue.tsv, or drop the row.',
    );
  }
  const dir = packDir(row.slug);
  mkdirSync(dir, { recursive: true });

  const variant = pickCvVariant(row.archetype, variants);
  const basePath = resolve(__dirname, variant.html);
  if (!existsSync(basePath)) throw new Error(`base CV missing: ${variant.html}`);

  const baseHtml = readFileSync(basePath, 'utf-8');
  const summary = String(row.summary_line || '').trim();
  const usableSummary = summary && summary.toLowerCase() !== 'n/a';
  if (usableSummary && !hasSummarySlot(baseHtml)) {
    throw new Error(
      `${variant.html} has no <div class="summary-text"> — the tailored summary cannot be injected. ` +
      `Add the div to the CV or point this archetype at a different file in cv-variants.yml.`,
    );
  }

  const html = injectSummary(baseHtml, row.summary_line);
  const cvHtmlPath = resolve(dir, 'cv.html');
  const cvPdfPath = resolve(dir, 'cv.pdf');
  const { writeFileSync } = await import('fs');
  writeFileSync(cvHtmlPath, html);
  await renderHtmlToPdf(html, cvPdfPath, { format: 'a4', baseDir: dirname(basePath), htmlPath: cvHtmlPath });

  const base = JSON.parse(readFileSync(resolve(__dirname, 'cover-base.json'), 'utf-8'));
  const coverHtml = buildCoverHtml(buildCoverPayload(row, base));
  const coverPdfPath = resolve(dir, 'cover.pdf');
  await renderHtmlToPdf(coverHtml, coverPdfPath, { format: 'a4', baseDir: __dirname });

  return { ...row, pack: 'built' };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const slugArg = args.includes('--slug') ? args[args.indexOf('--slug') + 1] : null;
  const threshold = args.includes('--threshold') ? Number(args[args.indexOf('--threshold') + 1]) : 3.5;
  const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : undefined;
  const variants = loadVariants();
  let rows = readQueue(QUEUE);

  const targets = slugArg
    ? rows.filter((r) => r.slug === slugArg)
    : selectTargets(rows, { limit, threshold });
  if (!targets.length) { console.log('Nothing to build.'); process.exit(0); }

  // Say so plainly rather than quietly lowering the bar to hit the number.
  if (limit !== undefined && targets.length < limit) {
    const qualifying = selectTargets(rows, { threshold }).length;
    console.log(`You asked for ${limit}. Only ${qualifying} roles score ${threshold} or above, so I am building ${targets.length}.`);
    console.log('I am not lowering the threshold to reach the number. Run scan.mjs for more supply, or pass --threshold to change the bar deliberately.\n');
  }

  for (const row of targets) {
    try {
      const next = await buildPack(row, variants);
      rows = upsertRow(rows, next);
      console.log(`✅ ${row.slug} → ${packDir(row.slug)}`);
    } catch (err) {
      rows = upsertRow(rows, { ...row, pack: 'failed' });
      console.log(`❌ ${row.slug}: ${err.message}`);
    }
    writeQueue(QUEUE, rows);
  }
}
