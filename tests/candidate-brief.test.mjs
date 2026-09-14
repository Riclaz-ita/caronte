/**
 * candidate-brief.test.mjs — tests for candidate-brief.mjs
 *
 * Two rules carry the weight here. A missing brief must refuse rather than
 * fall back to the shipped example, because scoring real postings against an
 * invented person produces numbers that look exactly like real ones. And a
 * section marked panel-only must never reach a prompt: what the candidate
 * wants on his own screen is not what he wants posted with every job
 * description.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadCandidateBrief, loadProfileCard, parseBrief, readBriefFile, BRIEF_FILE, PANEL_ONLY,
} from '../candidate-brief.mjs';
import { pass, fail } from './helpers.mjs';

function eq(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass(label);
  else fail(`${label} → got ${JSON.stringify(actual)}`);
}
function ok(label, cond) { if (cond) pass(label); else fail(label); }

// -- the refusal ------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'brief-test-'));

let msg = '';
try { readBriefFile(dir); fail('a missing brief throws'); }
catch (err) { msg = err.message; pass('a missing brief throws instead of inventing a candidate'); }
ok('and the error says which file to copy', msg.includes(BRIEF_FILE) && msg.includes('example'));

writeFileSync(join(dir, BRIEF_FILE), '<!-- solo istruzioni, nessuna sezione -->\n');
try { loadCandidateBrief(dir); fail('a brief with no sections throws'); }
catch { pass('a brief with nothing in it throws too: a comment is not a description'); }

// -- the sections -----------------------------------------------------------

const testo = [
  '<!-- istruzioni per chi compila, non per il modello -->',
  '',
  '## Chi sono',
  '',
  'Laureato in marketing. Non programmo.',
  '',
  '## Cosa so fare',
  '',
  '- Dirigo agenti di codice.',
  '- Excel avanzato.',
  '',
  PANEL_ONLY,
  '## Cosa manca',
  '',
  '- Nessun portfolio pubblico.',
  '',
].join('\n');
writeFileSync(join(dir, BRIEF_FILE), testo);

const card = loadProfileCard(dir);
eq('the panel gets every section, in the order written',
  card.map((s) => s.title), ['Chi sono', 'Cosa so fare', 'Cosa manca']);
eq('prose stays prose', card[0].prose, 'Laureato in marketing. Non programmo.');
eq('points stay points', card[1].points, ['Dirigo agenti di codice.', 'Excel avanzato.']);
eq('a point is never left with its dash attached', card[1].points[0].startsWith('-'), false);
ok('the panel-only section is flagged as such', card[2].panelOnly === true);
ok('and the others are not', card[0].panelOnly === false && card[1].panelOnly === false);

const perIlModello = loadCandidateBrief(dir);
ok('the model gets the sections meant for it', perIlModello.includes('Dirigo agenti di codice.'));
ok('the model gets the headings too, so a refusal reads as a refusal', perIlModello.includes('Cosa so fare:'));
ok('the model never receives a panel-only section', !perIlModello.includes('Nessun portfolio pubblico.'));
ok('instructions to the reader never reach the model', !perIlModello.includes('istruzioni'));

eq('an empty document has no sections', parseBrief(''), []);
eq('a heading with nothing under it is not a section', parseBrief('## Vuota\n\n'), []);

rmSync(dir, { recursive: true, force: true });
