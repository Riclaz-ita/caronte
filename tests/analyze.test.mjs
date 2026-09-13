/**
 * analyze.test.mjs — tests for analyze.mjs
 *
 * The percentage is the part worth testing hardest. It is the number the
 * candidate will read first and act on, and it is the one place where a wrong
 * answer looks exactly like a right one.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildAnalysisPrompt, parseAnalysis, scoreFit, pendingAnalysis,
  analysisPath, saveAnalysis, loadAnalysis,
} from '../analyze.mjs';
import { pass, fail } from './helpers.mjs';

// Il brief arriva esplicito: un clone appena fatto non ha candidate-brief.md,
// e un test non deve chiedere a chi lo esegue di descrivere sé stesso.
const BRIEF = 'Marketing graduate. Does NOT program. Italian native, English C1.';

function eq(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass(label);
  else fail(`${label} → got ${JSON.stringify(actual)}`);
}
function ok(label, cond) { if (cond) pass(label); else fail(label); }
function throws(label, fn) {
  try { fn(); fail(`${label} → non ha sollevato niente`); }
  catch { pass(label); }
}

// -- the prompt -------------------------------------------------------------

const prompt = buildAnalysisPrompt({
  slug: 'acme-social', company: 'Acme', role: 'Social Media Manager',
  location: 'Milano', jd: 'We need 5 years of experience. '.repeat(20),
}, BRIEF);
ok('the prompt carries the whole posting, uncut', prompt.includes('We need 5 years of experience. '.repeat(20)));
ok('the prompt names the posting so the answer can be matched back', prompt.includes('"slug": "acme-social"'));
ok('the prompt carries the candidate brief, whatever it says', prompt.includes(BRIEF));
ok('the prompt demands the requirement be quoted, not summarised', /word for word/.test(prompt));
ok('the prompt allows an empty hook list rather than forcing one', /empty list is a valid/.test(prompt));

// -- parsing ----------------------------------------------------------------

const buono = JSON.stringify({
  slug: 'a',
  requisiti: [{ testo: '5+ years of experience', stato: 'non soddisfatto', bloccante: true, perche: 'Nessuna esperienza.' }],
  agganci: [{ punto: 'AI tools', fatto: 'Usa Claude Code ogni giorno.' }],
  sintesi: 'Ruolo mid travestito da junior.',
});
eq('a well-formed analysis parses', parseAnalysis(buono, 'a').requisiti.length, 1);
eq('a fenced code block is tolerated', parseAnalysis('```json\n' + buono + '\n```', 'a').slug, 'a');
throws('prose instead of JSON throws', () => parseAnalysis('Ecco la mia analisi:', 'a'));
throws('a JSON array is not an analysis', () => parseAnalysis('[]', 'a'));
throws('an analysis for another posting throws instead of overwriting this one',
  () => parseAnalysis(buono, 'b'));
throws('a missing requirement list throws', () => parseAnalysis('{"slug":"a"}', 'a'));
throws('a paraphrased requirement with no quote throws',
  () => parseAnalysis('{"slug":"a","requisiti":[{"testo":"","stato":"soddisfatto","bloccante":false}]}', 'a'));
throws('an unrecognised status throws',
  () => parseAnalysis('{"slug":"a","requisiti":[{"testo":"x","stato":"forse","bloccante":false}]}', 'a'));
throws('a requirement that does not say whether it blocks throws',
  () => parseAnalysis('{"slug":"a","requisiti":[{"testo":"x","stato":"soddisfatto"}]}', 'a'));

// The rule the whole pipeline rests on: nothing goes into an application
// without a source. A hook with no fact behind it is dropped, not shown.
const senzaFatto = JSON.stringify({
  slug: 'a',
  requisiti: [{ testo: 'x', stato: 'soddisfatto', bloccante: false }],
  agganci: [{ punto: 'Ottimo comunicatore', fatto: '' }, { punto: 'AI', fatto: 'Usa Claude Code.' }],
});
eq('a hook with no fact behind it is dropped', parseAnalysis(senzaFatto, 'a').agganci.map((a) => a.punto), ['AI']);

// -- the percentage ---------------------------------------------------------

const r = (testo, stato, bloccante) => ({ testo, stato, bloccante, perche: '' });

eq('everything met is 100%', scoreFit({ requisiti: [r('a', 'soddisfatto', false), r('b', 'soddisfatto', true)] }).percent, 100);
eq('nothing met is 0%', scoreFit({ requisiti: [r('a', 'non soddisfatto', false)] }).percent, 0);
eq('partial counts half', scoreFit({ requisiti: [r('a', 'parziale', false)] }).percent, 50);
// "must have" and "nice to have" are not the same claim, so they do not weigh
// the same: the blocking one counts double among the rest.
eq('a blocking requirement weighs double',
  scoreFit({ requisiti: [r('a', 'soddisfatto', false), r('b', 'non soddisfatto', true)] }).percent, 33);
eq('an analysis with no requirements has no percentage, not a zero',
  scoreFit({ requisiti: [] }).percent, null);

// The point of the whole design: a percentage means nothing when a blocking
// requirement is unmet, so it is marked void rather than quietly lowered.
const bloccato = scoreFit({ requisiti: [
  r('Fluent German', 'non soddisfatto', true),
  r('Social media', 'soddisfatto', false),
  r('Teamwork', 'soddisfatto', false),
] });
ok('an unmet blocking requirement voids the result', bloccato.blocked);
eq('and says which one', bloccato.blockers, ['Fluent German']);
ok('a high percentage does not hide a blocker', bloccato.percent >= 50 && bloccato.blocked);
ok('a blocking requirement that IS met blocks nothing',
  !scoreFit({ requisiti: [r('Italian', 'soddisfatto', true)] }).blocked);
ok('a partial on a blocking requirement is a warning, not a wall',
  !scoreFit({ requisiti: [r('3 years', 'parziale', true)] }).blocked);

// -- who gets analysed ------------------------------------------------------

const coda = [
  { slug: 'alto', score: '4.2', apply: 'queued' },
  { slug: 'scelto', score: '3.0', apply: 'chosen' },
  { slug: 'basso', score: '2.0', apply: 'queued' },
  { slug: 'scartato', score: '4.5', apply: 'skipped' },
  { slug: 'inviato', score: '4.5', apply: 'submitted' },
  { slug: 'nonvotato', score: '', apply: 'queued' },
  { slug: 'gialetto', score: '4.0', apply: 'queued' },
];
eq('only postings past the sift, still in play, and not already read',
  pendingAnalysis(coda, (s) => s === 'gialetto').map((x) => x.slug), ['alto', 'scelto']);
eq('a posting nobody voted on is not analysed: the sift comes first',
  pendingAnalysis([coda[5]]).length, 0);
eq('an analysis is never run twice on the same posting',
  pendingAnalysis([coda[0]], () => true).length, 0);

// -- on disk ----------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'analyze-test-'));
eq('the analysis sits beside its posting, under the same slug',
  analysisPath('acme-social', dir), join(dir, 'analyses', 'acme-social.json'));
eq('nothing saved yet reads back as nothing', loadAnalysis('acme-social', dir), null);
saveAnalysis('acme-social', { slug: 'acme-social', requisiti: [], agganci: [], sintesi: 'x' }, dir);
eq('what was saved reads back', loadAnalysis('acme-social', dir).sintesi, 'x');
writeFileSync(analysisPath('acme-social', dir), '{ rotto');
eq('a corrupted file reads back as nothing rather than crashing the page',
  loadAnalysis('acme-social', dir), null);
rmSync(dir, { recursive: true, force: true });
