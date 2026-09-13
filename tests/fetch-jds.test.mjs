/**
 * fetch-jds.test.mjs — tests for fetch-jds.mjs
 * Run: node fetch-jds.test.mjs
 */
import { atsOf, jdSlug, stripHtml, fetchJd, rowAfterFetch } from '../fetch-jds.mjs';
import { pass, fail } from './helpers.mjs';

// Counters and reporting come from the shared helpers: a discovered suite
// reports through pass/fail and never exits, or it takes the whole runner
// down with it.
function eq(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass(label);
  else fail(`${label} → got ${JSON.stringify(actual)}`);
}
function ok(label, cond) { if (cond) pass(label); else fail(label); }

eq('ashby host', atsOf('https://jobs.ashbyhq.com/elevenlabs/abc-123'), 'ashby');
eq('greenhouse host', atsOf('https://job-boards.greenhouse.io/anthropic/jobs/5390770008'), 'greenhouse');
eq('greenhouse eu host', atsOf('https://job-boards.eu.greenhouse.io/parloa/jobs/4903168101'), 'greenhouse');
eq('lever host', atsOf('https://jobs.lever.co/qonto/19404ce8'), 'lever');
eq('greenhouse behind a company domain', atsOf('https://sumup.com/careers/positions/8697959002?gh_jid=8697959002'), 'greenhouse');
eq('greenhouse behind a www company domain', atsOf('https://www.storyblok.com/job?gh_jid=4908484101'), 'greenhouse');
eq('unsupported host', atsOf('https://example.com/careers/1'), null);
eq('a company domain without gh_jid is still unsupported', atsOf('https://sumup.com/careers/positions/8697959002'), null);

eq('slug lowercases and hyphenates', jdSlug('ElevenLabs', 'Forward Deployed Engineer'), 'elevenlabs-forward-deployed-engineer');
eq('slug strips punctuation', jdSlug('Arize AI', 'AI Sales Engineer, EMEA'), 'arize-ai-ai-sales-engineer-emea');
eq('slug collapses repeats', jdSlug('SumUp', 'Agente  di --- commercio'), 'sumup-agente-di-commercio');

eq('strip closes block tags as newlines', stripHtml('<p>a</p><p>b</p>'), 'a\nb');
eq('strip turns li into bullets', stripHtml('<ul><li>one</li><li>two</li></ul>'), '- one\n- two');
eq('strip decodes entities', stripHtml('<p>R&amp;D &lt;tag&gt;</p>'), 'R&D <tag>');
eq('strip drops empty input', stripHtml(undefined), '');

// -- T1-a: a non-OK response is a transport failure, not a parse error --
// Every ATS rate-limits, and a block page is HTML. Without an r.ok check
// r.json() threw a bare SyntaxError, which reads as "this posting is
// unsupported" and parked the row in jd_failed forever.
const realFetch = globalThis.fetch;
for (const [name, url, status, body] of [
  ['ashby', 'https://jobs.ashbyhq.com/acme/123', 429, 'Too Many Requests'],
  ['greenhouse', 'https://job-boards.greenhouse.io/acme/jobs/123', 503, '<html>blocked</html>'],
  ['lever', 'https://jobs.lever.co/acme/123', 403, '<html>blocked</html>'],
]) {
  globalThis.fetch = async () => new Response(body, { status, headers: { 'content-type': 'text/html' } });
  let threw = null;
  try { await fetchJd(url); } catch (err) { threw = err; }
  ok(`${name}: a non-OK response throws`, threw instanceof Error);
  ok(`${name}: the error names the HTTP status`, !!threw && threw.message.includes(String(status)));
  ok(`${name}: it is not a bare JSON parse error`, !!threw && !(threw instanceof SyntaxError));
}
globalThis.fetch = realFetch;

// -- I3: jd_failed is not terminal --
eq('a failed fetch marks the row jd_failed', rowAfterFetch({ slug: 'a', pack: 'pending' }, false).pack, 'jd_failed');
eq('a later success clears jd_failed back to pending', rowAfterFetch({ slug: 'a', pack: 'jd_failed' }, true).pack, 'pending');
eq('a success leaves a pending row pending', rowAfterFetch({ slug: 'a', pack: 'pending' }, true).pack, 'pending');
eq('a success never demotes a built row', rowAfterFetch({ slug: 'a', pack: 'built' }, true).pack, 'built');
eq('the rest of the row survives', rowAfterFetch({ slug: 'a', pack: 'jd_failed', company: 'Acme' }, true).company, 'Acme');

