#!/usr/bin/env node
/**
 * candidate-brief.mjs — the one description of who is applying.
 *
 * Both the triage and the deep read have to tell the model who the candidate
 * is, and for a while each carried its own copy. Two descriptions of the same
 * person drift, and the one that drifts is the one nobody rereads, so there is
 * one and it lives in a file the candidate owns.
 *
 * The file is deliberately outside version control. It is the most personal
 * text in the repo — what someone did, what they cannot do, what they are
 * willing to settle for — and it belongs to whoever cloned this, not to the
 * project. `candidate-brief.example.md` is the shipped stand-in.
 *
 * A missing file is an error, never a fallback to the example. Scoring
 * somebody else's postings against a stranger's profile would produce numbers
 * that look exactly like real ones.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';

export const BRIEF_FILE = 'candidate-brief.md';

/** Marks a section the panel shows and the model never receives. */
export const PANEL_ONLY = '<!-- pannello -->';

/** Read the file, or say plainly which one is missing and what to do about it. */
export function readBriefFile(root = getCareerOpsRoot()) {
  const path = resolve(root, BRIEF_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `${BRIEF_FILE} is missing. Copy candidate-brief.example.md to ${BRIEF_FILE} `
      + 'and describe yourself in it: the triage and the analysis both read it, '
      + 'and neither will invent a candidate to fill the gap.',
    );
  }
  return readFileSync(path, 'utf-8');
}

/**
 * Split the brief into its sections.
 *
 * A section is a `##` heading and what follows. Lines beginning with `-` are
 * points, everything else is prose, and the two are kept apart so the panel can
 * lay out a list as a list instead of a paragraph with dashes in it.
 *
 * `panelOnly` carries the one asymmetry: some of what the candidate wants on
 * screen — the sensitive detail of a personal project, the list of gaps — has
 * no business being posted to a model with every job description.
 */
export function parseBrief(text) {
  const sections = [];
  let current = null;
  let pending = false;

  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === PANEL_ONLY) { pending = true; continue; }
    if (line.trim().startsWith('<!--')) { continue; }

    const head = /^##\s+(.*)$/.exec(line);
    if (head) {
      current = { title: head[1].trim(), points: [], prose: [], panelOnly: pending };
      pending = false;
      sections.push(current);
      continue;
    }
    if (!current || !line.trim()) continue;
    if (line.trimStart().startsWith('- ')) current.points.push(line.trimStart().slice(2).trim());
    else current.prose.push(line.trim());
  }

  return sections
    .map((s) => ({ ...s, prose: s.prose.join(' ').trim() }))
    .filter((s) => s.points.length || s.prose);
}

/**
 * The text the prompts receive: every section except the panel-only ones.
 *
 * Headings travel with it. A model reading "Cosa non posso dichiarare" above a
 * list of refusals reads them as refusals, where the same lines loose in a
 * paragraph read as trivia.
 */
export function loadCandidateBrief(root = getCareerOpsRoot()) {
  const sections = parseBrief(readBriefFile(root)).filter((s) => !s.panelOnly);
  if (!sections.length) {
    throw new Error(`${BRIEF_FILE} has nothing for the model. Describe yourself in it before running the triage.`);
  }
  return sections
    .map((s) => [`${s.title}:`, s.prose, ...s.points.map((p) => `- ${p}`)].filter(Boolean).join('\n'))
    .join('\n\n');
}

/** Everything, in order, for the panel to render. */
export function loadProfileCard(root = getCareerOpsRoot()) {
  return parseBrief(readBriefFile(root));
}
