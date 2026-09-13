#!/usr/bin/env node
/**
 * apply-session.mjs — open one application form, fill what has provenance, stop.
 *
 * The browser is visible and the profile is persistent, so logins to Greenhouse,
 * Ashby and Lever survive between sessions. The script never clicks submit and
 * never touches a file input, radio or checkbox: those are the candidate's,
 * by design.
 *
 * Usage:
 *   node apply-session.mjs --slug acme-ai-intern
 *   node apply-session.mjs --next            # the highest-scoring queued row
 *   node apply-session.mjs                   # same as --next (no argument defaults to highest-scoring)
 *
 * --next prefers a built pack but also opens a jd_failed row, saying so: that
 * posting was never triaged and has no PDFs, and the JD is read on screen.
 */
import { chromium } from 'playwright';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readQueue, writeQueue, upsertRow } from './apply-queue.mjs';
import { loadSources, planFills, isNeverFill } from './field-provenance.mjs';
import { LIVENESS_CONTEXT_OPTIONS } from './liveness-browser.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE = resolve(getCareerOpsRoot(), 'data', 'apply-queue.tsv');
const PROFILE_DIR = resolve(__dirname, '.apply-profile');

const DEAD_SIGNALS = [
  /no longer (available|open|accepting)/i,
  /position has been filled/i,
  /this job (has )?expired/i,
  /page not found/i,
];

/**
 * Refuse to touch a form that is not the one the pack was built for.
 *
 * Two failure kinds, both stopping the session: the posting is closed, or the
 * company and role on screen do not match the row. The session never adapts
 * silently to a different job than the one that was evaluated.
 */
export function checkIdentity(pageText, pageTitle, row) {
  const text = `${pageTitle || ''}\n${pageText || ''}`;
  if (text.trim().length < 200) {
    return { ok: false, kind: 'dead', reason: 'The page has almost no content, which usually means the posting is gone.' };
  }
  for (const re of DEAD_SIGNALS) {
    if (re.test(text)) {
      return { ok: false, kind: 'dead', reason: `The page says the posting is closed (matched ${re}).` };
    }
  }
  // Company and role evidence must come from the rendered body, never the
  // title: many ATS boards paint the title from client-side routing before
  // the job body hydrates, or keep a stale title across a redirect to a
  // different posting. The title is trustworthy only as "the page loaded at
  // all" (the length and dead-signal checks above use it for that) — never
  // as proof this is the right job. Do not fold it back into `haystack`.
  const haystack = String(pageText || '').toLowerCase();
  const company = String(row.company || '').toLowerCase().trim();
  const role = String(row.role || '').toLowerCase().trim();
  if (company && !haystack.includes(company)) {
    return { ok: false, kind: 'mismatch', reason: `The page never mentions "${row.company}". The pack was built for ${row.company} — ${row.role}. Re-evaluate, or stop?` };
  }
  // A row with neither a company nor a role turns both checks below into
  // no-ops (`company &&` and `roleWords.length &&` both short-circuit), so the
  // mandatory gate would pass any page over 200 characters. There is nothing
  // to check against: that is a stop, not a pass.
  if (!company && !role) {
    return {
      ok: false, kind: 'mismatch',
      reason: 'This row carries no company and no role, so there is nothing to check the page against. '
        + 'The identity gate cannot run. Fill company and role in data/apply-queue.tsv, or drop the row.',
    };
  }
  // Match on the role's distinctive words rather than the exact string: boards
  // routinely reformat a title without changing the job.
  const roleWords = role.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const hits = roleWords.filter((w) => haystack.includes(w)).length;
  if (roleWords.length && hits / roleWords.length < 0.5) {
    return { ok: false, kind: 'mismatch', reason: `The page does not look like "${row.role}". The pack was built for ${row.company} — ${row.role}. Re-evaluate, or stop?` };
  }
  return { ok: true };
}

/**
 * Read every labelled input on the page.
 * Labels come from <label for>, an ancestor <label>, or aria-label, in that order.
 *
 * Radios and checkboxes are grouped by `name` first and emitted as ONE field
 * per group: every option in a group generates the same selector, so without
 * grouping the dedup below would keep only the first option and mislabel the
 * whole group with that single option's own label (a "Contact via email /
 * phone" radio group would surface as a field literally labelled "Email").
 */
