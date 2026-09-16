#!/usr/bin/env node
/**
 * field-provenance.mjs — decide what may be typed into a form field, and why.
 *
 * Two rules, both absolute:
 *   1. A value is written only when it resolves to a named source.
 *   2. The never-fill list is refused even when a source could supply it.
 *
 * Keeping this module free of any browser import is deliberate: the rules are
 * testable on their own, and that test is what proves the guarantee holds.
 */
import { readFileSync, existsSync } from 'fs';
import { load as parseYaml } from 'js-yaml';

/**
 * Questions the candidate answers personally. These carry legal, contractual or
 * demographic weight, and a wrong answer is not recoverable.
 */
export const NEVER_FILL = [
  // Widened deliberately, and re-audited whole: under-matching here means a
  // legal question gets silently filled from a guess, which is not
  // recoverable. Over-matching only means the candidate gets asked a
  // question he could have skipped. Each pattern below covers the common
  // ways an ATS words the question WITHOUT its most obvious trigger word.
  //
  // He applies in Italy, in Italian: every pattern carries its Italian
  // phrasings too. An English-only list let "Cittadinanza" and "Telefono del
  // referente" be filled from the profile.
  /(authoriz|authoris|eligib|entitled)\w*.{0,30}\b(work|employment)\b|\b(work|employment)\b.{0,30}(authoriz|authoris|eligib|entitled)|right to work|autorizz\w*.{0,30}lavor|lavor\w*.{0,30}autorizz|diritto (a|di) lavorar|idoneit[\u00e0a].{0,20}lavor/i,
  /sponsor|visa|work permit|immigration|settled status|permanent resident|\bcitizen|permesso di soggiorno|cittadinanz|nazionalit[\u00e0a]|sponsorizzazione/i,
  /salary|compensation|remuneration|pay expectation|desired (pay|salary)|\bral\b|annual base|base (salary|pay)|expected (annual|compensation|pay)|stipendio|retribuzione|retributiv|salarial|\bcompenso\b|pretes\w*.{0,20}economic/i,
  // Notice period AND its start-date proxies: the gate must fire before any
  // answer-bank entry about availability could silently fill this.
  /notice period|preavviso|disponibilit[a\u00e0]|\bstart date\b|earliest.{0,15}(start|availab)|soonest.{0,15}start|how soon.{0,15}start|availab\w*.{0,20}start|start.{0,20}availab\w*/i,
  /relocat|willing to move|open to moving|trasferi\w*|disposto a spostar|disponibile a spostar/i,
  /disab|accommodat|medical condition|invalidit[\u00e0a]|categorie protette|legge ?68|\bl\. ?68\b|collocamento mirato/i,
  /veteran|military|armed forces|militare|servizio di leva|\bleva\b/i,
  /race|ethnic|hispanic|latino|african american|native american|pacific islander|alaska native|two or more races|gender|sexual orientation|self.?identif|pronoun|\bgenere\b|\bsesso\b|identit[\u00e0a] di genere|\betni|orientamento sessuale/i,
  /convict|criminal|felony|arrest|background (check|screen|verification)|credit check|drug (test|screen)|condann|\bpenal\w*|casellario|carichi pendenti/i,
  // Bare "References" / "Professional references" is the sensitive
  // ask-for-contacts question; "Reference number" / "Job reference" are
  // posting identifiers, not that question, and stay fillable. Italian keeps
  // the same split: "referente"/"referenze" is the person, "riferimento" is
  // the posting id and stays fillable.
  /(?<!job )\b(professional )?references?\b(?!\s*(number|id|code))|\breferen(t[ei]|z[ae])\b/i,
];

/** True when the field is one the candidate must answer personally. */
export function isNeverFill(label) {
  return NEVER_FILL.some((re) => re.test(String(label || '')));
}

