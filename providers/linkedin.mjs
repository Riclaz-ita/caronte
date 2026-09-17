// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// LinkedIn provider — the public, logged-out job search
// (https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search).
// Wire in via a `job_boards:` entry with `provider: linkedin`.
//
// Why it exists: a web search over LinkedIn returns whatever the search index
// kept, and the index keeps postings for years. Measured on 2026-09-17: 20 of
// 23 LinkedIn hits were closed postings from 2020-2023. This endpoint is the
// one LinkedIn itself serves to logged-out visitors, filtered by recency, so
// every result is days old instead of years. liveness-api.mjs already reads
// the sibling guest endpoint (jobPosting/{id}) for the same reason.
//
// No login, no cookies, no account: nothing here can affect a LinkedIn
// profile. The endpoint rate-limits, so the walk is small and paced.
//
// Entry:
//   - name: LinkedIn Milano
//     provider: linkedin
//     keywords: [marketing, social media, stage]   # one search per keyword
//     location: Milano, Lombardia, Italia
//     posted_within_days: 7        # optional, default 7 (1-30)
//     experience: [1, 2]           # optional: 1 internship, 2 entry, 3 associate, 4 mid-senior
//     max_pages: 3                 # optional, pages per keyword, default 3 (10 postings each)

import { decodeEntities } from './_html-entities.mjs';
import { fetchTextWithRetry, sleep } from './_http.mjs';

const SEARCH_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 10;
const MAX_KEYWORDS = 15;
const INTER_REQUEST_DELAY_MS = 1_500;
const RETRY_POLICY = { retries: 2, baseDelayMs: 2_000, maxDelayMs: 10_000 };

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function resolveDays(entry) {
  const v = Number(entry?.posted_within_days);
  return Number.isInteger(v) && v >= 1 && v <= 30 ? v : 7;
}

/** Build one search page URL. Every user-supplied value goes through URLSearchParams. */
export function searchUrl(entry, keyword, start) {
  const params = new URLSearchParams({ keywords: keyword, f_TPR: `r${resolveDays(entry) * 86_400}`, start: String(start) });
  if (typeof entry?.location === 'string' && entry.location.trim()) params.set('location', entry.location.trim());
  const levels = (Array.isArray(entry?.experience) ? entry.experience : [])
    .map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 6);
  if (levels.length) params.set('f_E', levels.join(','));
  return `${SEARCH_URL}?${params}`;
}

const text = (m) => (m ? decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '');

/**
 * Parse one page of result cards. Pure, no I/O.
 * The URL is rebuilt from the numeric posting id alone: the card's own href
 * carries tracking parameters that would defeat dedup by URL.
 */
export function parseCards(html) {
  if (typeof html !== 'string' || !html) return [];
  const jobs = [];
  for (const card of html.split(/<li[\s>]/).slice(1)) {
    const id = card.match(/urn:li:jobPosting:(\d{5,})/);
    const title = text(card.match(/class="base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/));
    if (!id || !title) continue;
    const company = text(card.match(/class="base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/));
    const location = text(card.match(/class="job-search-card__location"[^>]*>([\s\S]*?)<\/span>/));
    const when = card.match(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/);
    const postedAt = when ? Date.parse(`${when[1]}T00:00:00Z`) : NaN;
    jobs.push({
      title,
      url: `https://www.linkedin.com/jobs/view/${id[1]}`,
      company,
      location,
      ...(Number.isFinite(postedAt) ? { postedAt } : {}),
    });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'linkedin',

  async fetch(entry, ctx) {
    const keywords = (Array.isArray(entry?.keywords) ? entry.keywords : [])
      .filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim()).slice(0, MAX_KEYWORDS);
    if (!keywords.length) throw new Error(`linkedin: "${entry?.name || 'entry'}" needs a keywords: list`);

    const probing = Number(ctx?.maxPages) > 0;
    const pages = probing ? Math.min(Number(ctx.maxPages), resolveMaxPages(entry)) : resolveMaxPages(entry);
    const byUrl = new Map();
    let requests = 0;
    let truncated = false;

    for (const keyword of probing ? keywords.slice(0, 1) : keywords) {
      let start = 0;
      for (let page = 0; page < pages; page += 1) {
        if (requests > 0) await sleep(INTER_REQUEST_DELAY_MS, ctx);
        requests += 1;
        let html;
        try {
          html = await fetchTextWithRetry(ctx, searchUrl(entry, keyword, start), { redirect: 'error' }, RETRY_POLICY);
        } catch (err) {
          if (probing) throw err;
          // Recall first in a real scan: keep what the other keywords found.
          console.error(`⚠️  linkedin: "${keyword}" stopped at page ${page + 1}: ${err.message}`);
          break;
        }
        const cards = parseCards(html);
        if (!cards.length) break;
        for (const job of cards) if (!byUrl.has(job.url)) byUrl.set(job.url, job);
        start += cards.length;
        if (page === pages - 1 && !probing) truncated = true;
      }
    }
    if (truncated) {
      console.error(`⚠️  linkedin: ${entry?.name || 'entry'} hit max_pages (${pages}) on at least one keyword — raise max_pages on this entry for more`);
    }
    return [...byUrl.values()];
  },
};
