/**
 * build-packs.test.mjs — tests for build-packs.mjs
 * Run: node build-packs.test.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pickCvVariant, injectSummary, packDir, buildCoverPayload, selectTargets, hasSummarySlot, buildPack, loadVariants } from '../build-packs.mjs';
import { pass, fail } from './helpers.mjs';

// __dirname is tests/; repo files live one level up.
const __dirname = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Counters and reporting come from the shared helpers: a discovered suite
// reports through pass/fail and never exits, or it takes the whole runner
// down with it.
function eq(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass(label);
  else fail(`${label} → got ${JSON.stringify(actual)}`);
}
function ok(label, cond) { if (cond) pass(label); else fail(label); }

const variants = [
  { archetype: 'Agentic', html: 'output/cv-ada-elevenlabs-fde.html' },
  { archetype: 'Content', html: 'output/cv-ada-marketing-content-2col-it.html' },
  { archetype: 'default', html: 'output/cv-ada.html' },
];

eq('exact archetype wins', pickCvVariant('Agentic', variants).html, 'output/cv-ada-elevenlabs-fde.html');
eq('match is case-insensitive', pickCvVariant('content', variants).html, 'output/cv-ada-marketing-content-2col-it.html');
eq('unknown archetype falls back to default', pickCvVariant('Astrology', variants).html, 'output/cv-ada.html');
eq('empty archetype falls back to default', pickCvVariant('', variants).html, 'output/cv-ada.html');

const html = '<div class="section"><div class="section-title">Professional Summary</div>' +
             '<div class="summary-text">Old line.</div></div>';
const out = injectSummary(html, 'New tailored line.');
ok('new line is present', out.includes('New tailored line.'));
ok('old line is gone', !out.includes('Old line.'));
ok('surrounding markup survives', out.includes('Professional Summary'));
ok('class attribute survives', out.includes('class="summary-text"'));

// An empty or n/a summary must leave the base CV untouched rather than blanking it.
eq('empty line leaves html alone', injectSummary(html, ''), html);
eq('n/a leaves html alone', injectSummary(html, 'n/a'), html);

// Escaping: a summary containing markup must not break out of the div.
const escaped = injectSummary(html, 'Built <b>tools</b> & agents');
ok('markup in the line is escaped', escaped.includes('&lt;b&gt;') && escaped.includes('&amp;'));

ok('pack dir is under output/apply', packDir('acme-ai-intern').includes('/output/apply/acme-ai-intern'));

// -- hasSummarySlot: the injection contract, enforced rather than left as a comment --
ok('hasSummarySlot is true for a CV that has the div', hasSummarySlot(html));
ok('hasSummarySlot is false for a CV missing the div', !hasSummarySlot('<div class="section">No slot here.</div>'));

// -- the candidate's batch size is a hard cap, best-first, never padded --
const pool = [
  { slug: 'a', score: 4.8, pack: 'pending' }, { slug: 'b', score: 3.9, pack: 'pending' },
  { slug: 'c', score: 4.4, pack: 'pending' }, { slug: 'd', score: 2.1, pack: 'pending' },
  { slug: 'e', score: 3.6, pack: 'pending' }, { slug: 'f', score: '', pack: 'pending' },
];
eq('selects exactly the limit', selectTargets(pool, { limit: 2, threshold: 3.5 }).map(r => r.slug), ['a', 'c']);
eq('orders by score descending', selectTargets(pool, { limit: 4, threshold: 3.5 }).map(r => r.slug), ['a', 'c', 'b', 'e']);
eq('never pads below threshold', selectTargets(pool, { limit: 10, threshold: 3.5 }).map(r => r.slug), ['a', 'c', 'b', 'e']);
// The candidate's verdict outranks the model's score. Rendering a CV and a
// letter for a role already marked Ignora is work nobody asked for, and the
// front-end counted those rows as pending forever.
eq('a discarded row is never built, however high it scored',
  selectTargets([{ slug: 'z', score: 4.9, pack: 'pending', apply: 'skipped' }], { threshold: 3.5 }), []);
eq('a dead posting is never built either',
  selectTargets([{ slug: 'z', score: 4.9, pack: 'pending', apply: 'dead' }], { threshold: 3.5 }), []);
eq('a row nobody has ruled on is still built',
  selectTargets([{ slug: 'z', score: 4.9, pack: 'pending', apply: 'queued' }], { threshold: 3.5 }).map(r => r.slug), ['z']);

eq('a limit of zero selects nothing', selectTargets(pool, { limit: 0, threshold: 3.5 }), []);
eq('no limit means the whole qualifying set', selectTargets(pool, { threshold: 3.5 }).length, 4);
eq('untriaged rows are never selected', selectTargets(pool, { limit: 10, threshold: 0 }).some(r => r.slug === 'f'), false);
eq('already-built rows are skipped', selectTargets([{ slug: 'g', score: 5, pack: 'built' }], { limit: 5, threshold: 3.5 }), []);

// -- cover letter payload --
const base = {
  candidate: { name: 'Ada Rossi', email: 'r@example.com' },
  profile_intro: 'I build automation pipelines and ship AI-driven workflows end to end.',
  achievements: [{ lead: 'Built a pipeline', impact: 'that runs daily.' }],
  closing: 'Happy to talk.',
};
const row = { company: 'Acme', role: 'AI Intern', summary_line: 'Ships automations by directing AI coding agents.' };
const payload = buildCoverPayload(row, base);
eq('payload carries the role title', payload.letter.role_title, 'AI Intern');
eq('payload carries the company', payload.letter.company, 'Acme');
ok('opening names the company', payload.letter.opening.includes('Acme'));
ok('profile intro reuses the tailored summary', payload.letter.profile_intro.includes('Ships automations'));
eq('achievements come from the base, not invented', payload.letter.achievements, base.achievements);
eq('candidate comes from the base', payload.candidate.name, 'Ada Rossi');

// A role with no usable summary must still produce a valid letter.
const bare = buildCoverPayload({ company: 'Beta', role: 'Analyst', summary_line: 'n/a' }, base);
ok('n/a summary falls back to a factual intro', bare.letter.profile_intro.length > 40);
ok('n/a never leaks into the letter', !JSON.stringify(bare).includes('n/a'));

// -- buildPack must fail loudly, not ship a generic CV while reporting success --
// Inline fixture, not a real output/*.html file: those are the candidate's own
// files and may gain or lose the slot independently of this test.
const fixturesDir = mkdtempSync(join(tmpdir(), 'build-packs-test-'));
const noSlotPath = join(fixturesDir, 'no-slot.html');
writeFileSync(noSlotPath, '<html><body><div class="section"><div class="section-title">Professional Summary</div>' +
  '<div class="not-the-slot">Generic text.</div></div></body></html>');
const noSlotVariants = [{ archetype: 'NoSlot', html: noSlotPath }];

let usableThrew = null;
try {
  await buildPack(
    { slug: 'fixture-no-slot-usable', company: 'Acme', role: 'AI Intern', archetype: 'NoSlot', summary_line: 'Ships automations by directing AI coding agents.' },
    noSlotVariants,
  );
} catch (err) { usableThrew = err; }
ok('buildPack throws when a usable summary meets a CV with no slot', usableThrew instanceof Error);
ok('the thrown message names the offending file', !!usableThrew && usableThrew.message.includes(noSlotPath));
rmSync(packDir('fixture-no-slot-usable'), { recursive: true, force: true });

let naThrew = null;
try {
  await buildPack({ slug: 'fixture-no-slot-na', company: 'Acme', role: 'AI Intern', archetype: 'NoSlot', summary_line: 'n/a' }, noSlotVariants);
} catch (err) { naThrew = err; }
ok('buildPack does not throw when the summary is n/a, even with no slot', naThrew === null);
rmSync(packDir('fixture-no-slot-na'), { recursive: true, force: true });

// -- a row with no identity must fail the pack, not render a blank letter --
// `- [ ] {url}` is a valid pipeline line, so company and role can both be
// empty. That produced "I am applying for the  role at ." and a pack reported
// as built, while the apply session's identity gate short-circuited to ok.
for (const [name, bad] of [
  ['no company and no role', { slug: 'fixture-no-identity', archetype: 'NoSlot', summary_line: 'n/a' }],
  ['no company', { slug: 'fixture-no-company', role: 'AI Intern', archetype: 'NoSlot', summary_line: 'n/a' }],
  ['no role', { slug: 'fixture-no-role', company: 'Acme', archetype: 'NoSlot', summary_line: 'n/a' }],
]) {
  let threw = null;
  try { await buildPack(bad, noSlotVariants); } catch (err) { threw = err; }
  ok(`buildPack refuses a row with ${name}`, threw instanceof Error);
  ok(`the refusal for ${name} names company or role`, !!threw && /company|role/i.test(threw.message));
  rmSync(packDir(bad.slug), { recursive: true, force: true });
}

// -- loadVariants: a malformed entry must throw, not fall back to the generic CV --
const badYml = join(fixturesDir, 'no-html.yml');
writeFileSync(badYml, 'variants:\n  - archetype: Agentic\n    notes: "oops, no html line"\n  - archetype: default\n    html: output/cv.html\n');
let variantsThrew = null;
try { loadVariants(badYml); } catch (err) { variantsThrew = err; }
ok('loadVariants throws on an archetype with no html', variantsThrew instanceof Error);
ok('the thrown message names the offending archetype', !!variantsThrew && variantsThrew.message.includes('Agentic'));

// A same-line YAML comment is a comment, not part of the path.
const commentYml = join(fixturesDir, 'comment.yml');
writeFileSync(commentYml, 'variants:\n  - archetype: default\n    html: output/cv-ada.html  # the generalist one\n');
eq('a trailing comment is not absorbed into the path', loadVariants(commentYml)[0].html, 'output/cv-ada.html');

const quotedYml = join(fixturesDir, 'quoted.yml');
writeFileSync(quotedYml, 'variants:\n  - archetype: "default"\n    html: "output/cv ada.html" # quoted\n');
eq('a quoted path keeps its spaces', loadVariants(quotedYml)[0].html, 'output/cv ada.html');

// -- the single-slot contract is deliberate (T5-a) --
const twoSlots = '<div class="summary-text">One.</div><div class="summary-text">Two.</div>';
eq('injectSummary fills exactly one slot, by design', injectSummary(twoSlots, 'New.'),
   '<div class="summary-text">New.</div><div class="summary-text">Two.</div>');
ok('the no-/g decision is documented so nobody "fixes" it',
   /on purpose|deliberate/i.test(readFileSync(resolve(__dirname, 'build-packs.mjs'), 'utf-8')
     .split('export function injectSummary')[0].split('/** Pick the base CV')[1]));

// -- I6: every archetype in the real cv-variants.yml must point at a CV with the slot --
// Skipped on a fresh checkout: cv-variants.yml and output/*.html are the
// candidate's own files and are gitignored.
const realYml = resolve(__dirname, 'cv-variants.yml');
if (existsSync(realYml)) {
  for (const v of loadVariants(realYml)) {
    const file = resolve(__dirname, v.html);
    ok(`cv-variants: ${v.archetype} points at a file that exists`, existsSync(file));
    ok(`cv-variants: ${v.archetype} points at a CV with a summary slot`,
       existsSync(file) && hasSummarySlot(readFileSync(file, 'utf-8')));
  }
}

rmSync(fixturesDir, { recursive: true, force: true });