/** Parse data/answer-bank.md into a {question: answer} map, skipping sourceless entries. */
export function parseAnswerBank(text) {
  const bank = {};
  const sections = String(text).split(/^## /m).slice(1);
  for (const section of sections) {
    const [heading, ...rest] = section.split('\n');
    const body = rest.join('\n');
    const sourceLine = body.match(/\*\*Source:\*\*\s*(.+)/);
    if (!sourceLine || /^none/i.test(sourceLine[1].trim())) continue;
    const answer = body.split('**Source:**')[0].trim();
    if (!answer || /ROLE-SPECIFIC/.test(answer)) continue;
    bank[heading.trim().toLowerCase()] = answer;
  }
  return bank;
}

/** Load the sources of truth from disk. */
export function loadSources({ profileYml, answerBankPath }) {
  const profile = {};
  if (profileYml && existsSync(profileYml)) {
    // A real YAML parser, not a regex: 'Ada Rossi' in single quotes used to
    // be typed into the form with the quotes on.
    const doc = parseYaml(readFileSync(profileYml, 'utf-8'));
    const candidate = doc && typeof doc === 'object' ? (doc.candidate || doc) : {};
    for (const key of ['full_name', 'first_name', 'last_name', 'email', 'phone', 'location', 'linkedin', 'github', 'portfolio_url']) {
      const v = candidate[key];
      if (v !== undefined && v !== null && String(v).trim()) profile[key] = String(v).trim();
    }
  }
  const answerBank = answerBankPath && existsSync(answerBankPath)
    ? parseAnswerBank(readFileSync(answerBankPath, 'utf-8'))
    : {};
  return { profile, answerBank };
}

// Field label patterns that map to a profile.yml key, in priority order.
const PROFILE_RULES = [
  // Order matters and is load-bearing. "Cognome" contains "nome", and
  // "Nome e cognome" contains both, so the most specific rule must run first:
  // whole name, then surname, then first name. Every Italian token is
  // \b-anchored so one label cannot satisfy a rule meant for another.
  [/nome e cognome|nome completo|full name|your name|^name$/i, (p) => p.full_name, 'config/profile.yml:candidate.full_name'],
  // first_name/last_name win when the profile spells them out: a compound
  // name split at the first space puts half of it in the wrong box.
  [/\bcognome\b|last name|surname|family name/i, (p) => p.last_name || p.full_name?.split(' ').slice(1).join(' '), 'config/profile.yml:candidate.full_name'],
  [/\bnome\b|first name|given name/i, (p) => p.first_name || p.full_name?.split(' ')[0], 'config/profile.yml:candidate.full_name'],
  [/e.?mail/i, (p) => p.email, 'config/profile.yml:candidate.email'],
  [/phone|mobile|telefono|cellulare/i, (p) => p.phone, 'config/profile.yml:candidate.phone'],
  [/linkedin/i, (p) => p.linkedin, 'config/profile.yml:candidate.linkedin'],
  [/github/i, (p) => p.github, 'config/profile.yml:candidate.github'],
  [/portfolio|website|personal site/i, (p) => p.portfolio_url, 'config/profile.yml:candidate.portfolio_url'],
  // "citt" alone also matched "cittadinanza" and filled a citizenship question
  // with a town name. Only "citt\u00e0" and "citta" as whole words mean the city.
  [/city|location|where are you based|\bcitt(\u00e0|a\b)/i, (p) => p.location, 'config/profile.yml:candidate.location'],
];

/** Normalise a form label for matching against the answer bank. */
function normalise(label) {
  return String(label || '').toLowerCase().replace(/[?*:]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Decide what to do with one field.
 * Returns {value, source} to fill, or {value: null, source: null, ask} to raise.
 */
export function resolveField(field, sources) {
  const label = String(field?.label ?? '').trim();

  // "Is this field identified?" is asked BEFORE "is this field forbidden?".
  // An unread label is an empty string, and an empty string is a substring of
  // every answer-bank key, so an unlabelled field used to walk out with the
  // first entry in the bank and a real-looking source attached. Nothing that
  // cannot be identified is ever filled.
  if (!label) {
    return {
      value: null, source: null,
      ask: 'A field with no readable label — I could not tell what it asks, so I will not guess it. Read it on screen and fill it yourself.',
    };
  }

  // A field the reader could see but this script must not touch (no id or
  // name to address it by, or a file input) still gets accounted for.
  if (field?.unfillable) {
    return { value: null, source: null, ask: `"${label}" — ${field.unfillable}` };
  }

  if (isNeverFill(label)) {
    return { value: null, source: null, ask: `"${label}" — this one is yours to answer; it carries legal or personal weight and I will not guess it.` };
  }

  const profile = sources?.profile ?? {};
  for (const [pattern, get, source] of PROFILE_RULES) {
    if (pattern.test(label)) {
      const value = get(profile);
      if (value) return { value, source };
    }
  }

  const bank = sources?.answerBank ?? {};
  const key = normalise(label);
  for (const [question, answer] of Object.entries(bank)) {
    const q = normalise(question);
    // Both sides must be non-empty: "".includes(x) and x.includes("") are the
    // two ways an empty key matches everything.
    if (!key || !q) continue;
    if (key.includes(q) || q.includes(key)) {
      return { value: answer, source: 'data/answer-bank.md' };
    }
  }

  return { value: null, source: null, ask: `"${label}" — no source of truth covers this. What should it say?` };
}

/** Split a form's fields into what can be filled and what must be raised. */
export function planFills(fields, sources) {
  const fills = [];
  const asks = [];
  for (const field of fields) {
    const r = resolveField(field, sources);
    // The plan carries each field's own selector. Two fields on one form can
    // share a label (a candidate Email and a referee Email); looking the
    // selector back up by label wrote both values into the first field and
    // reported both as written.
    if (r.value !== null && r.value !== '') {
      fills.push({ label: field.label, selector: field.selector, value: r.value, source: r.source });
    } else {
      asks.push({ label: field.label || '(unlabelled field)', selector: field.selector, reason: r.ask });
    }
  }
  return { fills, asks };
}
