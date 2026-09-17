#!/usr/bin/env node
/**
 * web-search.mjs — Level 3 of the scan, the web search, for Caronte.
 *
 * scan.mjs reads career pages and boards that have an API. The skill's scan
 * adds a web search over `search_queries` in portals.yml, which is what
 * surfaces postings on LinkedIn, Indeed and companies nobody listed. Caronte
 * had no such step. This is that step, through the paths scan.mjs already
 * owns rather than a second copy of them:
 *
 *   - the search runs in Claude Code with WebSearch as its ONLY tool: no shell,
 *     no file access, no fetch. Search results are untrusted text, so the
 *     worker can read them and nothing else;
 *   - its answer is parsed as JSON and every URL is re-validated here;
 *   - title_filter and location_filter from portals.yml apply, as in scan.mjs;
 *   - dedup is loadSeenUrls() (history + pipeline + tracker);
 *   - the write is appendToPipeline() + appendToScanHistory(), under their lock.
 *
 * Search results can be weeks stale (modes/scan.md, Level 3). Nothing here
 * claims a posting is open: fetch-jds reads the page next, and the apply
 * session's identity gate stops on a closed one.
 *
 * Usage:
 *   node web-search.mjs              # run the enabled queries
 *   node web-search.mjs --dry-run    # print what would be added, write nothing
 */
import { readFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { isIP } from 'net';
import * as yaml from 'js-yaml';
import {
  PORTALS_PATH, loadSeenUrls, normalizeUrlForDedup, appendToPipeline, appendToScanHistory,
  buildLocationFilter,
} from './scan.mjs';
import { buildTitleFilter } from './title-keywords.mjs';
import { DATA_BARRIER } from './triage.mjs';
import { checkLivenessViaApi } from './liveness-api.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';

const CLAUDE_BIN = process.env.CAREER_OPS_CLAUDE_BIN || 'claude';
/**
 * Opus 5 at medium effort, by default and on every run.
 *
 * The step reads search results and decides which link is one job posting and
 * which is a listing page, a news article or a company homepage. A smaller
 * model gets that wrong often enough that the queue fills with rubbish, and
 * the whole run is one request: the better model costs pennies more per run.
 * Medium effort is the working point, high burns time on a sorting job.
 */
export const MODEL = process.env.CAREER_OPS_WEBSEARCH_MODEL || 'claude-opus-5';
export const EFFORT = process.env.CAREER_OPS_WEBSEARCH_EFFORT || 'medium';
/** Cap on queries per run: each one is a paid search. */
export const MAX_QUERIES = 12;
const TIMEOUT_MS = 15 * 60_000;

/** The flags for a worker that may search the web and do nothing else. */
export function webSearchArgs(model = MODEL, effort = EFFORT) {
  return ['-p', '--model', model, '--effort', effort, '--tools', 'WebSearch', '--allowedTools', 'WebSearch',
    '--strict-mcp-config', '--no-session-persistence', '--output-format', 'text'];
}

export function buildWebSearchPrompt(queries) {
  return [
    'Run each web search query below with the WebSearch tool, once each.',
    'From the results, keep ONLY links to a single job posting page (one job, not a list,',
    'not a search page, not a company homepage, not a news article).',
    '',
    'Return ONLY a JSON array, no prose around it:',
    '[{"url":"...","company":"...","title":"...","location":"..."}]',
    'Use the text of the search result for company, title and location. Leave a field as ""',
    'when the result does not say it; never guess. An empty array is a valid answer.',
    '',
    DATA_BARRIER.replace('The posting text below', 'The search results'),
    '',
    'Queries:',
    ...queries.map((q, i) => `${i + 1}. ${q}`),
  ].join('\n');
}

const SEARCH_PAGE = [
  /linkedin\.com\/jobs\/(search|collections)/i,
  /indeed\.[a-z.]+\/(jobs|q-|lavoro|offerte)(?![^?]*jk=)/i,
];

/** A URL a posting can live at: http(s), a public hostname, not a search page. */
export function isPostingUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host.includes('.') || isIP(host) || /(^|\.)(localhost|local|internal)$/i.test(host)) return false;
  return !SEARCH_PAGE.some((re) => re.test(u.href));
}

