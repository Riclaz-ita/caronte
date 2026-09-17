#!/usr/bin/env node
/**
 * fetch-jds.mjs — pull job description text from public ATS APIs into jds/.
 *
 * Zero tokens and no browser: Ashby, Greenhouse and Lever all expose the full
 * posting over public HTTP. Anything else throws and the caller records the
 * row as jd_failed, to be read from the DOM during the apply session instead.
 *
 * Usage:
 *   node fetch-jds.mjs --queue data/apply-queue.tsv
 *   node fetch-jds.mjs --url https://jobs.ashbyhq.com/acme/123 --company Acme
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, resolve } from 'path';
import { classifyLiveness } from './liveness-core.mjs';
import { resolveAtsApi, classifyLinkedInPosting, throttleProviderRequest } from './liveness-api.mjs';
import { fileURLToPath } from 'url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ASHBY_QUERY =
  'query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) ' +
  '{ jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) ' +
  '{ title locationName employmentType descriptionHtml } }';

/** Identify which ATS serves a posting URL, or null when unsupported. */
export function atsOf(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.hostname === 'jobs.ashbyhq.com') return 'ashby';
  if (/(^|\.)greenhouse\.io$/.test(u.hostname)) return 'greenhouse';
  if (u.hostname === 'jobs.lever.co') return 'lever';
  // Greenhouse behind a company's own domain: sumup.com/careers/...?gh_jid=N,
  // storyblok.com/job?gh_jid=N. The board name is the company's own domain
  // label, which the public boards API accepts as-is.
  if (u.searchParams.has('gh_jid')) return 'greenhouse';
  return null;
}

/** Stable filesystem-safe id for a posting. */
export function jdSlug(company, title) {
  return `${company} ${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Convert posting HTML to plain text that reads well in a terminal and a prompt. */
export function stripHtml(html = '') {
  return String(html || '')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetch one posting. Throws on unsupported host, a transport failure or a
 * missing posting.
 *
 * Every branch checks r.ok before r.json(): a 429 or an anti-bot HTML page
 * otherwise threw a bare SyntaxError, which read as "unsupported posting"
 * rather than "try again later".
 */
export async function fetchJd(url) {
  const ats = atsOf(url);
  if (!ats) throw new Error(`unsupported ATS host: ${url}`);
  const u = new URL(url);

  if (ats === 'ashby') {
    const [, org, id] = u.pathname.split('/');
    const r = await fetch('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationName: 'ApiJobPosting',
        variables: { organizationHostedJobsPageName: org, jobPostingId: id },
        query: ASHBY_QUERY,
      }),
    });
    if (!r.ok) throw new Error(`ashby: HTTP ${r.status} ${r.statusText}`);
    const p = (await r.json())?.data?.jobPosting;
    if (!p) throw new Error('ashby: posting not found');
    return { title: p.title, location: p.locationName || '', type: p.employmentType || '', body: stripHtml(p.descriptionHtml) };
  }

  if (ats === 'greenhouse') {
    const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
    const ghJid = u.searchParams.get('gh_jid');
    const [board, id] = m
      ? [m[1], m[2]]
      : [u.hostname.replace(/^www\./, '').split('.')[0], ghJid];
    if (!board || !id) throw new Error('greenhouse: unrecognised path');
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`);
    if (!r.ok) throw new Error(`greenhouse: HTTP ${r.status} ${r.statusText}`);
    const j = await r.json();
    if (!j.title) throw new Error('greenhouse: posting not found');
    return { title: j.title, location: j.location?.name || '', type: '', body: stripHtml(j.content) };
  }

  const [, slug, id] = u.pathname.split('/');
  const r = await fetch(`https://api.lever.co/v0/postings/${slug}/${id}`);
  if (!r.ok) throw new Error(`lever: HTTP ${r.status} ${r.statusText}`);
  const j = await r.json();
  if (!j.text) throw new Error('lever: posting not found');
  const lists = (j.lists || []).map((l) => `\n## ${l.text}\n${stripHtml(l.content)}`).join('\n');
  return {
    title: j.text,
    location: j.categories?.location || '',
    type: j.categories?.commitment || '',
    body: `${stripHtml(j.description)}${lists}\n${stripHtml(j.additional || '')}`.trim(),
  };
}

/**
 * Read a posting no public API serves (LinkedIn, Indeed, a company page) with
 * the core's read-only headless reader, browser-extract.mjs.
 *
 * The web search brings exactly these, and without text a row never reaches
 * the triage. The page is judged by the core's own liveness classifier: a
 * closed posting, an anti-bot wall or a near-empty page is a failure with its
 * reason, never a JD made of cookie banners.
 */
export function judgeExtraction(url, extracted) {
  const text = String(extracted?.text || '');
  const verdict = classifyLiveness({ status: 200, requestedUrl: url, finalUrl: extracted?.url || url, bodyText: text, applyControls: [] });
  if (verdict.result === 'expired') return { ok: false, closed: true, reason: `annuncio chiuso (${verdict.reason})` };
  if (verdict.code === 'bot_challenge') return { ok: false, reason: 'pagina protetta da anti-bot' };
  if (text.trim().length < 300) return { ok: false, reason: 'pagina quasi vuota' };
  return { ok: true };
}

/**
 * A LinkedIn posting's text from the same public guest endpoint the core's
 * liveness check reads (liveness-api.mjs), paced by that module's own
 * LinkedIn throttle. The logged-in page redirects a script to a search page,
 * so the browser path cannot read it. A closed posting throws with `closed`.
 */
