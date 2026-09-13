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
import { dirname, resolve } from 'path';
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
  const { readQueue, writeQueue, upsertRow } = await import('./apply-queue.mjs');
  const args = process.argv.slice(2);
  const queuePath = args.includes('--queue') ? args[args.indexOf('--queue') + 1] : null;
  if (!queuePath) { console.error('Usage: node fetch-jds.mjs --queue data/apply-queue.tsv'); process.exit(1); }

  let rows = readQueue(resolve(__dirname, queuePath));
  const pending = rows.filter((r) => !existsSync(resolve(getCareerOpsRoot(), 'jds', `${r.slug}.md`)));
  console.log(`Fetching ${pending.length} job descriptions...`);

  for (const row of pending) {
    try {
      const jd = await fetchJd(row.url);
      writeJd(row.slug, row.company, row.url, jd);
      rows = upsertRow(rows, rowAfterFetch(row, true));
      console.log(`OK   ${row.slug}${row.pack === 'jd_failed' ? '  (cleared jd_failed)' : ''}`);
    } catch (err) {
      rows = upsertRow(rows, rowAfterFetch(row, false));
      console.log(`FAIL ${row.slug}: ${err.message}`);
    }
  }
  writeQueue(resolve(__dirname, queuePath), rows);
}
