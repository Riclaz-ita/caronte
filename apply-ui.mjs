#!/usr/bin/env node
/**
 * apply-ui.mjs — a local front-end over the apply pipeline.
 *
 * The pipeline is four scripts that must run in order, and today the only way
 * to drive them is the terminal. This serves one page on localhost that runs
 * them with a button, shows what each one found, and lets the candidate decide
 * per role: apply, apply partially, skip, or read more.
 *
 * Three rules shape the whole file:
 *
 *   1. Nothing that writes runs without an explicit confirmation. Every phase
 *      first returns a preflight naming the files it will touch and the risk.
 *   2. Every write-phase snapshots the queue first, so a bad run is one
 *      button away from undone.
 *   3. The page never submits an application. The last step opens the form in
 *      a real browser with the fields filled; the human clicks Send.
 *
 * The triage phase needs a model. There is no API key on this machine, so it
 * shells out to the Claude Code CLI in headless mode with tools disabled — the
 * same subscription the candidate already has, no new credential to store.
 *
 * Usage:
 *   node apply-ui.mjs            # serve on http://localhost:4176
 *   node apply-ui.mjs --port N   # serve on another port
 */
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readQueue, writeQueue } from './apply-queue.mjs';
import { pendingTriage, loadJd } from './triage.mjs';
import {
  buildAnalysisPrompt, parseAnalysis, scoreFit, pendingAnalysis,
  saveAnalysis, loadAnalysis, analysisPath,
} from './analyze.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const QUEUE = resolve(getCareerOpsRoot(), 'data', 'apply-queue.tsv');
const PAGE = resolve(__dirname, 'apply-ui.html');
const CLAUDE_BIN = process.env.CAREER_OPS_CLAUDE_BIN || 'claude';

/**
 * Which model each token-spending phase runs on.
 *
 * Left to the CLI default both phases ran on Opus, and they are not the same
 * job. The triage sorts twenty-one postings against a written rubric and
 * returns four short fields: classification with the criteria supplied, which
 * is what Sonnet is for, and it is where nearly all the input tokens go —
 * roughly 40k in one request against 2k for one deep read.
 *
 * The deep read is the opposite shape. It runs on the few postings that
 * survived, it has to quote rather than paraphrase, and it has to be willing
 * to answer "not reachable" about a job the candidate wants. That judgement is
 * worth Opus, and on 2k of input it is the cheap half of the bill anyway.
 *
 * Both are overridable, because this is the candidate's spend and not a
 * decision that belongs hard-coded in a file he does not read.
 */
/**
 * Where the model calls run, and it is deliberately NOT this repo.
 *
 * Spawned inside the repo, `claude -p` loads the project's CLAUDE.md, which is
 * one line pulling in a 52kB AGENTS.md, and hands all of it to a request that
 * has no tools and no business reading it. Measured with a one-word prompt:
 * 39.158 input tokens from the repo, 24.360 from a neutral directory. Every
 * call was paying 14.798 tokens of instructions about a codebase it cannot
 * touch — once for the triage, and again for each of twenty-one deep reads.
 *
 * The prompts are self-contained: they arrive whole on stdin and carry the
 * posting text with them. Nothing on disk is needed, so nothing on disk is
 * loaded.
 */
export const MODEL_CWD = tmpdir();

/**
 * The flags every model call shares.
 *
 * No tools, no MCP servers, plain text out. `--strict-mcp-config` saves little
 * today (461 tokens, measured) but it makes the call hermetic: a server added
 * later cannot quietly start riding along on twenty-one requests.
 */
export function claudeArgs(model) {
  return ['-p', '--model', model, '--allowed-tools', '', '--strict-mcp-config', '--output-format', 'text'];
}

export const PHASE_MODEL = {
  triage: process.env.CAREER_OPS_TRIAGE_MODEL || 'sonnet',
  deep: process.env.CAREER_OPS_DEEP_MODEL || 'opus',
};

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/**
 * The four phases, in the order they must run.
 *
 * `writes` is not decoration: it is what the confirmation dialog shows the
 * candidate before anything happens, and what the error report names when a
 * phase dies halfway. Keep it accurate or the confirmation lies.
 */
