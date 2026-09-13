/**
 * candidate-brief.test.mjs — tests for candidate-brief.mjs
 *
 * The rule worth testing is the refusal. A missing brief that quietly fell
 * back to the shipped example would score real postings against an invented
 * person, and the numbers would look exactly like real ones.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadCandidateBrief, BRIEF_FILE } from '../candidate-brief.mjs';
import { pass, fail } from './helpers.mjs';

function eq(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(`${label} → got ${JSON.stringify(actual)}`);
}
function ok(label, cond) { if (cond) pass(label); else fail(label); }

const dir = mkdtempSync(join(tmpdir(), 'brief-test-'));

let msg = '';
try { loadCandidateBrief(dir); fail('a missing brief throws'); }
catch (err) { msg = err.message; pass('a missing brief throws instead of inventing a candidate'); }
ok('and the error says which file to copy', msg.includes(BRIEF_FILE) && msg.includes('example'));

writeFileSync(join(dir, BRIEF_FILE), '   \n\n  ');
try { loadCandidateBrief(dir); fail('an empty brief throws'); }
catch { pass('an empty brief throws too: whitespace is not a description'); }

writeFileSync(join(dir, BRIEF_FILE), [
  '<!-- istruzioni per chi compila, non per il modello -->',
  '# Titolo',
  '',
  'Laureato in marketing. Non programma.',
  '',
].join('\n'));
const brief = loadCandidateBrief(dir);
eq('the brief comes back as its text alone', brief, 'Laureato in marketing. Non programma.');
ok('instructions to the reader never reach the model', !brief.includes('istruzioni'));
ok('headings are dropped too', !brief.includes('Titolo'));

rmSync(dir, { recursive: true, force: true });
