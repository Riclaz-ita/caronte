/**
 * triage.test.mjs — tests for triage.mjs
 * Run: node triage.test.mjs
 */
import { buildBatchPrompt, parseVerdicts, ingestVerdicts, pendingTriage, JD_CHARS } from '../triage.mjs';
import { pass, fail } from './helpers.mjs';

// Il brief arriva esplicito: un clone appena fatto non ha candidate-brief.md,
// e un test non deve chiedere a chi lo esegue di descrivere sé stesso.
const BRIEF = 'Marketing graduate. Does NOT program. Italian native, English C1.';

// Counters and reporting come from the shared helpers: a discovered suite
// reports through pass/fail and never exits, or it takes the whole runner
// down with it.
function eq(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass(label);
  else fail(`${label} → got ${JSON.stringify(actual)}`);
}
function ok(label, cond) { if (cond) pass(label); else fail(label); }
function throws(label, fn, fragment) {
  try { fn(); fail(`${label} → non ha sollevato niente`); }
  catch (e) {
    if (e.message.includes(fragment)) pass(label);
    else fail(`${label} → ha sollevato "${e.message}", atteso qualcosa con "${fragment}"`);
  }
}

const entries = [
  { slug: 'acme-ai-intern', company: 'Acme', role: 'AI Intern', location: 'Milan', jd: 'We want someone curious. No experience required.' },
  { slug: 'beta-staff-eng', company: 'Beta', role: 'Staff Engineer', location: 'Remote', jd: '10+ years of distributed systems.' },
];

const prompt = buildBatchPrompt(entries, BRIEF);
ok('prompt contains every slug exactly once', entries.every(e => prompt.split(e.slug).length === 2));
ok('prompt carries the JD text', prompt.includes('No experience required'));
ok('prompt states the never-fabricate rule', /never/i.test(prompt));
ok('prompt asks for strict JSON', prompt.includes('JSON'));
ok('prompt states he does NOT program', /does NOT\s+program|not\s+program/i.test(prompt));

const good = `[
  {"slug":"acme-ai-intern","archetype":"Agentic","level":"entry","score":4.2,"summary_line":"Builds automations with coding agents."},
  {"slug":"beta-staff-eng","archetype":"AI Platform","level":"staff","score":1.5,"summary_line":"n/a"}
]`;
eq('parses a well-formed verdict set', parseVerdicts(good).length, 2);
eq('parses score as a number', parseVerdicts(good)[0].score, 4.2);

ok('tolerates a fenced code block', parseVerdicts('```json\n' + good + '\n```').length === 2);
throws('rejects non-JSON', () => parseVerdicts('not json at all'), 'could not parse');
throws('rejects a score outside 1-5', () => parseVerdicts('[{"slug":"a","archetype":"x","level":"entry","score":7,"summary_line":"y"}]'), 'score');
throws('rejects a missing field', () => parseVerdicts('[{"slug":"a","score":3}]'), 'missing');
throws('rejects a duplicate slug', () => parseVerdicts('[{"slug":"a","archetype":"x","level":"entry","score":3,"summary_line":"y"},{"slug":"a","archetype":"x","level":"entry","score":4,"summary_line":"z"}]'), 'duplicate slug');

const rows = [
  { slug: 'acme-ai-intern', url: 'u1', company: 'Acme', role: 'AI Intern', location: 'Milan', archetype: '', level: '', score: '', summary_line: '', pack: 'pending', apply: 'queued', date: '2026-09-11' },
  { slug: 'beta-staff-eng', url: 'u2', company: 'Beta', role: 'Staff Engineer', location: 'Remote', archetype: '', level: '', score: '', summary_line: '', pack: 'pending', apply: 'queued', date: '2026-09-11' },
];
const ingested = ingestVerdicts(rows, parseVerdicts(good));
eq('ingest writes the score', ingested[0].score, 4.2);
eq('ingest writes the summary line', ingested[0].summary_line, 'Builds automations with coding agents.');
eq('ingest writes the archetype', ingested[1].archetype, 'AI Platform');
eq('ingest leaves untouched columns alone', ingested[0].url, 'u1');
throws('ingest rejects an unknown slug', () => ingestVerdicts(rows, [{ slug: 'ghost', archetype: 'x', level: 'entry', score: 3, summary_line: 'y' }]), 'ghost');

// -- pendingTriage -----------------------------------------------------------
// Triage is the only phase that spends tokens. Scoring a posting the candidate
// already threw out spends them to produce a number nobody will read.
ok('an unscored row is pending', pendingTriage({ score: '', apply: 'queued' }));
ok('an unscored row he chose is pending', pendingTriage({ score: '', apply: 'chosen' }));
ok('a scored row is done', !pendingTriage({ score: 4, apply: 'queued' }));
ok('a skipped row is never triaged', !pendingTriage({ score: '', apply: 'skipped' }));
ok('a dead row is never triaged', !pendingTriage({ score: '', apply: 'dead' }));
ok('a skipped row stays out even with a score already set', !pendingTriage({ score: 2, apply: 'skipped' }));

// -- how much of a posting the model actually sees --------------------------
//
// The bug this guards: the cap was 4000 characters against a corpus averaging
// 6750, so 20 of 21 live postings were cut. A posting opens with the company
// describing itself and closes with what it demands, so the requirements were
// the part that fell off, and the score was formed without them.
const lungo = { slug: 'x', company: 'C', role: 'R', location: 'L', jd: 'a'.repeat(9000) };
ok('a posting of 9000 characters is no longer cut',
  buildBatchPrompt([lungo], BRIEF).includes('a'.repeat(9000)));
ok('the cap clears the longest posting in the corpus', JD_CHARS >= 13000);
const enorme = { ...lungo, jd: 'b'.repeat(JD_CHARS + 500) };
const promptEnorme = buildBatchPrompt([enorme], BRIEF);
ok('a pathological posting is still capped', !promptEnorme.includes('b'.repeat(JD_CHARS + 1)));
ok('and says so, instead of ending mid-sentence in silence',
  /troncato a \d+ caratteri/.test(promptEnorme));
