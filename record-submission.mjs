#!/usr/bin/env node
/**
 * record-submission.mjs — "Ho inviato" lands in the canonical tracker.
 *
 * The queue is Caronte's working register; the tracker is where follow-ups,
 * replies, interviews and statistics start from. Until now `submitted` in the
 * queue went nowhere, so a posting handled by the panel was invisible to
 * everything downstream. This closes the gap through the paths that already
 * exist, not around them:
 *
 *   1. reserve a report number (reserve-report-num.mjs, under the tracker lock)
 *   2. write a short report with the analysis and the JD archived verbatim
 *   3. drop a tracker addition TSV, status Evaluated
 *   4. node merge-tracker.mjs   — dedup by URL, lock, atomic write
 *   5. node set-status.mjs N Applied   — status log + first follow-up seeded
 *
 * Usage:
 *   node record-submission.mjs --slug acme-analyst
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readQueue } from './apply-queue.mjs';
import { loadAnalysis, scoreFit } from './analyze.mjs';
import { loadJd } from './triage.mjs';
import { reserveReportNumbers, releaseReportNumbers, formatReportNumber } from './reserve-report-num.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The report body: what the panel knew, in the shape the rest of the system reads. */
export function renderReport({ id, row, analysis, jd, date }) {
  const fit = analysis ? scoreFit(analysis) : null;
  const score = row.score === '' ? 'N/A' : `${Number(row.score).toFixed(1)}/5`;
  const lines = [
    `# Evaluation: ${row.company} — ${row.role}`,
    '',
    `**Date:** ${date}`,
    `**URL:** ${row.url}`,
    `**Archetype:** ${row.archetype || 'n/a'}`,
    `**Score:** ${score}`,
    '**Legitimacy:** Unverified (Caronte)',
    `**PDF:** ${row.pack === 'built' ? `✅ output/apply/${row.slug}/` : '❌ (no pack built)'}`,
    '',
    '---',
    '',
    '## A) Role Summary',
    '',
    '| | |',
    '|---|---|',
    `| Company | ${row.company} |`,
    `| Role | ${row.role} |`,
    `| Location | ${row.location || 'n/a'} |`,
    `| Level (triage) | ${row.level || 'n/a'} |`,
    `| Summary line | ${row.summary_line && row.summary_line !== 'n/a' ? row.summary_line : 'n/a'} |`,
    '',
  ];
  if (analysis) {
    lines.push('## B) Match with CV + Gaps', '');
    lines.push(fit.blocked
      ? `**Not reachable:** ${fit.blockers.join('; ')}`
      : `**Fit:** ${fit.percent}% over ${fit.total} requirements (heuristic, not a hiring probability).`);
    lines.push('');
    for (const r of analysis.requisiti || []) {
      lines.push(`- ${r.stato}${r.bloccante ? ' (bloccante)' : ''}${r.citato === false ? ' (non citato alla lettera)' : ''}: "${r.testo}"${r.perche ? ` — ${r.perche}` : ''}`);
    }
    if ((analysis.agganci || []).length) {
      lines.push('', '**Hooks with a fact behind them:**', '');
      for (const a of analysis.agganci) lines.push(`- ${a.punto} → ${a.fatto}`);
    }
    lines.push('', '## Verdict', '', analysis.sintesi || 'n/a', '');
  }
  lines.push('## Post-evaluation', '', `Applied on ${date} from the Caronte panel. Documents: output/apply/${row.slug}/`, '');
  lines.push('## Job Description (archived verbatim)', '');
  lines.push(jd || '_The posting text could not be fetched (jd_failed); it was read on screen during the apply session._');
  lines.push('');
  return lines.join('\n');
}

