/**
 * field-provenance.test.mjs — the never-fill list and provenance rules.
 *
 * This is the executable form of the hard requirement in
 * docs/superpowers/specs/2026-09-11-apply-pipeline-design.md: every filled
 * value must resolve to a named source, and the never-fill list is absolute.
 *
 * Run: node field-provenance.test.mjs
 */
import { isNeverFill, resolveField, planFills } from '../field-provenance.mjs';
import { pass, fail } from './helpers.mjs';

// Counters and reporting come from the shared helpers: a discovered suite
// reports through pass/fail and never exits, or it takes the whole runner
// down with it.
function eq(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass(label);
  else fail(`${label} → got ${JSON.stringify(actual)}`);
}
function ok(label, cond) { if (cond) pass(label); else fail(label); }

// -- the never-fill list is absolute --
// SENSITIVE: every label the adversarial ATS-phrasing probe tested that must
// be refused. Add a label here as one line — that's the whole regression
// guard for the never-fill gate.
const SENSITIVE = [
  // the reviewer's complete 31-label adversarial probe set, verbatim, in order
  'Do you now or will you in the future require sponsorship to work in this country?',
  'Will you require visa sponsorship now or in the future?',
  'Expected annual base salary',
  'Compensation expectations',
  'Desired salary range',
  'Retribuzione annua lorda attesa',
  'What are your current and expected total compensation?',
  'Are you legally entitled to work in the UK?',
  'Do you have the right to work in Canada?',
  'Are you eligible to work in the European Union?',
  'Do you have unrestricted work authorization for this role?',
  'Please confirm your current work authorization status',
  'How soon can you start?',
  'Earliest start date',
  'What is your notice period?',
  'Voluntary self-identification of disability',
  'Are you Hispanic or Latino?',
  'Gender',
  'What is your gender identity?',
  'Please select your race/ethnicity (optional)',
  'I identify my gender as:',
  'Have you ever been convicted of a felony?',
  'Have you ever been convicted of a crime other than a minor traffic violation?',
  'Do you require sponsorship to work in the United States now or in the future?',
  'Are you legally authorized to work in the country in which this job is located?',
  'Veteran Status',
  'Disability Status',
  'Expected annual base',
  'What is your earliest available start date?',
  'Do you have settled or pre-settled status in the UK?',
  'Are you a Canadian citizen or permanent resident?',
  // kept from earlier rounds, not duplicated above
  'Are you legally authorized to work in the United States?',
  'Will you now or in the future require sponsorship?',
  'Visa status',
  'What are your salary expectations?',
  'Desired compensation (EUR)',
  'Notice period',
  'Are you willing to relocate?',
  'Do you have a disability?',
  'Veteran status',
  'Race / Ethnicity',
  'Gender identity',
  'Have you ever been convicted of a crime?',
  'I consent to a background check',
  'Please provide two references',
  'Are you authorized to work in the United States?',
  'Work eligibility',
  'References',
];
for (const label of SENSITIVE) ok(`never-fill: ${label}`, isNeverFill(label));

// OVERREACH: ordinary labels that must stay fillable, proving the widened
// patterns above did not swallow legitimate questions.
const OVERREACH = [
  'First name', 'Email', 'City', 'Portfolio URL', 'How did you hear about us?',
  'Why do you want to work here?', 'What kind of work do you enjoy?',
  'Job reference number', 'LinkedIn', 'Preferred name', 'Educational background',
  'Professional background summary', 'Are you willing to work weekends?',
];
for (const label of OVERREACH) ok(`fillable: ${label}`, !isNeverFill(label));

// ITALIAN: he applies in Italy, in Italian. This array mirrors SENSITIVE above
// for the phrasings an Italian ATS actually uses. Thirteen of these used to
// pass the gate and two were filled: "Cittadinanza" got his town, and the two
// referee fields got his own phone and email.
const SENSITIVE_IT = [
  'Sei autorizzato a lavorare in Italia?',
  'Sei autorizzata a lavorare in Italia senza sponsorizzazione?',
  'Hai diritto a lavorare in Italia?',
  'Permesso di soggiorno',
  'Sei in possesso di un permesso di soggiorno valido?',
  'Cittadinanza',
  'Nazionalità',
  'Categorie protette (L. 68/99)',
  'Appartieni alle categorie protette ai sensi della legge 68/99?',
  'Invalidità civile',
  'Genere',
  'Sesso',
  'Identità di genere',
  'Condanne penali',
  'Hai riportato condanne penali?',
  'Casellario giudiziale',
  'Servizio militare',
  'Sei disposto a trasferirti?',
  'Disponibile a trasferimenti sul territorio nazionale?',
  'Aspettativa salariale',
  'Retribuzione annua lorda desiderata',
  'Stipendio attuale',
  'Referenze professionali',
  'Telefono del referente',
  'Email del referente',
  'Preavviso contrattuale',
  'Disponibilità a partire dal',
];
for (const label of SENSITIVE_IT) ok(`never-fill (it): ${label}`, isNeverFill(label));

// OVERREACH_IT: the Italian labels the widened patterns must NOT swallow.
// "riferimento" is a posting id and stays fillable; "referente" is a person and does not.
const OVERREACH_IT = [
  'Città', 'Città di residenza', 'Numero di riferimento', 'Codice di riferimento dell\'annuncio',
  'Che tipo di lavoro ti piace?', 'Nome', 'Cognome', 'Nome e cognome', 'Telefono',
  'Come ci hai conosciuto?', 'Perché vuoi lavorare con noi?', 'Profilo LinkedIn',
];
for (const label of OVERREACH_IT) ok(`fillable (it): ${label}`, !isNeverFill(label));