export async function readFormFields(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();

    const UNREADABLE = 'I could not read a label for this field, so I will not guess what it asks. Read it on screen and fill it yourself.';
    const UNADDRESSABLE = 'this field has no id and no name, so I cannot address it reliably. Read it on screen and fill it yourself.';
    const YOURS_TO_ATTACH = 'attaching the file is yours to make — this script never uploads anything.';

    /** Collapse whitespace and drop a trailing required marker. */
    function tidy(text) {
      return String(text || '').replace(/\s+/g, ' ').trim().replace(/\*+$/, '').trim();
    }

    /** Something to call a field by when its label cannot be read. */
    function describe(el) {
      const where = el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : 'no id, no name';
      return `unlabelled ${el.tagName.toLowerCase()}${el.type ? `[${el.type}]` : ''} (${where})`;
    }

    /** Label for one input: <label for>, an ancestor <label>, or aria-label/placeholder. */
    function ownLabel(el) {
      let label = '';
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) label = l.textContent.trim();
      }
      if (!label) label = el.closest('label')?.textContent?.trim() || '';
      if (!label) label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
      return label;
    }

    const groups = new Map(); // name -> {type, elements: [...]}
    for (const el of document.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
      if (el.disabled || !el.name) continue;
      if (!groups.has(el.name)) groups.set(el.name, { type: el.type, elements: [] });
      groups.get(el.name).elements.push(el);
    }

    for (const [name, group] of groups) {
      const first = group.elements[0];
      const fieldset = first.closest('fieldset');
      // Never use an individual option's own label as the group's label —
      // that is what produced "Email" for a two-way contact-method group.
      let label = fieldset?.querySelector('legend')?.textContent?.trim() || '';
      if (!label) {
        const optionLabelEls = new Set(
          group.elements.map((o) => o.id && document.querySelector(`label[for="${CSS.escape(o.id)}"]`)).filter(Boolean),
        );
        let node = (fieldset || first).previousElementSibling;
        while (node && !label) {
          if (!optionLabelEls.has(node) && node.textContent?.trim()) label = node.textContent.trim();
          node = node.previousElementSibling;
        }
      }

      const selector = `${first.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
      if (seen.has(selector)) continue;
      seen.add(selector);

      const options = group.elements.map(ownLabel).filter(Boolean);
      const clean = tidy(label);
      out.push({
        label: clean || describe(first),
        type: group.type,
        options,
        selector,
        ...(clean ? {} : { unfillable: UNREADABLE }),
      });
    }

    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.type === 'hidden' || el.disabled) continue;
      if ((el.type === 'radio' || el.type === 'checkbox') && el.name && groups.has(el.name)) continue; // handled above

      const label = tidy(ownLabel(el));
      const selector = el.id ? `#${CSS.escape(el.id)}`
        : el.name ? `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]` : '';

      const type = el.tagName === 'SELECT' ? 'select'
        : el.tagName === 'TEXTAREA' ? 'textarea'
        : el.type || 'text';
      const options = el.tagName === 'SELECT'
        ? Array.from(el.options).map((o) => o.textContent.trim()).filter(Boolean)
        : undefined;

      // Three classes used to be dropped here with a bare `continue`, so they
      // appeared nowhere: not in FILLED, not in YOURS TO ANSWER, nowhere. The
      // report is meant to be a complete account of the form, so each one is
      // emitted with the reason it cannot be filled.
      if (!selector) {
        out.push({ label: label || describe(el), type, options, selector: '', unfillable: UNADDRESSABLE });
        continue;
      }
      if (seen.has(selector)) continue;
      seen.add(selector);

      if (!label) {
        out.push({ label: describe(el), type, options, selector, unfillable: UNREADABLE });
        continue;
      }
      if (type === 'file') {
        out.push({ label, type, options, selector, unfillable: YOURS_TO_ATTACH });
        continue;
      }
      out.push({ label, type, options, selector });
    }
    return out;
  });
}

/**
 * Pick the row to open.
 *
 * --next takes the highest-scoring queued row. A row whose JD could not be
 * fetched (jd_failed) is included: the spec promises the session still opens
 * it and the JD is read live from the page. It has no pack, so nothing can be
 * attached — the caller says so out loud.
 */
export function selectRow(rows, slug) {
  if (slug) return rows.find((r) => r.slug === slug) || null;
  return rows
    .filter((r) => (r.apply === 'queued' || r.apply === 'chosen') && (r.pack === 'built' || r.pack === 'jd_failed'))
    .sort((a, b) => Number(b.score) - Number(a.score))[0] || null;
}

/**
 * Type each planned value into its field.
 *
 * This is its own boundary, not just a pipe for planFills' output: it refuses
 * a never-fill label and a fill with no source even when called directly, so
 * the guarantee holds no matter what constructs the `fills` array. It also
 * never writes into a file, radio or checkbox input — Playwright's own
 * refusal to `.fill()` those is not a guarantee this module gets to borrow.
 */