export const PHASES = [
  {
    id: 'search',
    label: 'Cerca annunci',
    blurb: 'Scansiona i portali configurati, importa i nuovi annunci in coda e scarica le job description dalle API pubbliche.',
    cost: 'zero token',
    risk: 'low',
    writes: ['data/scan-history.tsv', 'data/pipeline.md', 'data/apply-queue.tsv', 'jds/'],
    reversible: true,
    steps: [
      { label: 'scansione portali', cmd: 'node', args: ['scan.mjs'] },
      { label: 'importa in coda', cmd: 'node', args: ['apply-queue.mjs', '--import-pipeline'] },
      { label: 'scarica le job description', cmd: 'node', args: ['fetch-jds.mjs', '--queue', 'data/apply-queue.tsv'] },
    ],
  },
  {
    id: 'triage',
    label: 'Valuta gli annunci',
    blurb: 'Dà a ogni annuncio un punteggio da 1 a 5 e scrive la riga di riepilogo da mettere in cima al CV per quella posizione.',
    cost: 'token — una richiesta per tutto il gruppo',
    risk: 'medium',
    writes: ['data/apply-queue.tsv'],
    reversible: true,
    steps: 'triage',
  },
  {
    id: 'deep',
    label: 'Analizza a fondo',
    blurb: 'Rilegge un annuncio alla volta per intero e restituisce i requisiti citati alla lettera, quanto ci sei vicino in percentuale, e cosa la lettera può dire di vero.',
    cost: 'token — una richiesta per annuncio',
    risk: 'medium',
    writes: ['analyses/'],
    reversible: true,
    steps: 'deep',
  },
  {
    id: 'packs',
    label: 'Prepara i documenti',
    blurb: 'Genera CV e lettera di presentazione in PDF per ogni annuncio sopra la soglia di punteggio.',
    cost: 'zero token',
    risk: 'low',
    writes: ['data/apply-queue.tsv', 'output/apply/'],
    reversible: true,
    steps: [{ label: 'genera i pacchetti', cmd: 'node', args: ['build-packs.mjs'] }],
  },
  {
    id: 'form',
    label: 'Apri e compila il form',
    blurb: 'Apre l\'annuncio in un browser vero e compila i campi per cui esiste una fonte. Non invia: l\'invio resta tuo.',
    cost: 'zero token',
    risk: 'high',
    writes: ['data/apply-queue.tsv'],
    reversible: true,
    steps: 'form',
  },
];