/** The tracker addition, header form: fields resolved by name, never by position. */
export function renderAddition({ id, row, date, reportFile }) {
  const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  const score = row.score === '' ? 'N/A' : `${Number(row.score).toFixed(1)}/5`;
  const header = ['num', 'date', 'company', 'role', 'status', 'score', 'pdf', 'report', 'notes', 'url'];
  const values = [
    id, date, cell(row.company), cell(row.role), 'Evaluated', score,
    row.pack === 'built' ? '✅' : '❌',
    `[${id}](reports/${reportFile})`,
    `Caronte: candidatura inviata dal pannello; documenti in output/apply/${row.slug}/`,
    cell(row.url),
  ];
  return `${header.join('\t')}\n${values.join('\t')}\n`;
}

/**
 * Run a core script against the same data root, stated explicitly: every
 * path the child could resolve on its own is handed to it, so a script that
 * still falls back to its own directory cannot touch another tracker.
 */
function runScript(script, args, root) {
  const r = spawnSync(process.execPath, [resolve(__dirname, script), ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      CAREER_OPS_ROOT: root,
      CAREER_OPS_TRACKER: resolve(root, 'data', 'applications.md'),
      CAREER_OPS_ADDITIONS: resolve(root, 'batch', 'tracker-additions'),
    },
  });
  return { code: r.status ?? -1, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

/**
 * Record one sent application. Returns {num, report}. Throws with the failing
 * step in the message; the queue row is the caller's business and is never
 * touched here, because "sent" is true whether or not the bookkeeping worked.
 */
export async function recordSubmission(slug, { root = getCareerOpsRoot() } = {}) {
  const row = readQueue(resolve(root, 'data', 'apply-queue.tsv')).find((r) => r.slug === slug);
  if (!row) throw new Error(`nessuna riga con slug "${slug}"`);
  if (!String(row.company || '').trim() || !String(row.role || '').trim() || !String(row.url || '').trim()) {
    throw new Error(`${slug}: servono azienda, ruolo e URL per registrare la candidatura nel tracker`);
  }
  const date = new Date().toISOString().slice(0, 10);
  // The returned array carries the ownership token release needs: keep it whole.
  const reserved = await reserveReportNumbers(1);
  const num = reserved[0];
  const id = formatReportNumber(num);
  const reportFile = `${id}-${slug}-${date}.md`;
  const reportPath = resolve(root, 'reports', reportFile);
  const additionPath = resolve(root, 'batch', 'tracker-additions', `${id}-${slug}.tsv`);
  try {
    mkdirSync(dirname(reportPath), { recursive: true });
    mkdirSync(dirname(additionPath), { recursive: true });
    writeFileSync(reportPath, renderReport({ id, row, analysis: loadAnalysis(slug, root), jd: loadJd(slug), date }));
    writeFileSync(additionPath, renderAddition({ id, row, date, reportFile }));
  } catch (err) {
    await releaseReportNumbers(reserved).catch(() => {});
    throw err;
  }
  // The report file now holds the number; the sentinel has done its job.
  await releaseReportNumbers(reserved).catch(() => {});

  const merge = runScript('merge-tracker.mjs', [], root);
  if (merge.code !== 0) throw new Error(`merge-tracker è uscito con codice ${merge.code}:\n${merge.output}`);

  // merge-tracker dedups by URL: a posting evaluated earlier through the skill
  // keeps its own number, so the row to flip may not be `id`. Fall back to the
  // company name, and let a real ambiguity surface rather than guess.
  let status = runScript('set-status.mjs', [id, 'Applied', '--note', `inviata il ${date} via Caronte`], root);
  if (status.code === 2) status = runScript('set-status.mjs', [row.company, 'Applied', '--note', `inviata il ${date} via Caronte`], root);
  if (status.code !== 0) throw new Error(`set-status è uscito con codice ${status.code}:\n${status.output}`);

  return { num: id, report: reportPath };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const slug = args.includes('--slug') ? args[args.indexOf('--slug') + 1] : null;
  if (!slug) { console.error('Usage: node record-submission.mjs --slug <slug>'); process.exit(1); }
  try {
    const r = await recordSubmission(slug);
    console.log(`Registrata nel tracker come #${r.num}; report: ${r.report}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
