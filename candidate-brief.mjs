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

/**
 * Read the candidate description, stripped of comments and blank padding.
 *
 * Markdown headings and HTML comments are dropped so the file can carry
 * instructions to its reader without sending them to the model.
 */
export function loadCandidateBrief(root = getCareerOpsRoot()) {
  const path = resolve(root, BRIEF_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `${BRIEF_FILE} is missing. Copy candidate-brief.example.md to ${BRIEF_FILE} `
      + 'and describe yourself in it: the triage and the analysis both read it, '
      + 'and neither will invent a candidate to fill the gap.',
    );
  }
  const text = readFileSync(path, 'utf-8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .trim();
  if (!text) throw new Error(`${BRIEF_FILE} is empty. Describe yourself in it before running the triage.`);
  return text;
}