export async function fillForm(page, fills) {
  const results = [];
  for (const f of fills) {
    if (isNeverFill(f.label)) {
      results.push({ ...f, ok: false, error: 'never-fill field: this is the candidate\'s to answer, not filled even when handed a value' });
      continue;
    }
    if (typeof f.source !== 'string' || !f.source.trim()) {
      results.push({ ...f, ok: false, error: 'no source of truth attached to this value' });
      continue;
    }
    if (typeof f.selector !== 'string' || !f.selector.trim()) {
      results.push({ ...f, ok: false, error: 'no selector: this field cannot be addressed, so it is yours to fill' });
      continue;
    }
    try {
      const handle = await page.$(f.selector);
      if (!handle) { results.push({ ...f, ok: false, error: 'field not found' }); continue; }
      const tag = await handle.evaluate((el) => el.tagName.toLowerCase());
      const type = await handle.evaluate((el) => el.type || '');
      if (type === 'file' || type === 'radio' || type === 'checkbox') {
        results.push({ ...f, ok: false, error: `${type} fields are never filled` });
        continue;
      }
      if (tag === 'select') await page.selectOption(f.selector, { label: f.value });
      else await page.fill(f.selector, f.value);
      results.push({ ...f, ok: true });
    } catch (err) {
      results.push({ ...f, ok: false, error: err.message });
    }
  }
  return results;
}

/** The mandatory pre-submit review: what was filled, from where, and what is left. */
export function renderProvenanceReport(filled, asks) {
  const lines = ['', 'FILLED — every value below, and the source it came from:', ''];
  for (const f of filled) {
    const mark = f.ok ? '  ✓' : '  ✗';
    lines.push(`${mark} ${f.label}`);
    lines.push(`      value:  ${f.value}`);
    lines.push(`      source: ${f.source}${f.ok ? '' : `  (NOT WRITTEN: ${f.error})`}`);
  }
  lines.push('', 'YOURS TO ANSWER — left empty on purpose:', '');
  for (const a of asks) lines.push(`  ? ${a.label}\n      ${a.reason}`);
  lines.push(
    '',
    'STILL YOURS: attach the CV and the cover letter from the pack directory,',
    'read the whole form, then submit. This script does not upload and does not submit.',
    '',
  );
  return lines.join('\n');
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  let rows = readQueue(QUEUE);
  const slug = args.includes('--slug') ? args[args.indexOf('--slug') + 1] : null;
  const useNext = args.includes('--next');
  if (slug && useNext) {
    console.error('Pass either --slug <slug> or --next, not both.');
    process.exit(1);
  }
  const row = selectRow(rows, slug);

  if (!row) { console.error('No matching row. Run build-packs.mjs first.'); process.exit(1); }

  const sources = loadSources({
    profileYml: resolve(__dirname, 'config', 'profile.yml'),
    answerBankPath: resolve(getCareerOpsRoot(), 'data', 'answer-bank.md'),
  });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    ...LIVENESS_CONTEXT_OPTIONS,
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(row.url, { waitUntil: 'domcontentloaded' });

  console.log(`\n${row.company} — ${row.role}  (${row.score}/5)`);
  if (row.pack === 'jd_failed') {
    console.log('NO PACK: the job description could not be fetched, so this role was never triaged');
    console.log('and no CV or cover letter was built. Read the posting on screen. Nothing to attach.\n');
  } else {
    console.log(`Pack: output/apply/${row.slug}/\n`);
  }

  // The identity gate runs before a single character is typed.
  const pageText = await page.evaluate(() => document.body?.innerText || '');
  const identity = checkIdentity(pageText, await page.title(), row);
  if (!identity.ok) {
    console.log(`STOPPED — ${identity.reason}\n`);
    if (identity.kind === 'dead') {
      rows = upsertRow(rows, { ...row, apply: 'dead' });
      writeQueue(QUEUE, rows);
      console.log(`Marked ${row.slug} as dead. Run again with --next for the following role.`);
    } else {
      console.log('Nothing was filled. Tell me whether to re-evaluate this posting or skip it.');
    }
    await context.close();
    process.exit(0);
  }

  // Every field goes through planFills, file inputs included: they come back
  // in the asks pile rather than disappearing. The plan carries each field's
  // own selector, so two fields sharing a label get written separately.
  const fields = await readFormFields(page);
  const plan = planFills(fields, sources);
  const filled = await fillForm(page, plan.fills);

  console.log(renderProvenanceReport(filled, plan.asks));

  rows = upsertRow(rows, { ...row, apply: 'opened' });
  writeQueue(QUEUE, rows);
  console.log('The browser stays open. Mark the outcome with:');
  console.log(`  node apply-queue.mjs --set ${row.slug} apply=submitted`);
}
