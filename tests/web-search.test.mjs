// tests/web-search.test.mjs — the web search step: what the worker may do, what
// its answer may put in the pipeline, and that closed postings never get in.
import { pass, fail } from './helpers.mjs';
import {
  webSearchArgs, buildWebSearchPrompt, isPostingUrl, parseWebResults, selectNew, keepOpen, enabledQueries, MAX_QUERIES,
} from '../web-search.mjs';
import { judgeExtraction } from '../fetch-jds.mjs';
import { normalizeUrlForDedup } from '../scan.mjs';
import { phaseById, preflight, summarise } from '../apply-ui.mjs';

console.log('\nweb search (Caronte)');
const ok = (label, cond) => (cond ? pass(label) : fail(label));
const eq = (label, a, b) => (JSON.stringify(a) === JSON.stringify(b) ? pass(label) : fail(`${label} → got ${JSON.stringify(a)}`));

// -- the worker can search and nothing else --
const args = webSearchArgs('sonnet');
eq('the only tool is WebSearch', args[args.indexOf('--tools') + 1], 'WebSearch');
ok('no transcript kept', args.includes('--no-session-persistence'));
ok('no MCP servers', args.includes('--strict-mcp-config'));
ok('the prompt marks results as data', /EXTERNAL CONTENT/.test(buildWebSearchPrompt(['q'])));

// -- URLs --
ok('a LinkedIn posting is a posting', isPostingUrl('https://it.linkedin.com/jobs/view/123'));
ok('a LinkedIn search page is not', !isPostingUrl('https://it.linkedin.com/jobs/search?keywords=x'));
ok('an Indeed viewjob is a posting', isPostingUrl('https://it.indeed.com/viewjob?jk=abc'));
ok('an Indeed search page is not', !isPostingUrl('https://it.indeed.com/jobs?q=marketing'));
for (const bad of ['file:///etc/passwd', 'http://localhost:4176/api/decide', 'http://10.0.0.1/x', 'http://[::1]/x', 'javascript:alert(1)', 'not a url']) {
  ok(`refused: ${bad}`, !isPostingUrl(bad));
}

// -- parsing --
const answer = 'Results:\n```json\n[{"url":"https://it.linkedin.com/jobs/view/1","company":"Acme | Srl","title":"Junior  Marketing","location":"Milano"},'
  + '{"url":"file:///etc/passwd","company":"x"},{"nope":1},"string"]\n```';
const parsed = parseWebResults(answer);
eq('only the valid posting survives', parsed.map((o) => o.url), ['https://it.linkedin.com/jobs/view/1']);
eq('pipe and double spaces cannot break a pipeline line', [parsed[0].company, parsed[0].title], ['Acme Srl', 'Junior Marketing']);
let threw = false; try { parseWebResults('I could not search.'); } catch { threw = true; }
ok('a prose answer throws instead of adding nothing silently', threw);

// -- selection --
const offers = [
  { url: 'https://a.example/jobs/1', title: 'Junior Marketing', location: 'Milano' },
  { url: 'https://a.example/jobs/1', title: 'Junior Marketing', location: 'Milano' },
  { url: 'https://a.example/jobs/2', title: 'Senior Engineer', location: 'Milano' },
  { url: 'https://a.example/jobs/3', title: '', location: '' },
  { url: 'https://a.example/jobs/4', title: 'Junior Marketing', location: 'Milano' },
];
const picked = selectNew(offers, {
  seen: new Set([normalizeUrlForDedup('https://a.example/jobs/4')]),
  titleOk: (t) => !/senior/i.test(t),
});
eq('dedup within the answer and against history, title filter applied, unknown title kept',
  picked.map((o) => o.url), ['https://a.example/jobs/1', 'https://a.example/jobs/3']);

// -- closed postings never reach the pipeline --
const verdicts = { 'https://a.example/1': { result: 'expired' }, 'https://a.example/2': { result: 'active' }, 'https://a.example/3': null };
const open = await keepOpen(Object.keys(verdicts).map((url) => ({ url })), async (u) => verdicts[u]);
eq('expired dropped, active and unknown kept', open.kept.map((o) => o.url), ['https://a.example/2', 'https://a.example/3']);
eq('counts reported', open.stats, { active: 1, expired: 1, unknown: 1 });
const crashy = await keepOpen([{ url: 'https://a.example/9' }], async () => { throw new Error('net'); });
eq('a failing check is unknown, not a crash', crashy.stats, { active: 0, expired: 0, unknown: 1 });

// -- queries --
const many = { search_queries: Array.from({ length: 30 }, (_, i) => ({ query: `q${i}`, enabled: i !== 0 })) };
eq('disabled queries skipped and the paid run capped', enabledQueries(many).length, MAX_QUERIES);
eq('first enabled query leads', enabledQueries(many)[0], 'q1');

// -- reading a page without an API --
ok('a closed page is refused', !judgeExtraction('https://x.example/j/1', { text: 'This job is no longer available.' }).ok);
ok('a near-empty page is refused', !judgeExtraction('https://x.example/j/1', { text: 'hi' }).ok);
ok('a real posting is accepted', judgeExtraction('https://x.example/j/1', { text: 'Junior marketing role in Milan, Italy. '.repeat(20) }).ok);

// -- the panel: opt-in, and says it costs --
const noInbox = { limit: 5, inbox: 0 };
ok('without the toggle there is no web step',
  !phaseById('search').steps({ limit: 5 }).some((st) => st.args.includes('web-search.mjs')));
ok('with the toggle the web step runs before the import',
  (() => { const st = phaseById('search').steps({ limit: 5, web: true }).map((x) => x.args[0]);
    return st.indexOf('web-search.mjs') !== -1 && st.indexOf('web-search.mjs') < st.indexOf('apply-queue.mjs'); })());
ok('the confirmation says the web search costs tokens', /token/.test(preflight('search', summarise([]), { ...noInbox, web: true }).cost));
eq('the plain search stays free', preflight('search', summarise([]), noInbox).cost, 'zero token');

// -- LinkedIn posting text from the guest endpoint --
const { parseLinkedInPosting } = await import('../fetch-jds.mjs');
const liveHtml = '<h2 class="top-card-layout__title font-sans">Social Media Specialist</h2>'
  + '<span class="topcard__flavor topcard__flavor--bullet">Milan, Lombardy, Italy</span>'
  + '<code id="applyUrl"></code><a class="public_jobs_apply-link-onsite">Candidati</a>'
  + `<div class="show-more-less-html__markup relative"><p>${'Gestirai i canali social del brand. '.repeat(15)}</p></div>`;
const live = parseLinkedInPosting(liveHtml);
eq('open LinkedIn posting yields title, location and text', [live.jd?.title, live.jd?.location, (live.jd?.body.length || 0) > 300], ['Social Media Specialist', 'Milan, Lombardy, Italy', true]);
const closed = parseLinkedInPosting('<figcaption class="closed-job__flavor--closed">No longer accepting applications</figcaption>');
ok('closed LinkedIn posting is reported closed, not read', closed.closed === true && !closed.jd);
ok('a page without description is refused', !parseLinkedInPosting('<a class="public_jobs_apply-link-onsite">x</a>').jd);
