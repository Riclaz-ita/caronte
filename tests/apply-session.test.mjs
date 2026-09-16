/**
 * apply-session.test.mjs — the browser driver against a local fixture form.
 *
 * This test is the guarantee from the spec made executable: fields with a
 * source get filled, every field on the never-fill list is left empty, and the
 * provenance report accounts for every field that was touched.
 *
 * Run: node apply-session.test.mjs
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFormFields, fillForm, renderProvenanceReport, checkIdentity, selectRow } from '../apply-session.mjs';
import { planFills } from '../field-provenance.mjs';
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

const sources = {
  profile: { full_name: 'Ada Rossi', email: 'ada.rossi@example.com', phone: '+39 333 000 0000',
             location: 'Bergamo (BG), Italy', linkedin: 'https://linkedin.com/in/x' },
  answerBank: { 'how did you hear about us': 'Through the company careers page.' },
};

// -- the identity gate runs before anything is typed --
const row = { company: 'Acme', role: 'AI Intern', slug: 'acme-ai-intern' };
const long = ' The role involves building things and shipping them to customers every week.'.repeat(4);
eq('matching page passes', checkIdentity('Acme is hiring an AI Intern to join us.' + long, 'AI Intern @ Acme', row).ok, true);
eq('missing company is a mismatch', checkIdentity('Globex is hiring a Data Analyst.' + long, 'Data Analyst @ Globex', row).kind, 'mismatch');
eq('missing role is a mismatch', checkIdentity('Acme is hiring a Head of Sales.' + long, 'Head of Sales @ Acme', row).kind, 'mismatch');
eq('closed posting is dead', checkIdentity('This job is no longer available.' + long, 'Acme', row).kind, 'dead');
eq('filled position is dead', checkIdentity('This position has been filled.' + long, 'Acme', row).kind, 'dead');
eq('an almost-empty page is dead', checkIdentity('   ', 'Acme', row).kind, 'dead');
ok('a mismatch explains itself', checkIdentity('Globex hiring.' + long, 'x', row).reason.length > 20);
ok('dead check runs before mismatch', checkIdentity('Globex: this job is no longer available.' + long, 'x', row).kind === 'dead');

// -- the title must never rescue a mismatched body (fix round 1, Finding 1) --
eq('title cannot rescue a mismatched body', checkIdentity(
  'Globex is hiring a Senior Data Scientist to join their growing team.' + long,
  'Senior Backend Engineer @ Acme',
  { company: 'Acme', role: 'Senior Backend Engineer' },
).kind, 'mismatch');
eq('matching title and body still passes', checkIdentity('Acme is hiring an AI Intern to join us.' + long, 'AI Intern @ Acme', row).ok, true);

// -- the --next flag is recognized in argument parsing with mutual-exclusion guard (fix round 2) --
const fs = await import('fs');
const scriptSource = fs.readFileSync(resolve(__dirname, 'apply-session.mjs'), 'utf-8');
ok('--next flag is documented in usage', scriptSource.includes('node apply-session.mjs --next'));
ok('--next flag is parsed', scriptSource.includes("args.includes('--next')"));
ok('--slug and --next mutual exclusion guard exists', scriptSource.includes("if (slug && useNext)"));
ok('guard prevents conflicting flags', scriptSource.includes("Pass either --slug <slug> or --next, not both"));
eq('page-not-found title over empty body is still dead', checkIdentity('', 'Page not found', row).kind, 'dead');

// -- C5: a row with no identity must STOP the session, not sail through it --
// `company &&` and `roleWords.length &&` both short-circuit on an empty row,
// so the mandatory gate returned {ok:true} for any page over 200 characters.
const noIdentity = checkIdentity('Globex is hiring a Data Analyst.' + long, 'Data Analyst @ Globex', { slug: 'bare-url', company: '', role: '' });
eq('a row with no company and no role does not pass the gate', noIdentity.ok, false);
eq('it stops as a mismatch, not as dead', noIdentity.kind, 'mismatch');
ok('it says the row has no identity', /no company and no role|identity/i.test(noIdentity.reason));
// One of the two still present is enough for the gate to do real work.
eq('company alone still gates', checkIdentity('Globex is hiring.' + long, 'x', { company: 'Acme', role: '' }).kind, 'mismatch');
eq('role alone still gates', checkIdentity('Globex is hiring a Head of Sales.' + long, 'x', { company: '', role: 'AI Intern' }).kind, 'mismatch');

// -- I3: --next must also offer a row whose JD could not be fetched --
// Nothing read jd_failed: build-packs filters on pending and this script
// filtered on built, so an unsupported-ATS posting vanished silently.
// Rows are `chosen`: --next opens only what the candidate said yes to. A
// `queued` row is undecided and is never opened on his behalf.
const pool = [
  { slug: 'built-low', pack: 'built', apply: 'chosen', score: 3.6 },
  { slug: 'built-high', pack: 'built', apply: 'chosen', score: 4.8 },
  { slug: 'jd-failed', pack: 'jd_failed', apply: 'chosen', score: 4.2 },
  { slug: 'pending', pack: 'pending', apply: 'chosen', score: 5 },
  { slug: 'already-dead', pack: 'built', apply: 'dead', score: 5 },
  { slug: 'undecided', pack: 'built', apply: 'queued', score: 5 },
];
eq('--next takes the highest-scoring chosen row', selectRow(pool, null).slug, 'built-high');
eq('--next never opens a queued row: undecided is not chosen', selectRow([pool[5]], null), null);
eq('--next reaches a jd_failed row once the built ones are done',
   selectRow(pool.filter(r => r.slug !== 'built-high' && r.slug !== 'built-low'), null).slug, 'jd-failed');
eq('--next never offers an untriaged pending row', selectRow([pool[3]], null), null);
eq('--next never offers a row that is not queued', selectRow([pool[4]], null), null);
eq('--slug wins over scoring', selectRow(pool, 'jd-failed').slug, 'jd-failed');
eq('an unknown slug resolves to nothing', selectRow(pool, 'nope'), null);
ok('the session warns that a jd_failed row has no pack', scriptSource.includes('NO PACK'));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(pathToFileURL(resolve(__dirname, 'test-fixtures', 'sample-form.html')).href);

const fields = await readFormFields(page);
eq('reads every labelled field', fields.length, 14);
ok('label text is captured', fields.some(f => f.label === 'First name'));
ok('select options are captured', fields.find(f => f.label.includes('legally authorized'))?.options?.includes('Yes'));
ok('file input is typed as file', fields.find(f => f.label.includes('Resume'))?.type === 'file');

// -- radio/checkbox groups surface as ONE field each, labelled by the legend (fix round 1, Finding 3) --
const contactGroup = fields.find(f => f.label === 'Contact preference');
ok('radio group surfaces as one field', !!contactGroup);
eq('radio group is typed as radio', contactGroup?.type, 'radio');
eq('radio group carries both options', contactGroup?.options, ['Email', 'Phone']);
// "Phone" is already the legitimate label of the phone-number field (#ph); the
// group must not add a second, separate field mislabelled with an option's own text.
ok('radio group is not mislabelled by an option', !fields.some(f => f.label === 'Email') && fields.filter(f => f.label === 'Phone').length === 1);

const alertsGroup = fields.find(f => f.label === 'Subscribe to job alerts');
ok('checkbox group surfaces as one field', !!alertsGroup);
eq('checkbox group is typed as checkbox', alertsGroup?.type, 'checkbox');

const plan = planFills(fields.filter(f => f.type !== 'file'), sources);
const filled = await fillForm(page, plan.fills.map(f => ({ ...f, selector: fields.find(x => x.label === f.label).selector })));

eq('first name is filled', await page.inputValue('#fn'), 'Ada');
eq('last name is filled', await page.inputValue('#ln'), 'Rossi');
eq('email is filled', await page.inputValue('#em'), 'ada.rossi@example.com');
eq('phone is filled', await page.inputValue('#ph'), '+39 333 000 0000');
eq('answer bank question is filled', await page.inputValue('#hd'), 'Through the company careers page.');

// The guarantee: every never-fill field is still empty.
for (const [id, name] of [['#auth', 'work authorization'], ['#spon', 'sponsorship'], ['#sal', 'salary'], ['#gen', 'gender']]) {
  eq(`never-fill left empty: ${name}`, await page.inputValue(id), '');
}
eq('unknown field left empty', await page.inputValue('#alb'), '');

// -- fillForm is its own boundary, not just a pipe for planFills' output (fix round 1, Finding 2) --
const neverFillProbe = await fillForm(page, [{ label: 'Are you legally authorized to work in the EU?', value: 'Yes', source: 'fabricated-by-probe', selector: '#auth' }]);
ok('fillForm refuses a never-fill label handed directly', neverFillProbe[0].ok === false);
eq('never-fill field untouched by a direct probe', await page.inputValue('#auth'), '');

const sourcelessProbe = await fillForm(page, [{ label: 'What is your favourite album?', value: 'Blue', source: '', selector: '#alb' }]);
ok('fillForm refuses a fill with no source', sourcelessProbe[0].ok === false);
eq('sourceless field untouched by a direct probe', await page.inputValue('#alb'), '');

// -- fillForm refuses radio/checkbox groups even when handed a plausible fill (fix round 1, Finding 3) --
const radioProbe = await fillForm(page, [{ label: contactGroup.label, value: 'Email', source: 'data/answer-bank.md', selector: contactGroup.selector }]);
ok('fillForm refuses a radio group with a recorded reason', radioProbe[0].ok === false && typeof radioProbe[0].error === 'string' && radioProbe[0].error.length > 0);

ok('every fill reports success', filled.every(f => f.ok));
const report = renderProvenanceReport(filled, plan.asks);
ok('report names every filled field', filled.every(f => report.includes(f.label)));
ok('report names every source', filled.every(f => report.includes(f.source)));
ok('report lists the questions to answer', plan.asks.every(a => report.includes(a.label)));
ok('report warns about the file upload', /attach|upload/i.test(report));


// -- the tricky form: nothing is dropped, and nothing unidentified is filled --
const tricky = await browser.newPage();
await tricky.goto(pathToFileURL(resolve(__dirname, 'test-fixtures', 'tricky-form.html')).href);
const trickyFields = await readFormFields(tricky);

// C1: a Greenhouse-style cover-letter box whose <label for> holds only the
// required marker normalises to an empty label. It used to be emitted as a
// normal field, match every answer-bank key by substring, and receive
// "Through the company careers page." with a ✓ in the report.
const cover = trickyFields.find(f => f.selector === '#q1');
ok('the unlabelled textarea is still reported', !!cover);
ok('it is not emitted as a normal field', !!cover?.unfillable);
ok('its label is not empty', (cover?.label || '').trim().length > 0);

const trickyPlan = planFills(trickyFields, sources);
eq('every field is accounted for', trickyPlan.fills.length + trickyPlan.asks.length, trickyFields.length);
eq('six fields are read', trickyFields.length, 6);
ok('the unlabelled textarea is never filled', !trickyPlan.fills.some(f => f.selector === '#q1'));
const trickyFilled = await fillForm(tricky, trickyPlan.fills);
eq('the unlabelled textarea is still empty', await tricky.inputValue('#q1'), '');

// I4: two fields share one label. Resolving the selector by label afterwards
// wrote both values into the first field and reported both as written.
eq('both duplicate-label fields are filled', await tricky.inputValue('#em'), 'ada.rossi@example.com');
eq('the second one is filled too, not skipped', await tricky.inputValue('#em2'), 'ada.rossi@example.com');
eq('two writes are reported for two fields', trickyFilled.filter(f => f.ok).length, 2);
eq('each reported write names its own field', trickyFilled.map(f => f.selector).sort(), ['#em', '#em2']);

// I5: the three classes that used to vanish are all in the asks pile.
const askReasons = trickyPlan.asks.map(a => `${a.label} :: ${a.reason}`).join('\n');
ok('the file input is raised, not dropped', trickyPlan.asks.some(a => /Resume/.test(a.label)));
ok('the file reason says the attachment is his to make', /yours to (make|attach)/i.test(askReasons));
ok('the field with no id and no name is raised', trickyPlan.asks.some(a => /Anything else/.test(a.label)));
ok('its reason says it cannot be addressed', /no id and no name/i.test(askReasons));
ok('the unlabelled textarea is raised', trickyPlan.asks.some(a => a.reason && /could not read a label/i.test(a.reason)));
const trickyReport = renderProvenanceReport(trickyFilled, trickyPlan.asks);
ok('the report accounts for every field on the form',
   trickyFields.every(f => trickyReport.includes(f.label)));
await tricky.close();

await browser.close();

