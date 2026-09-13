#!/usr/bin/env node
/**
 * analyze.mjs — read one posting properly, instead of scoring twenty at once.
 *
 * The triage is a sift: twenty-one postings in one request, four fields back.
 * It is cheap and it is meant to be, because most of what it reads gets thrown
 * out. This is the other half: one posting, one request, and an answer long
 * enough to decide on.
 *
 * Three things come back, and the shape of each one is chosen so the candidate
 * can check the model rather than trust it:
 *
 *   - Every requirement is quoted from the posting VERBATIM, never paraphrased,
 *     so a wrong reading is visible next to its source.
 *   - The fit percentage is computed here, in JavaScript, from those quotes.
 *     A model asked for a number returns a mood; a number derived from a list
 *     the candidate can read is an argument.
 *   - Every hook the letter may use names the fact that backs it. A hook with
 *     no fact is dropped, not softened: the rule is that nothing written into
 *     an application may lack a source.
 *
 * Like triage.mjs, this module never calls a model. It builds a prompt and
 * ingests what comes back, so no API key enters the repo.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { loadCandidateBrief } from './candidate-brief.mjs';

/** Where one posting's analysis lives. Same slug as the queue row and the JD. */
export function analysisPath(slug, root = getCareerOpsRoot()) {
  return join(root, 'analyses', `${slug}.json`);
}

const STATI = ['soddisfatto', 'parziale', 'non soddisfatto'];

/**
 * Build the prompt for one posting.
 *
 * The candidate paragraph is the same one triage uses, loaded from the same
 * file: two descriptions of the same person would drift, and the one that
 * drifted would be the one nobody reread.
 */
export function buildAnalysisPrompt({ slug, company, role, location, jd }, brief = loadCandidateBrief()) {
  return [
    'Read this ONE job posting closely and answer for this candidate.',
    '',
    'Candidate:',
    brief,
    '',
    'Return ONLY a JSON object, no prose around it:',
    '',
    '{',
    '  "slug": "' + slug + '",',
    '  "requisiti": [',
    '    {"testo": "...", "stato": "soddisfatto|parziale|non soddisfatto",',
    '     "bloccante": true|false, "perche": "..."}',
    '  ],',
    '  "agganci": [{"punto": "...", "fatto": "..."}],',
    '  "sintesi": "..."',
    '}',
    '',
    'requisiti — every requirement the posting states, in the order it states them.',
    '  "testo" MUST be copied from the posting word for word, in its own language.',
    '  Never paraphrase, never summarise, never merge two requirements into one.',
    '  "bloccante" is true when failing it rules the candidate out on its own: a',
    '  years-of-experience floor, a degree in another field, a language he does not',
    '  speak, a mandatory office in another country, a programming language, a public',
    '  portfolio. It is false for anything a good application can argue around.',
    '  "perche" is ONE short sentence in Italian saying why he meets it or does not,',
    '  naming what in his profile decides it.',
    '',
    'agganci — at most three things the cover letter can honestly claim, each tied to',
    '  a fact that is true of the candidate from the paragraph above. "punto" is what',
    '  the posting asks for, "fatto" is what he actually has. If a hook has no fact',
    '  behind it, leave it out. An empty list is a valid and useful answer.',
    '',
    'sintesi — ONE sentence in Italian, max 30 words: what this job really is and',
    '  whether it is worth his time. Say it plainly, including when the answer is no.',
    '',
    '='.repeat(72),
    `Company: ${company}`,
    `Role: ${role}`,
    `Location: ${location}`,
    '',
    jd,
  ].join('\n');
}

/**
 * Parse and validate one analysis. Throws rather than storing a half answer.
 *
 * A malformed analysis that got written anyway would show the candidate a
 * percentage computed from nothing, which is worse than an error he can see.
 */
export function parseAnalysis(text, slug) {
  const cleaned = String(text).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  let data;
  try { data = JSON.parse(cleaned); } catch { throw new Error("l'analisi non è JSON leggibile"); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error("l'analisi non è un oggetto JSON");
  if (slug && data.slug !== slug) throw new Error(`l'analisi dice slug "${data.slug}", ne aspettavo "${slug}"`);
  if (!Array.isArray(data.requisiti)) throw new Error('manca la lista dei requisiti');
  for (const r of data.requisiti) {
    if (typeof r.testo !== 'string' || !r.testo.trim()) throw new Error('un requisito non cita il testo dell\'annuncio');
    if (!STATI.includes(r.stato)) throw new Error(`stato "${r.stato}" non riconosciuto`);
    if (typeof r.bloccante !== 'boolean') throw new Error(`il requisito "${r.testo.slice(0, 40)}" non dice se è bloccante`);
  }
  // A hook with no fact behind it is the failure this whole file exists to
  // prevent, so it is dropped here rather than shown and trusted.
  const agganci = Array.isArray(data.agganci)
    ? data.agganci.filter((a) => a && typeof a.punto === 'string' && typeof a.fatto === 'string' && a.fatto.trim())
    : [];
  return {
    slug: data.slug,
    requisiti: data.requisiti,
    agganci,
    sintesi: typeof data.sintesi === 'string' ? data.sintesi.trim() : '',
  };
}

const VALORE = { soddisfatto: 1, parziale: 0.5, 'non soddisfatto': 0 };

/**
 * Turn the requirement list into a number, and say when the number is void.
 *
 * A blocking requirement he does not meet does not lower the percentage, it
 * cancels it: 70% with a mandatory driving licence he does not have is not 70%
 * of anything. Blocking requirements also weigh double among the rest, because
 * "must" and "nice to have" are not the same claim.
 */
export function scoreFit(analysis) {
  const reqs = analysis.requisiti || [];
  if (!reqs.length) return { percent: null, blocked: false, blockers: [], total: 0 };

  const blockers = reqs.filter((r) => r.bloccante && r.stato === 'non soddisfatto');
  let got = 0;
  let max = 0;
  for (const r of reqs) {
    const peso = r.bloccante ? 2 : 1;
    max += peso;
    got += peso * (VALORE[r.stato] ?? 0);
  }
  return {
    percent: Math.round((got / max) * 100),
    blocked: blockers.length > 0,
    blockers: blockers.map((r) => r.testo),
    total: reqs.length,
  };
}

/** Which rows are worth reading properly: past the sift, still in play, not yet read. */
export function pendingAnalysis(rows, hasAnalysis = () => false) {
  return rows.filter((r) => r.score !== ''
    && Number(r.score) >= 3
    && r.apply !== 'skipped'
    && r.apply !== 'dead'
    && r.apply !== 'submitted'
    && !hasAnalysis(r.slug));
}

/** Write one analysis to disk, creating the folder on first use. */
export function saveAnalysis(slug, analysis, root = getCareerOpsRoot()) {
  const path = analysisPath(slug, root);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(analysis, null, 2)}\n`);
  return path;
}

/** Read one analysis back, or null when it was never run. */
export function loadAnalysis(slug, root = getCareerOpsRoot()) {
  const path = analysisPath(slug, root);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}
