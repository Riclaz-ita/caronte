#!/usr/bin/env node
/**
 * triage.mjs — batch many job descriptions into one judgement call.
 *
 * This script never calls a model. It assembles a prompt covering 30-40
 * postings and ingests the verdicts that come back, so no API key or provider
 * configuration enters the repo and the judgement stays next to the sources of
 * truth the agent already reads.
 *
 * Usage:
 *   node triage.mjs --batch                     # print the prompt for pending rows
 *   node triage.mjs --ingest verdicts.json      # write verdicts back into the queue
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readQueue, writeQueue } from './apply-queue.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { loadCandidateBrief } from './candidate-brief.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE = resolve(getCareerOpsRoot(), 'data', 'apply-queue.tsv');
const REQUIRED = ['slug', 'archetype', 'level', 'score', 'summary_line'];

/**
 * How much of one posting reaches the prompt.
 *
 * It used to be 4000 characters, which cut 20 of 21 live postings and threw
 * away 52k characters — and not evenly: a posting opens with the company
 * describing itself and closes with what it demands, so the requirements were
 * exactly the part that fell off the end. The score was being formed without
 * them. 16000 clears the longest posting in the corpus with room to spare; the
 * cap stays only so a pathological page cannot blow up the whole batch.
 */
export const JD_CHARS = 16000;

/** Build one prompt covering every entry in the batch. */
export function buildBatchPrompt(entries, brief = loadCandidateBrief()) {
  const header = [
    'Triage these job postings for an entry-level candidate.',
    '',
    'Candidate, in one line:',
    brief,
    '',
    'For EACH posting return: archetype, level, score and summary_line.',
    '',
    '- archetype: one of Agentic, AI Platform, Technical PM, Solutions Architect,',
    '  Forward Deployed, AI Transformation, Content, Marketing, Operations, Other',
    '- level: the REAL seniority the requirements demand (entry, junior, mid, senior, staff),',
    '  not the one in the title. A title without "Senior" that asks for 5 years is mid or senior.',
    '- score: 1-5 for this candidate specifically. Below 3 means do not apply.',
    '  Score 1 for ANY engineering-titled role (Software/Platform/Solutions/Forward Deployed/',
    '  Data/ML Engineer, Developer, Architect) or anything asking for a programming language:',
    '  these are unreachable, not stretches. Score down hard for a years-of-experience floor',
    '  he cannot meet, for pure sales or pre-sales roles, and for anything requiring a public',
    '  portfolio he does not have.',
    '- summary_line: ONE sentence, max 30 words, for the top of his CV, using this',
    "  posting's own vocabulary. It must describe only what is true of him from the",
    '  paragraph above. Never claim he writes, reads or debugs code, and never claim a',
    '  programming language. Never claim Make, n8n, Zapier or Power Automate. Never claim a',
    '  proven sales or marketing track record. Never invent experience, metrics or',
    '  authorship. If the role is a poor fit, set summary_line to "n/a".',
    '',
    'Return ONLY a JSON array, one object per posting, no prose around it:',
    '[{"slug":"...","archetype":"...","level":"...","score":0.0,"summary_line":"..."}]',
    '',
    '='.repeat(72),
  ].join('\n');

  const blocks = entries.map((e) => [
    '',
    `### slug: ${e.slug}`,
    `Company: ${e.company}`,
    `Role: ${e.role}`,
    `Location: ${e.location}`,
    '',
    e.jd.length > JD_CHARS ? `${e.jd.slice(0, JD_CHARS)}\n[...testo troncato a ${JD_CHARS} caratteri]` : e.jd,
    '',
    '-'.repeat(72),
  ].join('\n'));

  return `${header}${blocks.join('\n')}`;
}

/** Parse a verdict set, tolerating a fenced code block. Throws when malformed. */
/**
 * Whether a row still needs a verdict.
 *
 * Skipping the rows the candidate already threw out is not a nicety: triage is
 * the only phase that costs tokens, and scoring a posting he has ruled out
 * spends them to produce a number nobody will read.
 */
export function pendingTriage(row) {
  if (row.score !== '') return false;
  return row.apply !== 'skipped' && row.apply !== 'dead';
}

export function parseVerdicts(text) {
  const cleaned = String(text).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  let data;
  try { data = JSON.parse(cleaned); } catch { throw new Error('could not parse verdicts as JSON'); }
  if (!Array.isArray(data)) throw new Error('could not parse verdicts as JSON array');
  const seen = new Set();
  for (const v of data) {
    for (const key of REQUIRED) {
      if (!(key in v)) throw new Error(`verdict for "${v.slug ?? '?'}" is missing "${key}"`);
    }
    if (seen.has(v.slug)) throw new Error(`verdict set contains duplicate slug "${v.slug}"`);
    seen.add(v.slug);
    const n = Number(v.score);
    if (Number.isNaN(n) || n < 1 || n > 5) throw new Error(`verdict for "${v.slug}" has score ${v.score} outside 1-5`);
    v.score = n;
  }
  return data;
}

/** Write verdicts into their rows. Throws when a verdict names an unknown slug. */
export function ingestVerdicts(rows, verdicts) {
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  for (const v of verdicts) {
    if (!bySlug.has(v.slug)) throw new Error(`verdict names unknown slug "${v.slug}"`);
  }
  return rows.map((r) => {
    const v = verdicts.find((x) => x.slug === r.slug);
    if (!v) return r;
    return { ...r, archetype: v.archetype, level: v.level, score: v.score, summary_line: v.summary_line };
  });
}

/** Load the JD text written by fetch-jds.mjs, or '' when it is missing. */
export function loadJd(slug) {
  const path = resolve(getCareerOpsRoot(), 'jds', `${slug}.md`);
  if (!existsSync(path)) return '';
  const text = readFileSync(path, 'utf-8');
  const i = text.indexOf('\n---\n');
  return i === -1 ? text : text.slice(i + 5).trim();
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const rows = readQueue(QUEUE);
  if (args.includes('--batch')) {
    const pending = rows.filter(pendingTriage).filter((r) => loadJd(r.slug));
    if (!pending.length) { console.log('Nothing pending to triage.'); process.exit(0); }
    const entries = pending.slice(0, 40).map((r) => ({
      slug: r.slug, company: r.company, role: r.role, location: r.location, jd: loadJd(r.slug),
    }));
    console.log(buildBatchPrompt(entries));
  } else if (args.includes('--ingest')) {
    const file = args[args.indexOf('--ingest') + 1];
    if (!file) { console.error('--ingest needs a path to a JSON file'); process.exit(1); }
    const next = ingestVerdicts(rows, parseVerdicts(readFileSync(file, 'utf-8')));
    writeQueue(QUEUE, next);
    console.log(`Ingested ${parseVerdicts(readFileSync(file, 'utf-8')).length} verdicts into ${QUEUE}`);
  } else {
    console.error('Usage: node triage.mjs --batch | --ingest verdicts.json');
    process.exit(1);
  }
}