export function parseLinkedInPosting(html) {
  const verdict = classifyLinkedInPosting(html);
  if (verdict?.result === 'expired') return { closed: true, reason: verdict.reason };
  const body = String(html || '').match(/class="show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  const title = String(html || '').match(/class="top-card-layout__title[^"]*"[^>]*>([\s\S]*?)<\/h2>/);
  const location = String(html || '').match(/class="topcard__flavor topcard__flavor--bullet"[^>]*>([\s\S]*?)<\/span>/);
  const text = body ? stripHtml(body[1]) : '';
  if (text.length < 300) return { closed: false, reason: 'descrizione LinkedIn assente o quasi vuota' };
  return {
    jd: {
      title: title ? stripHtml(title[1]) : '',
      location: location ? stripHtml(location[1]) : '',
      type: '',
      body: text,
    },
  };
}

export async function fetchLinkedInJd(url, doFetch = fetch) {
  const resolved = resolveAtsApi(url);
  if (resolved?.ats !== 'linkedin') throw new Error(`not a LinkedIn posting: ${url}`);
  await throttleProviderRequest('linkedin', resolved.throttleMs);
  const r = await doFetch(resolved.apiUrl, {
    headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
    redirect: 'error',
  });
  if (!r.ok) throw new Error(`linkedin: HTTP ${r.status} ${r.statusText}`);
  const parsed = parseLinkedInPosting(await r.text());
  if (!parsed.jd) throw Object.assign(new Error(`linkedin: ${parsed.closed ? `annuncio chiuso (${parsed.reason})` : parsed.reason}`), { closed: parsed.closed });
  return parsed.jd;
}

export function fetchJdViaBrowser(url, run = spawnSync) {
  const r = run(process.execPath, [resolve(__dirname, 'browser-extract.mjs'), url, '--mode', 'jd', '--max-chars', '16000'],
    { encoding: 'utf-8', timeout: 90_000 });
  let extracted = null;
  try { extracted = JSON.parse(r.stdout || ''); } catch { /* reported below */ }
  if (r.status !== 0 || !extracted || extracted.error) {
    throw new Error(`browser: ${extracted?.error || r.error?.message || `uscito con codice ${r.status}`}`);
  }
  const judged = judgeExtraction(url, extracted);
  if (!judged.ok) throw Object.assign(new Error(`browser: ${judged.reason}`), { closed: Boolean(judged.closed) });
  return { title: extracted.title || '', location: '', type: '', body: extracted.text };
}

/**
 * The row after one fetch attempt.
 *
 * jd_failed was a terminal state: nothing cleared it, build-packs filters on
 * 'pending' and the apply session on 'built', so an unsupported or
 * rate-limited posting vanished from the pipeline for good. A later success
 * puts the row back in 'pending' so the rest of the pipeline picks it up.
 */
export function rowAfterFetch(row, fetched) {
  if (!fetched) return { ...row, pack: 'jd_failed' };
  return row.pack === 'jd_failed' ? { ...row, pack: 'pending' } : row;
}

/** Write one fetched posting to jds/{slug}.md and return the path. */
export function writeJd(slug, company, url, jd) {
  const path = resolve(getCareerOpsRoot(), 'jds', `${slug}.md`);
  mkdirSync(dirname(path), { recursive: true });
  const header = `# ${company} — ${jd.title}\n\n**URL:** ${url}\n**Location:** ${jd.location || 'n/a'}\n` +
    `**Type:** ${jd.type || 'n/a'}\n**Fetched:** ${new Date().toISOString().slice(0, 10)}\n\n---\n\n`;
  writeFileSync(path, `${header}${jd.body}\n`);
  return path;
}

if (isMainModule(import.meta.url)) {
  const { readQueue, updateQueue, patchRow } = await import('./apply-queue.mjs');
  const args = process.argv.slice(2);
  const queuePath = args.includes('--queue') ? args[args.indexOf('--queue') + 1] : null;
  if (!queuePath) { console.error('Usage: node fetch-jds.mjs --queue data/apply-queue.tsv'); process.exit(1); }

  // Relative to the data root, not to this file: with CAREER_OPS_ROOT set the
  // panel and this script otherwise read two different queues.
  const queue = resolve(getCareerOpsRoot(), queuePath);
  const rows = readQueue(queue);
  const pending = rows.filter((r) => !existsSync(resolve(getCareerOpsRoot(), 'jds', `${r.slug}.md`)));
  console.log(`Fetching ${pending.length} job descriptions...`);

  let ok = 0;
  for (const row of pending) {
    let fetched = false;
    try {
      const jd = atsOf(row.url) ? await fetchJd(row.url)
        : resolveAtsApi(row.url)?.ats === 'linkedin' ? await fetchLinkedInJd(row.url)
        : fetchJdViaBrowser(row.url);
      writeJd(row.slug, row.company, row.url, jd);
      fetched = true;
      ok += 1;
      console.log(`OK   ${row.slug}${row.pack === 'jd_failed' ? '  (cleared jd_failed)' : ''}`);
    } catch (err) {
      console.log(`FAIL ${row.slug}: ${err.message}`);
    }
    await updateQueue(queue, (current) => patchRow(current, row.slug, { pack: rowAfterFetch(row, fetched).pack }));
  }
  console.log(`Fetched ${ok} of ${pending.length}.`);
  // Nothing readable at all is a setup or network problem the caller must see.
  if (pending.length && ok === 0) process.exit(1);
}