/** Look up a phase by id; null when the id is not one of the four. */
export function phaseById(id) {
  return PHASES.find((p) => p.id === id) || null;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * What each button on a role card does to that row.
 *
 * `partial` is the one that needs explaining. It means: build the documents,
 * then stop. The role never reaches the form phase, so the candidate reads the
 * generated CV and letter before anything is typed into a company's website.
 */
export const DECISIONS = {
  apply: { state: 'chosen', label: 'Candidati', blurb: 'Prepara i documenti e poi apri il form.' },
  partial: { state: 'partial', label: 'Solo documenti', blurb: 'Prepara CV e lettera, fermati lì: il form lo apri tu quando li hai letti.' },
  skip: { state: 'skipped', label: 'Ignora', blurb: 'Fuori dalla coda. Nessun documento, nessun form.' },
};

/**
 * Apply one decision to one row.
 *
 * Returns the new rows plus whether anything changed, so the caller can avoid
 * rewriting the queue file for a no-op click.
 */
export function applyDecision(rows, slug, decision) {
  const spec = DECISIONS[decision];
  if (!spec) throw new Error(`decisione sconosciuta: "${decision}"`);
  const i = rows.findIndex((r) => r.slug === slug);
  if (i === -1) throw new Error(`nessuna riga con slug "${slug}"`);
  if (rows[i].apply === spec.state) return { rows, changed: false };
  const next = [...rows];
  next[i] = { ...next[i], apply: spec.state };
  return { rows: next, changed: true };
}

// ---------------------------------------------------------------------------
// Focus della ricerca
// ---------------------------------------------------------------------------

/**
 * Normalise text so "Part-Time", "part time" and "PART_TIME" are one thing.
 *
 * Accents are stripped and every non-alphanumeric run becomes a single space,
 * which is what makes a typed term match a title regardless of the punctuation
 * the company used. Padding with spaces lets a caller anchor on word edges
 * without a second pass.
 */
function normalise(text) {
  return ` ${String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/**
 * Turn what the candidate typed into the groups the filter uses.
 *
 * Two separators, because a filter needs two answers. A comma adds a
 * requirement: "part time, marketing" wants both. A pipe offers a way of
 * meeting one: "part time | tempo parziale" wants either wording. So groups are
 * ANDed and the alternatives inside a group are ORed, which is what makes
 * ticking both "Part time" and "Full time" mean "either" rather than "neither".
 *
 * The result is an array of groups, each an array of alternatives.
 */
export function parseFocus(text) {
  return String(text || '')
    .split(',')
    .map((group) => group.split('|').map((t) => normalise(t).trim()).filter(Boolean))
    .filter((group) => group.length);
}

/**
 * Say a parsed focus back in words, for the confirmation to show.
 *
 * A group with alternatives gets brackets. Without them the list flattens into
 * "part time o tempo parziale e milano", which reads as three equal options and
 * hides the fact that Milano is a separate requirement.
 */
export function describeFocus(groups) {
  return groups
    .map((alts) => (alts.length > 1 ? `(${alts.join(' o ')})` : alts[0]))
    .join(' e ');
}

/**
 * Whether one posting answers every term of the focus.
 *
 * The job description is part of the haystack on purpose. "Part time" is
 * almost never in a title; it is in the third paragraph of the description.
 * A title-only filter would quietly discard exactly the postings the candidate
 * asked for.
 */
export function matchesFocus(row, jdText, groups) {
  if (!groups.length) return true;
  const hay = normalise(`${row.role} ${row.company} ${row.location} ${jdText || ''}`);
  // A term must start a word, and may run past its end: "market" catches
  // marketing and marketer, while "intern" no longer catches "external". The
  // haystack is space-padded, so a leading space is the whole word boundary.
  return groups.every((alts) => alts.some((t) => hay.includes(` ${t}`)));
}

/**
 * Set aside every fresh posting that falls outside the focus.
 *
 * Only untouched rows are eligible: a row the candidate already voted on, or
 * one the model already scored, keeps its state. A focus typed today must
 * never silently undo a decision made yesterday.
 *
 * Nothing is deleted — the rows become 'skipped', which the page shows under
 * "Fuori" with a button to put them back.
 */
export function applyFocus(rows, groups, loadJd = () => '') {
  if (!groups.length) return { rows, setAside: 0, kept: rows.length };
  let setAside = 0;
  let kept = 0;
  const next = rows.map((r) => {
    if (r.apply !== 'queued' || r.score !== '') return r;
    if (matchesFocus(r, loadJd(r.slug), groups)) { kept += 1; return r; }
    setAside += 1;
    return { ...r, apply: 'skipped' };
  });
  return { rows: setAside ? next : rows, setAside, kept };
}

// ---------------------------------------------------------------------------
// Selettori — gli stessi che usano gli script, non una loro approssimazione
// ---------------------------------------------------------------------------

/**
 * The score bar build-packs.mjs applies (its own `threshold` default).
 *
 * It is repeated here rather than imported because importing build-packs pulls
 * in the PDF renderer and the candidate's own letter file, neither of which a
 * page that only counts rows should need. tests/apply-ui reads the builder's
 * source and fails if the two ever drift.
 */
export const PACK_THRESHOLD = 3.5;

/**
 * The rows build-packs.mjs would actually build.
 *
 * Counting every row above 3 promised documents the builder, whose bar is 3.5,
 * would never produce: the board showed work pending, the phase ran and built
 * nothing, and the suggested next step stayed stuck on it forever.
 */
export function packsPending(rows) {
  return rows.filter((r) => r.pack === 'pending'
    && r.score !== ''
    && Number(r.score) >= PACK_THRESHOLD
    && r.apply !== 'skipped'
    && r.apply !== 'dead');
}

/**
 * The postings the triage would read, in the order it would read them.
 *
 * `pendingTriage` is the same gate the board counts with, and it is the whole
 * point: without it the pool was every unscored row, discarded ones included.
 * Asking for a single posting then spent the batch on the first row in the
 * file — almost certainly one already thrown out — while the board said the
 * batch would come from the 21 still in play.
 */
export function triageBatch(rows, limit, hasJd = () => true) {
  const pool = rows.filter((r) => pendingTriage(r) && hasJd(r.slug));
  if (limit === undefined) return pool;
  return pool.slice(0, Math.max(0, Math.min(limit, pool.length)));
}

/**
 * The row apply-session.mjs would open next.
 *
 * Mirrors that script's own filter. When this said `queued` and the board
 * counted `chosen`, pressing Candidati and then the form button answered
 * "nothing is ready" on a row the same page had just called ready.
 */
export function pickForForm(rows) {
  return rows.find((r) => (r.apply === 'queued' || r.apply === 'chosen')
    && (r.pack === 'built' || r.pack === 'jd_failed')) || null;
}

// ---------------------------------------------------------------------------
// Project state
// ---------------------------------------------------------------------------

/**
 * Everything the "Stato progetto" panel shows, derived from the queue alone.
 *
 * `readyToTriage` counts only rows whose JD actually landed: a row without a
 * job description has nothing for the model to read, and counting it would
 * promise a triage batch bigger than the one that can run.
 */
export function summarise(rows, hasJd = () => true, hasAnalysis = () => false) {
  const s = {
    total: rows.length,
    withJd: 0,
    readyToTriage: 0,
    scored: 0,
    reachable: 0,
    toAnalyse: 0,
    analysed: 0,
    packsTodo: 0,
    packsBuilt: 0,
    jdFailed: 0,
    inPlay: 0,
    chosen: 0,
    formReady: 0,
    partial: 0,
    skipped: 0,
    submitted: 0,
  };
  for (const r of rows) {
    const jd = hasJd(r.slug);
    if (jd) s.withJd += 1;
    if (jd && pendingTriage(r)) s.readyToTriage += 1;
    if (r.score !== '') s.scored += 1;
    if (r.score !== '' && Number(r.score) >= PACK_THRESHOLD && r.apply !== 'skipped' && r.apply !== 'dead') s.reachable += 1;
    if (r.pack === 'built') s.packsBuilt += 1;
    if (r.pack === 'jd_failed') s.jdFailed += 1;
    // Ancora in gioco: non scartato e leggibile. Sottrarre scartati e
    // illeggibili dal totale contava due volte le righe che sono entrambe le
    // cose, e la plancia diceva 5 dove erano 21.
    if (r.apply !== 'skipped' && r.apply !== 'dead' && r.pack !== 'jd_failed') s.inPlay += 1;
    if (r.apply === 'chosen' || r.apply === 'partial' || r.apply === 'submitted') s.chosen += 1;
    // Mirror apply-session's own selector. Counting a row whose documents do
    // not exist yet made the form preflight promise more than it could open.
    if (r.apply === 'chosen' && (r.pack === 'built' || r.pack === 'jd_failed')) s.formReady += 1;
    if (r.apply === 'partial') s.partial += 1;
    if (r.apply === 'skipped') s.skipped += 1;
    if (r.apply === 'submitted') s.submitted += 1;
  }
  s.toAnalyse = pendingAnalysis(rows, hasAnalysis).length;
  s.analysed = rows.filter((r) => hasAnalysis(r.slug)).length;
  s.packsTodo = packsPending(rows).length;
  return s;
}

/** The phase that makes sense to run next, or null when there is nothing to do. */
export function nextPhase(stats) {
  if (stats.total === 0) return 'search';
  if (stats.readyToTriage > 0) return 'triage';
  if (stats.toAnalyse > 0) return 'deep';
  if (stats.packsTodo > 0) return 'packs';
  if (stats.formReady > 0) return 'form';
  return null;
}

// ---------------------------------------------------------------------------
// Preflight — what the confirmation dialog says
// ---------------------------------------------------------------------------

/**
 * Describe a phase before it runs: what it will do, what it will touch, how
 * risky it is, and whether it can be undone.
 *
 * Every phase needs confirmation. That is deliberate and not configurable:
 * each one writes to the queue, and a queue written by the wrong phase at the
 * wrong time is exactly the incoherent state this front-end exists to avoid.
 */
export function preflight(phaseId, stats, opts = {}) {
  const phase = phaseById(phaseId);
  if (!phase) throw new Error(`fase sconosciuta: "${phaseId}"`);

  const limit = opts.limit;
  let affects;
  let warning = null;

  if (phaseId === 'search') {
    const groups = parseFocus(opts.focus);
    affects = groups.length
      ? `tutti i portali configurati, poi tiene solo gli annunci che parlano di: ${describeFocus(groups)}`
      : 'tutti i portali configurati';
    if (groups.length) {
      warning = 'Gli annunci nuovi fuori dal focus finiscono in "Fuori". Quelli su cui hai già deciso non si toccano.';
    }
  } else if (phaseId === 'triage') {
    const available = stats.readyToTriage;
    const n = limit === undefined ? available : Math.min(limit, available);
    affects = n === 1 ? `1 annuncio su ${available} pronti` : `${n} annunci su ${available} pronti`;
    if (available === 0) warning = 'Nessun annuncio da valutare: prima lancia la ricerca.';
    else if (n === 0) warning = 'Hai chiesto zero annunci: non verrà valutato niente.';
  } else if (phaseId === 'deep') {
    const available = stats.toAnalyse;
    const n = limit === undefined ? available : Math.min(limit, available);
    affects = n === 1 ? `1 annuncio su ${available} da leggere` : `${n} annunci su ${available} da leggere`;
    if (available === 0) warning = 'Nessun annuncio da analizzare: passano di qui solo quelli con voto 3 o più che non hai già letto.';
    else if (n === 0) warning = 'Hai chiesto zero annunci: non verrà letto niente.';
    else warning = 'Una richiesta per annuncio. Il conto cresce con la quantità, non è un giro solo.';
  } else if (phaseId === 'packs') {
    const n = stats.packsTodo;
    affects = `${n} annunci sopra la soglia di punteggio (${PACK_THRESHOLD})`;
    if (n <= 0) warning = 'Nessun annuncio in attesa di documenti.';
  } else {
    affects = `${stats.formReady} annunci pronti per il form`;
    if (stats.formReady === 0) warning = 'Nessun annuncio in coda: segna prima qualche ruolo come "Candidati".';
  }

  return {
    phase: phase.id,
    label: phase.label,
    blurb: phase.blurb,
    cost: phase.cost,
    model: PHASE_MODEL[phase.id] || null,
    risk: phase.risk,
    affects,
    writes: phase.writes,
    reversible: phase.reversible,
    rollback: phase.reversible
      ? 'La coda viene salvata prima di partire: con "Ripristina" torni allo stato di adesso.'
      : null,
    warning,
    needsConfirm: true,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Known failures, matched against the combined output of a dead step.
 *
 * Order matters: the first match wins, so specific patterns go above generic
 * ones. An unmatched failure is treated as blocking — refusing to guess is the
 * safe default when the front-end cannot tell the candidate what broke.
 */
const KNOWN_FAILURES = [
  {
    match: /unsupported ATS host/i,
    explain: 'Alcuni annunci stanno su siti che non espongono un\'API pubblica, quindi il testo non è scaricabile.',
    hint: 'Non è un problema: gli altri annunci proseguono. Quelli senza testo restano segnati e li puoi leggere a mano.',
    blocking: false,
  },
  {
    match: /cover-base\.json/i,
    explain: 'Manca il file con i tuoi dati per la lettera di presentazione.',
    hint: 'Copia cover-base.example.json in cover-base.json e riempilo con i tuoi dati.',
    blocking: true,
  },
  {
    match: /cv-variants\.yml/i,
    explain: 'Manca o è malformato il file che collega ogni tipo di ruolo al CV base da usare.',
    hint: 'Copia cv-variants.example.yml in cv-variants.yml e fai puntare ogni voce a un CV che esiste in output/.',
    blocking: true,
  },
  {
    match: /summary slot|summary-text/i,
    explain: 'Un CV base non ha lo spazio dove va inserita la riga su misura, quindi manderesti un CV generico senza accorgertene.',
    hint: 'Apri il CV indicato e aggiungi il blocco <div class="summary-text"> attorno al testo del profilo.',
    blocking: true,
  },
  {
    match: /(ENOENT|not found)[^\n]*claude|claude[^\n]*(ENOENT|not found)|command not found/i,
    explain: 'Non trovo il comando "claude": la valutazione ha bisogno di Claude Code per dare i punteggi.',
    hint: 'Verifica che "claude" risponda dal terminale, oppure imposta CAREER_OPS_CLAUDE_BIN con il percorso completo.',
    blocking: true,
  },
  {
    match: /duplicate slug/i,
    explain: 'Il modello ha risposto due volte per lo stesso annuncio, quindi non è chiaro quale verdetto valga.',
    hint: 'Rilancia la valutazione su un gruppo più piccolo.',
    blocking: true,
  },
  {
    match: /JSON|parse/i,
    explain: 'La risposta della valutazione non era nel formato atteso.',
    hint: 'Rilancia: di solito basta. Se si ripete, riduci il numero di annunci per gruppo.',
    blocking: true,
  },
];

/**
 * Turn a dead step into the report the page shows: what broke, where, on which
 * files, whether it stops everything, and what to do about it.
 */
export function shapeError({ phaseId, step, message, output = '' }) {
  const phase = phaseById(phaseId);
  const haystack = `${message}\n${output}`;
  const known = KNOWN_FAILURES.find((k) => k.match.test(haystack));

  return {
    phase: phaseId,
    phaseLabel: phase ? phase.label : phaseId,
    step: step || null,
    message: String(message || '').split('\n')[0].slice(0, 300),
    files: phase ? phase.writes : [],
    blocking: known ? known.blocking : true,
    explain: known
      ? known.explain
      : 'Il comando si è fermato con un errore che non riconosco.',
    hint: known
      ? known.hint
      : 'Guarda il log completo qui sotto. Se non è chiaro, usa "Ripristina" per tornare allo stato precedente.',
    actions: known && !known.blocking
      ? ['continua', 'dettagli']
      : ['riprova', 'ripristina', 'dettagli'],
    output: String(output || '').slice(-4000),
  };
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/** Where the pre-run copy of the queue lives. One slot: the last good state. */
export function snapshotPath(queuePath = QUEUE) {
  return queuePath.replace(/\.tsv$/, '.backup.tsv');
}

/** Copy the queue aside before a phase writes to it. No queue yet means nothing to save. */
export function snapshot(queuePath = QUEUE) {
  if (!existsSync(queuePath)) return null;
  const dest = snapshotPath(queuePath);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(queuePath, dest);
  return dest;
}

/** Put the saved queue back. Throws when there is nothing to restore. */
export function restore(queuePath = QUEUE) {
  const src = snapshotPath(queuePath);
  if (!existsSync(src)) throw new Error('Nessuno stato salvato da ripristinare.');
  copyFileSync(src, queuePath);
  return queuePath;
}

// ---------------------------------------------------------------------------
// Running phases
// ---------------------------------------------------------------------------

const runs = new Map();
let runSeq = 0;

function newRun(phaseId) {
  const id = `run-${++runSeq}`;
  const run = { id, phase: phaseId, status: 'running', lines: [], error: null, startedAt: Date.now() };
  runs.set(id, run);
  return run;
}

function log(run, line) {
  for (const l of String(line).split('\n')) {
    if (l.trim()) run.lines.push(l.replace(/\s+$/, ''));
  }
  if (run.lines.length > 600) run.lines.splice(0, run.lines.length - 600);
}

/** Run one command, collecting its output into the run log. Resolves with the exit code. */
function exec(run, { label, cmd, args, cwd = __dirname, input = null }) {
  return new Promise((done) => {
    log(run, `→ ${label}`);
    const child = spawn(cmd, args, { cwd });
    let output = '';
    const take = (buf) => { output += buf; log(run, buf.toString()); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    if (input !== null) { child.stdin.write(input); child.stdin.end(); }
    child.on('error', (err) => done({ code: -1, output: `${output}\n${err.message}`, label }));
    child.on('close', (code) => done({ code, output, label }));
  });
}

/** Ask Claude Code to triage a batch of postings, then write the verdicts into the queue. */
async function runTriage(run, limit) {
  const { buildBatchPrompt, parseVerdicts, ingestVerdicts } = await import('./triage.mjs');
  const rows = readQueue(QUEUE);
  const batch = triageBatch(rows, limit, (slug) => Boolean(loadJd(slug)));
  if (!batch.length) {
    log(run, limit === 0 ? 'Quantità richiesta: zero. Non valuto niente.' : 'Nessun annuncio da valutare.');
    return;
  }

  const entries = batch.map((r) => ({
    slug: r.slug, company: r.company, role: r.role, location: r.location, jd: loadJd(r.slug),
  }));

  log(run, `Modello: ${PHASE_MODEL.triage}.`);
  log(run, entries.length === 1
    ? `Valuto 1 annuncio con Claude Code: ${entries[0].company} — ${entries[0].role}.`
    : `Valuto ${entries.length} annunci con Claude Code.`);
  // The prompt goes on stdin, not argv: a 40-posting batch is far past the
  // shell's argument limit, and a truncated prompt would silently triage
  // fewer postings than it reported.
  const r = await exec(run, {
    label: `valutazione di ${entries.length} annunci`,
    cmd: CLAUDE_BIN,
    args: claudeArgs(PHASE_MODEL.triage),
    cwd: MODEL_CWD,
    input: buildBatchPrompt(entries),
  });
  if (r.code !== 0) throw Object.assign(new Error(`la valutazione è uscita con codice ${r.code}`), { step: r.label, output: r.output });

  const verdicts = parseVerdicts(r.output);
  const next = ingestVerdicts(rows, verdicts);
  writeQueue(QUEUE, next);
  log(run, `Scritti ${verdicts.length} verdetti in coda.`);
}

/**
 * Read a few postings properly, one request each.
 *
 * One posting per request is the whole point: a batch would truncate the long
 * answers and let one posting's requirements bleed into the next one's. A
 * failure on one posting is logged and the rest continue — twelve good
 * analyses and one error beats nothing at all.
 */
async function runDeep(run, limit) {
  const rows = readQueue(QUEUE);
  const batch = pendingAnalysis(rows, (slug) => loadAnalysis(slug) !== null)
    .filter((r) => loadJd(r.slug));
  const take = limit === undefined ? batch : batch.slice(0, Math.max(0, Math.min(limit, batch.length)));
  if (!take.length) {
    log(run, limit === 0 ? 'Quantità richiesta: zero. Non leggo niente.' : 'Nessun annuncio da analizzare.');
    return;
  }

  log(run, `Leggo ${take.length === 1 ? '1 annuncio' : `${take.length} annunci`}, uno per richiesta. Modello: ${PHASE_MODEL.deep}.`);
  let fatti = 0;
  const falliti = [];
  for (const row of take) {
    const r = await exec(run, {
      label: `${row.company} — ${row.role}`,
      cmd: CLAUDE_BIN,
      args: claudeArgs(PHASE_MODEL.deep),
      cwd: MODEL_CWD,
      input: buildAnalysisPrompt({
        slug: row.slug, company: row.company, role: row.role,
        location: row.location, jd: loadJd(row.slug),
      }),
    });
    if (r.code !== 0) { falliti.push(`${row.slug}: uscito con codice ${r.code}`); continue; }
    try {
      const analysis = parseAnalysis(r.output, row.slug);
      saveAnalysis(row.slug, analysis);
      const fit = scoreFit(analysis);
      fatti += 1;
      log(run, fit.blocked
        ? `  ✗ non raggiungibile — ${fit.blockers[0]}`
        : `  ${fit.percent}% su ${fit.total} requisiti`);
    } catch (err) {
      falliti.push(`${row.slug}: ${err.message}`);
    }
  }

  log(run, `Letti ${fatti} annunci su ${take.length}.`);
  // A whole batch that failed is a broken setup, not bad luck, and it stops
  // here so the page reports it instead of showing an empty result as done.
  if (fatti === 0) {
    throw Object.assign(new Error("nessun annuncio è stato analizzato"), {
      step: 'analisi', output: falliti.join('\n'),
    });
  }
  if (falliti.length) log(run, `Non letti: ${falliti.join(' · ')}`);
}

/** Open one queued posting in a real browser with its fields filled. */
async function runForm(run) {
  const rows = readQueue(QUEUE);
  const target = pickForForm(rows);
  if (!target) { log(run, 'Nessun annuncio pronto per il form.'); return; }
  log(run, `Apro ${target.company} — ${target.role}`);
  const r = await exec(run, {
    label: 'compilazione form',
    cmd: 'node',
    args: ['apply-session.mjs', '--slug', target.slug],
  });
  if (r.code !== 0) throw Object.assign(new Error(`la compilazione è uscita con codice ${r.code}`), { step: r.label, output: r.output });
}

/**
 * Narrow the fresh postings down to the focus the candidate typed.
 *
 * It runs last in the search phase, after the job descriptions are on disk,
 * because the description is where a term like "part time" actually appears.
 */
function runFocus(run, focus) {
  const groups = parseFocus(focus);
  if (!groups.length) return;
  const rows = readQueue(QUEUE);
  const { rows: next, setAside, kept } = applyFocus(rows, groups, loadJd);
  if (setAside) writeQueue(QUEUE, next);
  log(run, `Filtro "${describeFocus(groups)}": ${kept} annunci lo rispettano, ${setAside} finiti in Fuori.`);
}

/** Drive one phase end to end, snapshotting first and shaping any failure. */
async function runPhase(run, phase, opts) {
  try {
    snapshot();
    if (phase.steps === 'triage') {
      await runTriage(run, opts.limit);
    } else if (phase.steps === 'deep') {
      await runDeep(run, opts.limit);
    } else if (phase.steps === 'form') {
      await runForm(run);
    } else {
      for (const step of phase.steps) {
        const r = await exec(run, step);
        // fetch-jds exits non-zero only when nothing at all could be read;
        // per-posting failures are normal and must not stop the chain.
        if (r.code !== 0) {
          throw Object.assign(new Error(`"${step.label}" è uscito con codice ${r.code}`), { step: step.label, output: r.output });
        }
      }
      if (phase.id === 'search') runFocus(run, opts.focus);
    }
    run.status = 'done';
  } catch (err) {
    run.status = 'error';
    run.error = shapeError({
      phaseId: phase.id,
      step: err.step,
      message: err.message,
      output: err.output || run.lines.slice(-40).join('\n'),
    });
  } finally {
    run.finishedAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((done, fail) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) fail(new Error('corpo troppo grande')); });
    req.on('end', () => { try { done(raw ? JSON.parse(raw) : {}); } catch { fail(new Error('JSON non valido')); } });
  });
}

/** Whether a posting's job description made it to disk. */
function jdExists(slug) {
  return existsSync(join(getCareerOpsRoot(), 'jds', `${slug}.md`));
}

/** The compact form of an analysis the board shows on a row. */
function fitOf(slug) {
  const a = loadAnalysis(slug);
  if (!a) return null;
  const fit = scoreFit(a);
  return {
    percent: fit.percent, blocked: fit.blocked, blockers: fit.blockers,
    total: fit.total, sintesi: a.sintesi || '',
  };
}

function currentState() {
  const rows = readQueue(QUEUE);
  const stats = summarise(rows, jdExists, (slug) => existsSync(analysisPath(slug)));
  return {
    stats,
    next: nextPhase(stats),
    canRestore: existsSync(snapshotPath()),
    phases: PHASES.map((p) => ({ id: p.id, label: p.label, blurb: p.blurb, cost: p.cost, risk: p.risk })),
    decisions: DECISIONS,
    rows: rows
      .map((r) => ({
        slug: r.slug, url: r.url, company: r.company, role: r.role, location: r.location,
        archetype: r.archetype, level: r.level, score: r.score, summary_line: r.summary_line,
        pack: r.pack, apply: r.apply, jd: jdExists(r.slug), fit: fitOf(r.slug),
      }))
      .sort((a, b) => (b.score === '' ? -1 : Number(b.score)) - (a.score === '' ? -1 : Number(a.score))),
  };
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        const html = readFileSync(PAGE, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(res, 200, currentState());
      }

      if (req.method === 'POST' && url.pathname === '/api/preflight') {
        const body = await readBody(req);
        return json(res, 200, preflight(body.phase, currentState().stats, { limit: body.limit, focus: body.focus }));
      }

      if (req.method === 'POST' && url.pathname === '/api/run') {
        const body = await readBody(req);
        const phase = phaseById(body.phase);
        if (!phase) return json(res, 400, { error: `fase sconosciuta: "${body.phase}"` });
        // 428 Precondition Required: the phase is valid but the candidate has
        // not yet seen what it would do. The body is the dialog to show.
        if (body.confirm !== true) {
          return json(res, 428, preflight(phase.id, currentState().stats, { limit: body.limit, focus: body.focus }));
        }
        const run = newRun(phase.id);
        runPhase(run, phase, { limit: body.limit, focus: body.focus });
        return json(res, 202, { runId: run.id });
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/analysis/')) {
        const slug = decodeURIComponent(url.pathname.slice('/api/analysis/'.length));
        const a = loadAnalysis(slug);
        if (!a) return json(res, 404, { error: 'nessuna analisi per questo annuncio' });
        return json(res, 200, { ...a, fit: scoreFit(a) });
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/run/')) {
        const run = runs.get(url.pathname.slice('/api/run/'.length));
        if (!run) return json(res, 404, { error: 'esecuzione sconosciuta' });
        return json(res, 200, { id: run.id, phase: run.phase, status: run.status, lines: run.lines, error: run.error });
      }

      if (req.method === 'POST' && url.pathname === '/api/decide') {
        const body = await readBody(req);
        const rows = readQueue(QUEUE);
        const { rows: next, changed } = applyDecision(rows, body.slug, body.decision);
        if (changed) { snapshot(); writeQueue(QUEUE, next); }
        return json(res, 200, { changed, state: DECISIONS[body.decision].state });
      }

      if (req.method === 'POST' && url.pathname === '/api/restore') {
        const body = await readBody(req);
        if (body.confirm !== true) {
          return json(res, 428, {
            phase: 'restore',
            label: 'Ripristina',
            blurb: 'Rimette la coda com\'era prima dell\'ultima operazione che l\'ha scritta.',
            risk: 'high',
            affects: 'tutte le decisioni e i punteggi presi da allora',
            writes: ['data/apply-queue.tsv'],
            warning: 'I documenti già generati in output/apply/ restano dove sono: torna indietro solo la coda.',
            needsConfirm: true,
          });
        }
        restore();
        return json(res, 200, { restored: true });
      }

      json(res, 404, { error: 'non trovato' });
    } catch (err) {
      json(res, 500, shapeError({ phaseId: url.pathname, message: err.message }));
    }
  });
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 4176;
  createApp().listen(port, '127.0.0.1', () => {
    console.log(`career-ops apply UI → http://localhost:${port}`);
  });
}
