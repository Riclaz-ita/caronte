// tests/providers/linkedin.test.mjs — the logged-out LinkedIn job search.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — linkedin');
const ok = (label, cond) => (cond ? pass(label) : fail(label));
const eq = (label, a, b) => (JSON.stringify(a) === JSON.stringify(b) ? pass(label) : fail(`${label} → got ${JSON.stringify(a)}`));

const mod = await import(pathToFileURL(join(ROOT, 'providers/linkedin.mjs')).href);
const linkedin = mod.default;
const { parseCards, searchUrl } = mod;
eq('id is "linkedin"', linkedin.id, 'linkedin');

const card = (id, title, company, location, date) => `<li>
  <div class="base-card" data-entity-urn="urn:li:jobPosting:${id}">
    <a class="base-card__full-link" href="https://it.linkedin.com/jobs/view/slug-${id}?position=1&amp;refId=abc&amp;trackingId=xyz"></a>
    <h3 class="base-search-card__title">
          ${title}
    </h3>
    <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="#">${company}</a></h4>
    <span class="job-search-card__location">${location}</span>
    <time class="job-search-card__listdate" datetime="${date}">2 giorni fa</time>
  </div></li>`;
const page = card('4467058215', 'Social Media Specialist &amp; Content', 'Joinrs', 'Milan, Lombardy, Italy', '2026-09-14')
  + card('4468398590', 'Responsabile Marketing', 'Lavoropi&#249; SpA', 'Greater Milan Metropolitan Area', '2026-09-17')
  + '<li><div>no posting urn here</div></li>'
  + card('123', 'Too short an id', 'X', 'Y', '2026-09-17')
  + '<li><div data-entity-urn="urn:li:jobPosting:4400000001"><h3 class="base-search-card__title">   </h3></div></li>';
const jobs = parseCards(page);
eq('only complete cards with a real posting id survive', jobs.length, 2);
eq('entities decoded in title and company', [jobs[0].title, jobs[1].company], ['Social Media Specialist & Content', 'Lavoropiù SpA']);
eq('URL rebuilt from the id, tracking parameters dropped', jobs[0].url, 'https://www.linkedin.com/jobs/view/4467058215');
eq('location kept', jobs[1].location, 'Greater Milan Metropolitan Area');
eq('posting date parsed', new Date(jobs[0].postedAt).toISOString().slice(0, 10), '2026-09-14');
eq('empty or non-string page parses to nothing', [parseCards(''), parseCards(null)], [[], []]);

const u = new URL(searchUrl({ location: 'Milano, Lombardia, Italia', experience: [1, 2, 99, 'x'], posted_within_days: 3 }, 'social & media"<', 20));
eq('keyword encoded as a parameter, not spliced', u.searchParams.get('keywords'), 'social & media"<');
eq('recency filter in seconds', u.searchParams.get('f_TPR'), 'r259200');
eq('only valid experience levels', u.searchParams.get('f_E'), '1,2');
eq('pagination offset', u.searchParams.get('start'), '20');
eq('host is fixed', u.origin, 'https://www.linkedin.com');
eq('out-of-range days fall back to 7', new URL(searchUrl({ posted_within_days: 400 }, 'x', 0)).searchParams.get('f_TPR'), 'r604800');

let threw = false;
try { await linkedin.fetch({ name: 'x', keywords: [] }, { fetchText: async () => '' }); } catch { threw = true; }
ok('an entry without keywords fails loud', threw);

const calls = [];
const ctx = (pages) => ({ sleep: async () => {}, fetchText: async (url, opts) => { calls.push({ url, opts }); return pages.shift() ?? ''; } });
const got = await linkedin.fetch({ name: 'x', keywords: ['a', 'b'], max_pages: 2 }, ctx([page, '', page, page]));
eq('stops a keyword at an empty page and dedups across keywords', got.length, 2);
eq('requests made: 2 for the first keyword, 2 for the second', calls.length, 4);
ok('every request refuses redirects (SSRF)', calls.every((c) => c.opts?.redirect === 'error'));

calls.length = 0;
await linkedin.fetch({ name: 'x', keywords: ['a', 'b', 'c'], max_pages: 3 }, { ...ctx([page, page, page]), maxPages: 1 });
eq('health probe: exactly one request', calls.length, 1);
let probeErr = null;
const budget = new Error('budget');
try { await linkedin.fetch({ name: 'x', keywords: ['a'] }, { maxPages: 1, sleep: async () => {}, fetchText: async () => { throw budget; } }); } catch (e) { probeErr = e; }
ok('probe rejections propagate unwrapped', probeErr === budget);

const partial = await linkedin.fetch({ name: 'x', keywords: ['a', 'b'], max_pages: 1 }, {
  sleep: async () => {},
  fetchText: async (url) => { if (url.includes('keywords=a')) { const e = new Error('HTTP 404'); throw e; } return page; },
});
eq('in a real scan one failing keyword keeps the others', partial.length, 2);