const sources = {
  profile: { full_name: 'Ada Rossi', email: 'ada.rossi@example.com', phone: '+39 000 000 0000',
             location: 'Sesto San Giovanni (Milan), Italy', linkedin: 'https://linkedin.com/in/x' },
  answerBank: { 'how did you hear about us': 'Through the company careers page.' },
};

// -- a resolvable field carries its source --
const name = resolveField({ label: 'First name', type: 'text' }, sources);
eq('resolves first name', name.value, 'Ada');
eq('names the source', name.source, 'config/profile.yml:candidate.full_name');

const email = resolveField({ label: 'Email address', type: 'text' }, sources);
eq('resolves email', email.value, 'ada.rossi@example.com');

const bank = resolveField({ label: 'How did you hear about us?', type: 'textarea' }, sources);
eq('resolves from the answer bank', bank.value, 'Through the company careers page.');
eq('answer bank is named as the source', bank.source, 'data/answer-bank.md');

// -- an unknown field is never guessed --
const unknown = resolveField({ label: 'What is your favourite album?', type: 'text' }, sources);
eq('unknown field has no value', unknown.value, null);
eq('unknown field has no source', unknown.source, null);
ok('unknown field produces a question', typeof unknown.ask === 'string' && unknown.ask.length > 0);

// -- a never-fill field is refused even when a source could supply it --
const salary = resolveField({ label: 'Salary expectation', type: 'text' }, {
  ...sources, profile: { ...sources.profile, target_range: 'EUR 22K-28K' },
});
eq('never-fill wins over an available source', salary.value, null);
ok('never-fill explains itself', /candidate|yours|you/i.test(salary.ask));

// -- planFills separates the two piles and loses nothing --
const fields = [
  { label: 'First name', type: 'text' },
  { label: 'Email address', type: 'text' },
  { label: 'Are you legally authorized to work in the EU?', type: 'select', options: ['Yes', 'No'] },
  { label: 'What is your favourite album?', type: 'text' },
];
const plan = planFills(fields, sources);
eq('two fields are fillable', plan.fills.length, 2);
eq('two fields are raised', plan.asks.length, 2);
eq('every field is accounted for', plan.fills.length + plan.asks.length, fields.length);
ok('every fill names a source', plan.fills.every(f => typeof f.source === 'string' && f.source.length > 0));
ok('no fill has a null value', plan.fills.every(f => f.value !== null && f.value !== ''));

// -- names: every Italian label used to resolve to the FIRST name --
// "Cognome" contains "nome", and the first-name rule ran first, so the surname
// box, the full-name box and the first-name box all received "Ada".
for (const [label, expected] of [
  ['Nome', 'Ada'],
  ['Cognome', 'Rossi'],
  ['Nome e cognome', 'Ada Rossi'],
  ['Nome completo', 'Ada Rossi'],
  ['First name', 'Ada'],
  ['Last name', 'Rossi'],
  ['Surname', 'Rossi'],
  ['Full name', 'Ada Rossi'],
  ['Name', 'Ada Rossi'],
  ['Your name', 'Ada Rossi'],
]) eq(`name rule: ${label}`, resolveField({ label, type: 'text' }, sources).value, expected);

// "citt" alone matched "cittadinanza" and answered a citizenship question with a town.
eq('Città resolves to the location', resolveField({ label: 'Città', type: 'text' }, sources).value, sources.profile.location);
eq('Cittadinanza is refused, not answered with a town', resolveField({ label: 'Cittadinanza', type: 'text' }, sources).value, null);
eq('Telefono del referente is not his own phone', resolveField({ label: 'Telefono del referente', type: 'text' }, sources).value, null);
eq('Email del referente is not his own email', resolveField({ label: 'Email del referente', type: 'text' }, sources).value, null);

// -- an unlabelled field is never filled (the empty-key hole) --
// normalise('') === '', and every bank key .includes('') — so an unread label
// used to walk out with the FIRST answer-bank entry and source
// 'data/answer-bank.md', which fillForm's non-empty-source guard then accepted.
for (const label of ['', '   ', '\n\t', '*', ':', '?']) {
  const r = resolveField({ label, type: 'textarea' }, sources);
  eq(`unlabelled field is not filled: ${JSON.stringify(label)}`, r.value, null);
  eq(`unlabelled field has no source: ${JSON.stringify(label)}`, r.source, null);
  ok(`unlabelled field is raised: ${JSON.stringify(label)}`, typeof r.ask === 'string' && r.ask.length > 0);
}
// A bank whose own key is empty must not match a real label either.
eq('an empty bank key matches nothing', resolveField(
  { label: 'What is your favourite album?', type: 'text' },
  { profile: {}, answerBank: { '': 'Through the company careers page.' } },
).value, null);

// -- a field the script must not touch is raised, not dropped (I5) --
const fileField = resolveField(
  { label: 'Resume / CV', type: 'file', unfillable: 'attaching the file is yours to make.' },
  sources,
);
eq('an unfillable field is never filled', fileField.value, null);
ok('an unfillable field explains why', /yours to make/.test(fileField.ask));

// -- planFills carries each field's selector, not just its label (I4) --
// Two fields can share a label; resolving the selector by label afterwards
// wrote both values into the first field and reported both as written.
const dupes = [
  { label: 'Email address', type: 'text', selector: '#em' },
  { label: 'Email address', type: 'text', selector: '#em-confirm' },
];
const dupePlan = planFills(dupes, sources);
eq('both duplicate-label fields are planned', dupePlan.fills.length, 2);
eq('each fill carries its own selector', dupePlan.fills.map(f => f.selector), ['#em', '#em-confirm']);
ok('every fill carries a selector', [...dupePlan.fills, ...plan.fills].every(f => 'selector' in f));

