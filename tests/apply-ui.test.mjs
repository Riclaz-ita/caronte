/**
 * apply-ui.test.mjs — tests for apply-ui.mjs
 * Run: node apply-ui.test.mjs
 *
 * The HTTP layer is thin on purpose: everything that decides anything is a
 * pure function, and that is what is tested here. The one exception is the
 * snapshot/restore pair, which is tested against real files in a temp dir
 * because "the rollback works" is not a claim worth making on a mock.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PHASES, phaseById, DECISIONS, applyDecision, summarise, nextPhase,
  preflight, shapeError, snapshotPath, snapshot, restore,
  parseFocus, describeFocus, matchesFocus, applyFocus,
  PACK_THRESHOLD, packsPending, pickForForm, triageBatch, PHASE_MODEL,
  MODEL_CWD, claudeArgs,
} from '../apply-ui.mjs';
import { APPLY_STATES } from '../apply-queue.mjs';
import { readFileSync as read } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { pass, fail } from './helpers.mjs';

// Counters and reporting come from the shared helpers: a discovered suite
// reports through pass/fail and never exits, or it takes the whole runner
// down with it.
function eq(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass(label);
  else fail(`${label} → got ${JSON.stringify(actual)}`);
}
function ok(label, cond) { if (cond) pass(label); else fail(label); }
function throws(label, fn) {
  try { fn(); fail(`${label} → non ha sollevato niente`); }
  catch { pass(label); }
}

// -- Phases -----------------------------------------------------------------

eq('five phases, in pipeline order', PHASES.map((p) => p.id), ['search', 'triage', 'deep', 'packs', 'form']);
// The deep read sits between the sift and the documents on purpose: the sift is
// cheap over everything, the full read is expensive per posting, so the second
// only ever runs on what survived the first.
eq('the deep read comes after the vote and before the CV',
  PHASES.findIndex((p) => p.id === 'deep'), PHASES.findIndex((p) => p.id === 'triage') + 1);
ok('every phase names the files it writes', PHASES.every((p) => Array.isArray(p.writes) && p.writes.length > 0));
ok('every phase declares a risk level', PHASES.every((p) => ['low', 'medium', 'high'].includes(p.risk)));
ok('every phase declares whether it can be undone', PHASES.every((p) => typeof p.reversible === 'boolean'));
ok('exactly two phases cost tokens, and the page says which',
  PHASES.filter((p) => /token/.test(p.cost) && !/zero/.test(p.cost)).map((p) => p.id).join() === 'triage,deep');
ok('the deep read says the cost is per posting, not per run',
  /per annuncio/.test(phaseById('deep').cost));
eq('phaseById finds a real phase', phaseById('packs').label, 'Prepara i documenti');
eq('phaseById rejects an unknown id', phaseById('nope'), null);

// A phase whose `writes` list is wrong makes the confirmation dialog lie, in
// both directions: naming a file it never touches is as misleading as hiding
// one it does.
ok('every phase that writes the queue says so',
  PHASES.filter((p) => p.id !== 'deep').every((p) => p.writes.includes('data/apply-queue.tsv')));
eq('the deep read touches its own folder and nothing else',
  phaseById('deep').writes, ['analyses/']);

// -- Decisions --------------------------------------------------------------

eq('three decisions, matching the buttons', Object.keys(DECISIONS), ['apply', 'partial', 'skip']);
ok('every decision maps to a state the queue accepts',
  Object.values(DECISIONS).every((d) => APPLY_STATES.includes(d.state)));
eq('"solo documenti" is its own state, not a synonym for queued', DECISIONS.partial.state, 'partial');

const rows = [
  { slug: 'a', apply: 'queued', pack: 'built', score: 4 },
  { slug: 'b', apply: 'skipped', pack: 'pending', score: 2 },
  { slug: 'c', apply: 'chosen', pack: 'built', score: 4 },
];

eq('apply records an explicit choice, not the import default', applyDecision(rows, 'b', 'apply').rows[0 + 1].apply, 'chosen');
eq('"queued" stays available as the undecided default', APPLY_STATES.includes('queued'), true);
eq('partial sets partial', applyDecision(rows, 'a', 'partial').rows[0].apply, 'partial');
eq('skip sets skipped', applyDecision(rows, 'a', 'skip').rows[0].apply, 'skipped');
ok('a decision that changes nothing reports no change', applyDecision(rows, 'c', 'apply').changed === false);
ok('a no-op decision returns the same array, so the file is not rewritten',
  applyDecision(rows, 'c', 'apply').rows === rows);
ok('a real decision does not mutate the input', (() => {
  const before = JSON.stringify(rows);
  applyDecision(rows, 'a', 'skip');
  return JSON.stringify(rows) === before;
})());
throws('an unknown decision throws instead of silently doing nothing', () => applyDecision(rows, 'a', 'maybe'));
throws('an unknown slug throws', () => applyDecision(rows, 'zzz', 'apply'));

// -- Summary ----------------------------------------------------------------

const mixed = [
  { slug: 'p', score: '',  pack: 'pending',   apply: 'queued' },   // importato, non deciso
  { slug: 'q', score: '',  pack: 'pending',   apply: 'queued' },
  { slug: 'r', score: 4.5, pack: 'built',     apply: 'chosen' },   // scelto davvero
  { slug: 's', score: 3.0, pack: 'built',     apply: 'partial' },
  { slug: 't', score: 1.0, pack: 'pending',   apply: 'skipped' },
  { slug: 'u', score: '',  pack: 'jd_failed', apply: 'chosen' },
];
// 'u' has no job description on disk: it is in the queue but nothing can read it.
const hasJd = (slug) => slug !== 'u';
const s = summarise(mixed, hasJd);

eq('total counts every row', s.total, 6);
eq('withJd excludes the unreadable posting', s.withJd, 5);
eq('readyToTriage counts only unscored rows whose JD landed', s.readyToTriage, 2);
// The confirmation must promise exactly the batch triage will read: a skipped
// row has a JD and no score, but triage will never look at it.
eq('a skipped row is not promised to the triage batch',
  summarise([{ slug: 'x', score: '', pack: 'pending', apply: 'skipped' }]).readyToTriage, 0);
eq('scored counts every row with a number', s.scored, 3);
// 3.0 is below the builder's 3.5 bar and the 1.0 row is discarded, so neither
// is reachable: the word has to mean "a document could come out of this".
eq('reachable counts only what the builder would accept', s.reachable, 1);
eq('packsTodo counts what is still waiting to be built', s.packsTodo, 0);
eq('packsBuilt counts built packs', s.packsBuilt, 2);
eq('jdFailed counts the unreadable ones', s.jdFailed, 1);
eq('chosen counts only rows the candidate actually picked', s.chosen, 3);
eq('inPlay counts what is neither discarded nor unreadable', s.inPlay, 4);

// The bug this guards: computing "in play" as total minus skipped minus
// unreadable counted twice every row that is both, and the board read 5 where
// 21 were actually in play.
eq('a row that is both skipped and unreadable is subtracted once, not twice',
  summarise([
    { slug: 'a', score: '', pack: 'jd_failed', apply: 'skipped' },
    { slug: 'b', score: '', pack: 'pending',   apply: 'queued' },
  ]).inPlay, 1);

// The bug this guards: every imported row starts at 'queued', so counting
// 'queued' as a choice showed 122 deliberate picks on a queue nobody had
// touched, with the "Candidati" button already reading as pressed.
eq('an untouched imported row is not counted as chosen',
  summarise([{ slug: 'x', score: 4, pack: 'built', apply: 'queued' }]).chosen, 0);
eq('formReady counts only rows apply-session could actually open', s.formReady, 2);
eq('partial is counted apart from chosen', s.partial, 1);
eq('skipped is counted', s.skipped, 1);

// The bug this guards: counting a jd_failed row as ready-to-triage promised a
// batch bigger than the one that could actually run, and the phase then
// triaged fewer postings than the confirmation had said.
eq('summarise defaults to counting every row as readable', summarise(mixed).readyToTriage, 3);
eq('an empty queue summarises to zeroes', summarise([]).total, 0);

// -- Next phase -------------------------------------------------------------

eq('an empty queue starts at search', nextPhase(summarise([])), 'search');
eq('unscored rows mean triage next', nextPhase(s), 'triage');
eq('scored but unbuilt means packs next',
  nextPhase({ total: 3, readyToTriage: 0, packsTodo: 2, formReady: 0 }), 'packs');
eq('rows ready for the form mean the form next',
  nextPhase({ total: 3, readyToTriage: 0, packsTodo: 0, formReady: 2 }), 'form');
eq('nothing left to do returns null',
  nextPhase({ total: 3, readyToTriage: 0, packsTodo: 0, formReady: 0 }), null);
// The loop this guards: rows scoring 3 counted as pending work the builder
// would never do, so the board suggested "Prepara i documenti" forever.
eq('rows below the builder bar do not keep suggesting packs',
  nextPhase(summarise([{ slug: 'a', score: '3', pack: 'pending', apply: 'queued' }], () => true, () => true)), null);
// A posting past the sift that nobody has read properly is what the deep phase
// is for, and it comes before the documents are rendered.
eq('a scored posting nobody has read yet means the deep read next',
  nextPhase(summarise([{ slug: 'a', score: '4', pack: 'pending', apply: 'queued' }])), 'deep');
eq('once it is read, the pipeline moves on to the documents',
  nextPhase(summarise([{ slug: 'a', score: '4', pack: 'pending', apply: 'queued' }], () => true, () => true)), 'packs');

// -- Preflight --------------------------------------------------------------

const pf = preflight('triage', s, { limit: 1 });
eq('preflight names the phase', pf.phase, 'triage');
ok('preflight always demands confirmation', pf.needsConfirm === true);
ok('preflight lists the files that will be written', pf.writes.includes('data/apply-queue.tsv'));
ok('preflight says what it acts on', /1 annuncio su 2/.test(pf.affects));
// "1 annunci" è la prima cosa che si legge nella conferma: se sbaglia lì,
// nessuno crede al resto della finestra.
ok('uno solo si dice al singolare', /^1 annuncio /.test(preflight('triage', s, { limit: 1 }).affects));
ok('preflight explains how to undo a reversible phase', /Ripristina/.test(pf.rollback));

// No phase may be confirmation-free: a queue written by the wrong phase at the
// wrong moment is exactly the incoherent state this front-end exists to avoid.
ok('every phase demands confirmation',
  PHASES.every((p) => preflight(p.id, s).needsConfirm === true));
ok('every phase lists at least one file in its preflight',
  PHASES.every((p) => preflight(p.id, s).writes.length > 0));

ok('a limit larger than the batch is clamped to what exists',
  /2 annunci su 2/.test(preflight('triage', s, { limit: 999 }).affects));
ok('asking for zero warns instead of running silently',
  /zero/.test(preflight('triage', s, { limit: 0 }).warning));
ok('triage with nothing to read warns',
  /prima lancia la ricerca/.test(preflight('triage', summarise([]), {}).warning));
ok('the form with nothing queued warns',
  /Nessun annuncio in coda/.test(preflight('form', summarise([]), {}).warning));
ok('packs with nothing pending warns',
  /Nessun annuncio in attesa/.test(preflight('packs', { packsTodo: 0, packsBuilt: 2, formReady: 0, total: 2 }).warning));

// Guard for the overcount that made the form preflight promise more postings
// than apply-session could open: a queued row whose pack is still pending is
// chosen, but it is not ready.
eq('a chosen row without documents is not counted as ready',
  summarise([{ slug: 'x', score: 4, pack: 'pending', apply: 'chosen' }]).formReady, 0);
eq('a row whose posting could not be read is still openable by hand',
  summarise([{ slug: 'x', score: '', pack: 'jd_failed', apply: 'chosen' }]).formReady, 1);
eq('an undecided row is never queued for the form',
  summarise([{ slug: 'x', score: 4, pack: 'built', apply: 'queued' }]).formReady, 0);
ok('a healthy preflight carries no warning', preflight('search', s).warning === null);
throws('preflight refuses an unknown phase', () => preflight('nope', s));

// -- Errors -----------------------------------------------------------------

const soft = shapeError({ phaseId: 'search', step: 'scarica le job description', message: 'boom', output: 'unsupported ATS host: https://x' });
eq('a known non-blocking failure is reported as non-blocking', soft.blocking, false);
ok('a non-blocking failure explains itself in plain Italian', /API pubblica/.test(soft.explain));
ok('a non-blocking failure offers to carry on', soft.actions.includes('continua'));
ok('a non-blocking failure never offers a rollback it does not need', !soft.actions.includes('ripristina'));

const hard = shapeError({ phaseId: 'packs', message: "ENOENT: open 'cover-base.json'" });
eq('a missing cover base is blocking', hard.blocking, true);
ok('a blocking failure offers retry and rollback',
  hard.actions.includes('riprova') && hard.actions.includes('ripristina'));
ok('the report names the phase in words, not by id', hard.phaseLabel === 'Prepara i documenti');
ok('the report names the files the phase touches', hard.files.includes('output/apply/'));

// Refusing to guess is the safe default: an unrecognised failure must not be
// reported as harmless just because no pattern matched it.
const unknown = shapeError({ phaseId: 'triage', message: 'something nobody predicted' });
eq('an unrecognised failure is treated as blocking', unknown.blocking, true);
ok('an unrecognised failure admits it is unrecognised', /non riconosco/.test(unknown.explain));

ok('a missing claude binary is explained as a missing command',
  /claude/.test(shapeError({ phaseId: 'triage', message: 'spawn claude ENOENT' }).explain));
ok('a CV without a summary slot is blocking',
  shapeError({ phaseId: 'packs', message: 'has no summary slot' }).blocking === true);
ok('the first line of a long message is kept, not the whole dump',
  shapeError({ phaseId: 'packs', message: 'first line\nsecond line' }).message === 'first line');
ok('the raw log is capped so the page cannot be flooded',
  shapeError({ phaseId: 'packs', message: 'x', output: 'y'.repeat(99999) }).output.length <= 4000);

// -- Selettori condivisi con gli script -------------------------------------
//
// These exist because the page must count exactly what the scripts will do.
// Every assertion here failed once in a way the candidate could see: a board
// promising documents the builder would not build, and a form phase answering
// "nothing is ready" about a row the same board had just called ready.

const here = dirname(fileURLToPath(import.meta.url));
const builderSource = read(resolve(here, '..', 'build-packs.mjs'), 'utf-8');
const builderDefault = /threshold = ([\d.]+)/.exec(builderSource);
ok('build-packs dichiara ancora la sua soglia in modo leggibile', builderDefault !== null);
eq('la soglia della pagina è quella del builder', PACK_THRESHOLD, Number(builderDefault[1]));
ok('il builder salta le righe scartate', /apply !== 'skipped'/.test(builderSource));

const scored = [
  { slug: 'a', score: '4', pack: 'pending', apply: 'queued' },
  { slug: 'b', score: '3', pack: 'pending', apply: 'queued' },
  { slug: 'c', score: '4', pack: 'pending', apply: 'skipped' },
  { slug: 'd', score: '4', pack: 'built', apply: 'chosen' },
  { slug: 'e', score: '', pack: 'pending', apply: 'queued' },
];
eq('conta solo le righe che il builder costruirebbe davvero', packsPending(scored).map((r) => r.slug), ['a']);
eq('un 3 non basta: il builder parte da 3.5', packsPending([scored[1]]).length, 0);
eq('un ruolo scartato non riceve documenti nemmeno con un voto alto', packsPending([scored[2]]).length, 0);

// Il guasto che questi test bloccano: chiedere "valutane 1" spendeva il giro
// sul primo annuncio del file, quasi sempre uno già scartato, mentre la
// plancia prometteva che il gruppo sarebbe uscito da quelli ancora in gioco.
const coda = [
  { slug: 'scartato', score: '', apply: 'skipped' },
  { slug: 'morto', score: '', apply: 'dead' },
  { slug: 'primo', score: '', apply: 'queued' },
  { slug: 'senzatesto', score: '', apply: 'queued' },
  { slug: 'secondo', score: '', apply: 'queued' },
  { slug: 'gia-votato', score: '4', apply: 'queued' },
];
const conTesto = (slug) => slug !== 'senzatesto';
eq('uno solo vuol dire il primo ancora in gioco, non il primo del file',
  triageBatch(coda, 1, conTesto).map((r) => r.slug), ['primo']);
eq('il gruppo salta gli scartati, i morti, i già votati e chi non ha testo',
  triageBatch(coda, undefined, conTesto).map((r) => r.slug), ['primo', 'secondo']);
eq('il gruppo è lungo quanto la plancia promette',
  triageBatch(coda, undefined, conTesto).length, summarise(coda, conTesto).readyToTriage);
eq('chiedere più di quelli che ci sono non inventa righe', triageBatch(coda, 99, conTesto).length, 2);
eq('chiedere zero non valuta niente', triageBatch(coda, 0, conTesto), []);

eq('nessuna riga pronta, nessun form', pickForForm([{ slug: 'a', apply: 'queued', pack: 'pending' }]), null);
eq('una riga scelta con i documenti pronti apre il form',
  pickForForm([{ slug: 'a', apply: 'chosen', pack: 'built' }]).slug, 'a');
eq('anche una riga senza testo annuncio apre il form: il modulo si compila lo stesso',
  pickForForm([{ slug: 'a', apply: 'chosen', pack: 'jd_failed' }]).slug, 'a');
eq('una riga scartata non apre niente', pickForForm([{ slug: 'a', apply: 'skipped', pack: 'built' }]), null);
eq('una riga già inviata non si riapre', pickForForm([{ slug: 'a', apply: 'submitted', pack: 'built' }]), null);

// -- Chi spende, e su quale modello -----------------------------------------
//
// Left to the CLI default both phases ran on Opus. They are not the same job:
// the triage is classification against a written rubric and carries nearly all
// the input tokens; the deep read is judgement on a handful of postings.

const spendono = PHASES.filter((p) => /token/.test(p.cost) && !/zero/.test(p.cost)).map((p) => p.id);
eq('ogni fase che spende dichiara il suo modello',
  spendono.filter((id) => !PHASE_MODEL[id]), []);
eq('nessuna fase gratuita si porta dietro un modello',
  Object.keys(PHASE_MODEL).filter((id) => !spendono.includes(id)), []);
ok('la scrematura non gira sul modello più caro', PHASE_MODEL.triage !== 'opus');
ok('la lettura approfondita sì', PHASE_MODEL.deep === 'opus');
ok('la conferma dice quale modello sta per partire', preflight('triage', summarise([])).model === PHASE_MODEL.triage);
ok('una fase gratuita non mostra nessun modello', preflight('search', summarise([])).model === null);

// The measurement behind this: a one-word prompt cost 39.158 input tokens when
// spawned inside the repo and 24.360 from a neutral directory. The difference
// is the project's CLAUDE.md pulling in a 52kB AGENTS.md, handed to a request
// that has no tools and cannot act on any of it — once per triage, and again
// for every posting the deep read opens.
ok('i modelli non girano dentro il repo, o si porterebbero dietro AGENTS.md',
  !MODEL_CWD.startsWith(resolve(here, '..')));
ok('nessun attrezzo: il prompt arriva intero da stdin', claudeArgs('x').join(' ').includes("--allowed-tools  "));
ok('nessun server MCP al seguito', claudeArgs('x').includes('--strict-mcp-config'));
eq('il modello chiesto è quello che parte', claudeArgs('sonnet')[claudeArgs('sonnet').indexOf('--model') + 1], 'sonnet');

// -- La fase di lettura approfondita ----------------------------------------

const daLeggere = summarise([
  { slug: 'a', score: '4', pack: 'pending', apply: 'queued' },
  { slug: 'b', score: '2', pack: 'pending', apply: 'queued' },
], () => true, (slug) => slug === 'c');
eq('conta solo gli annunci passati la scrematura', daLeggere.toAnalyse, 1);
eq('e conta a parte quelli già letti', daLeggere.analysed, 0);

const pfDeep = preflight('deep', daLeggere);
ok('la conferma dice quanti ne legge', /1 annuncio su 1 da leggere/.test(pfDeep.affects));
ok('e avverte che si paga per annuncio, non a giro',
  /per annuncio/.test(pfDeep.warning));
ok('chiedere uno solo si dice al singolare anche qui',
  /^1 annuncio /.test(preflight('deep', daLeggere, { limit: 1 }).affects));
ok('senza niente da leggere, la conferma spiega perché invece di tacere',
  /voto 3 o più/.test(preflight('deep', summarise([])).warning));
ok('la lettura approfondita non tocca la coda',
  !preflight('deep', daLeggere).writes.includes('data/apply-queue.tsv'));

// -- Focus della ricerca ----------------------------------------------------

eq('le virgole separano le richieste, gli spazi no', parseFocus('part time, marketing'), [['part time'], ['marketing']]);
eq('il tubo elenca i modi di soddisfare una richiesta', parseFocus('part time | tempo parziale'), [['part time', 'tempo parziale']]);
eq('accenti, maiuscole e trattini finiscono nella stessa forma', parseFocus('Part-Time , GRAFICA'), [['part time'], ['grafica']]);
eq('un campo vuoto non è una richiesta', parseFocus('  ,  |  '), []);
eq('niente scritto, nessuna richiesta', parseFocus(undefined), []);
eq('la conferma legge le richieste in italiano', describeFocus(parseFocus('part time | tempo parziale, milano')), '(part time o tempo parziale) e milano');

const post = { slug: 'a', role: 'Social Media Manager', company: 'Acme', location: 'Milano' };
ok('senza focus passa tutto', matchesFocus(post, '', []));
ok('un termine nel titolo basta', matchesFocus(post, '', [['social']]));
ok('un termine nella descrizione conta quanto uno nel titolo', matchesFocus(post, 'Contratto part-time, 20 ore', [['part time']]));
ok('le richieste si sommano: servono tutte', !matchesFocus(post, 'full time', [['social'], ['part time']]));
ok('dentro una richiesta basta un modo', matchesFocus(post, 'Contratto a tempo parziale', [['part time', 'tempo parziale']]));
ok('part time e full time insieme vogliono dire "uno dei due", non "nessuno"', matchesFocus(post, 'Full time', [['part time', 'full time']]));
ok('un termine che non c\'è da nessuna parte esclude', !matchesFocus(post, 'testo qualsiasi', [['ingegneria']]));
ok('un termine vale come inizio di parola: "market" prende "Marketing"', matchesFocus(post, 'Junior Marketing role', [['market']]));
ok('un termine non vale a metà parola: "intern" non prende "external"', !matchesFocus(post, 'External communication role', [['intern']]));

const fresh = [
  { slug: 'a', role: 'Social Media Manager', company: 'Acme', location: 'Milano', score: '', apply: 'queued' },
  { slug: 'b', role: 'Warehouse Operator', company: 'Beta', location: 'Milano', score: '', apply: 'queued' },
  { slug: 'c', role: 'Warehouse Operator', company: 'Gamma', location: 'Roma', score: '4', apply: 'queued' },
  { slug: 'd', role: 'Warehouse Operator', company: 'Delta', location: 'Roma', score: '', apply: 'chosen' },
];
const jds = { a: 'Cerchiamo un profilo part time', b: 'Full time su tre turni', c: '', d: '' };
const focused = applyFocus(fresh, [['part time']], (slug) => jds[slug] || '');
eq('fuori focus: una sola riga messa da parte', focused.setAside, 1);
eq('dentro il focus: una sola riga tenuta', focused.kept, 1);
eq('la riga fuori focus diventa "skipped", non sparisce', focused.rows[1].apply, 'skipped');
eq('una riga già valutata non si tocca', focused.rows[2].apply, 'queued');
eq('una riga già scelta non si tocca', focused.rows[3].apply, 'chosen');
ok('le righe di partenza restano intatte', fresh[1].apply === 'queued');
eq('senza termini la coda torna identica, senza copie', applyFocus(fresh, []).rows, fresh);

const senza = preflight('search', summarise([]));
eq('senza focus la conferma parla di tutti i portali', senza.affects, 'tutti i portali configurati');
ok('senza focus niente avviso', senza.warning === null);
const con = preflight('search', summarise([]), { focus: 'part time, marketing' });
ok('con il focus la conferma dice quali parole userà', /part time e marketing/.test(con.affects));
ok('con il focus la conferma avverte che il resto finisce in Fuori', /Fuori/.test(con.warning || ''));

// -- Snapshot and restore ---------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'apply-ui-test-'));
const queue = join(dir, 'apply-queue.tsv');

eq('the snapshot sits beside the queue', snapshotPath(queue), join(dir, 'apply-queue.backup.tsv'));
eq('nothing to snapshot when there is no queue yet', snapshot(queue), null);
throws('restoring with nothing saved throws instead of writing an empty queue', () => restore(queue));

writeFileSync(queue, 'prima\n');
snapshot(queue);
writeFileSync(queue, 'dopo\n');
eq('the queue really changed', readFileSync(queue, 'utf-8'), 'dopo\n');
restore(queue);
eq('restore puts the saved queue back', readFileSync(queue, 'utf-8'), 'prima\n');
ok('the snapshot survives a restore, so a second undo is possible', existsSync(snapshotPath(queue)));

rmSync(dir, { recursive: true, force: true });