/** Parse the worker's answer into clean offers. Throws on a non-JSON answer. */
export function parseWebResults(text) {
  const cleaned = String(text).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  let data;
  try { data = JSON.parse(start === -1 ? cleaned : cleaned.slice(start, end + 1)); } catch {
    throw new Error('la ricerca web non ha restituito JSON leggibile');
  }
  if (!Array.isArray(data)) throw new Error('la ricerca web non ha restituito una lista');
  const str = (v) => (typeof v === 'string' ? v.replace(/[\t\r\n|]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 200) : '');
  return data
    .filter((r) => r && typeof r === 'object' && isPostingUrl(r.url))
    .map((r) => ({ url: String(r.url).trim(), company: str(r.company), title: str(r.title), location: str(r.location), source: 'websearch' }));
}

/** Keep what scan.mjs would keep: new URL, title passes, location passes. */
export function selectNew(offers, { seen, titleOk = () => true, locationOk = () => true }) {
  const out = [];
  const taken = new Set();
  for (const o of offers) {
    const key = normalizeUrlForDedup(o.url);
    if (seen.has(key) || taken.has(key)) continue;
    // An empty title is unknown, not a mismatch: the triage reads the page.
    if (o.title && !titleOk(o.title)) continue;
    if (o.location && !locationOk(o.location, o.url, o.title)) continue;
    taken.add(key);
    out.push(o);
  }
  return out;
}

/**
 * Drop postings that are already closed.
 *
 * A search index keeps a LinkedIn posting for years after it closes: the first
 * real run returned mostly 2020-2023 postings, every one "No longer accepting
 * applications". checkLivenessViaApi reads LinkedIn and the ATS APIs without a
 * browser. `expired` is dropped; `active` is kept; a URL no API can read
 * (null) or cannot decide (uncertain) is kept and counted, because the apply
 * session's identity gate still stops on a dead page.
 */
export async function keepOpen(offers, check = checkLivenessViaApi) {
  const kept = [];
  const stats = { active: 0, expired: 0, unknown: 0 };
  for (const o of offers) {
    let verdict = null;
    try { verdict = await check(o.url); } catch { verdict = null; }
    if (verdict?.result === 'expired') { stats.expired += 1; continue; }
    if (verdict?.result === 'active') stats.active += 1; else stats.unknown += 1;
    kept.push(o);
  }
  return { kept, stats };
}

export function enabledQueries(cfg) {
  return (cfg.search_queries || [])
    .filter((q) => q && q.enabled !== false && typeof q.query === 'string' && q.query.trim())
    .map((q) => q.query.trim())
    .slice(0, MAX_QUERIES);
}

if (isMainModule(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  if (!existsSync(PORTALS_PATH)) { console.error(`${PORTALS_PATH} non c'è`); process.exit(1); }
  const cfg = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  const queries = enabledQueries(cfg);
  if (!queries.length) { console.log('Nessuna query attiva in search_queries: ricerca web saltata.'); process.exit(0); }

  console.log(`Ricerca web: ${queries.length} query con ${MODEL}, effort ${EFFORT}.`);
  const r = spawnSync(CLAUDE_BIN, webSearchArgs(), {
    input: buildWebSearchPrompt(queries), cwd: tmpdir(), encoding: 'utf-8', timeout: TIMEOUT_MS,
  });
  if (r.error || r.status !== 0) {
    // The CLI prints its own failures (limits, auth) on stdout, not stderr.
    console.error(`la ricerca web è uscita con codice ${r.status ?? -1}: ${(r.error?.message || r.stderr || r.stdout || '').trim().slice(0, 400)}`);
    process.exit(1);
  }

  const found = parseWebResults(r.stdout);
  const fresh = selectNew(found, {
    seen: loadSeenUrls().seen,
    titleOk: buildTitleFilter(cfg.title_filter),
    locationOk: buildLocationFilter(cfg.location_filter),
  });
  console.log(`Trovati ${found.length} annunci, nuovi e dentro i filtri ${fresh.length}.`);
  const { kept, stats } = await keepOpen(fresh);
  console.log(`Ancora aperti: ${stats.active} confermati, ${stats.unknown} non verificabili; ${stats.expired} chiusi scartati.`);
  for (const o of kept) console.log(`  + ${o.company || '?'} — ${o.title || '?'} | ${o.location || ''} | ${o.url}`);
  if (dryRun || !kept.length) process.exit(0);

  await appendToPipeline(kept);
  await appendToScanHistory(kept, localToday());
  console.log(`Aggiunti ${kept.length} annunci a data/pipeline.md.`);
}
