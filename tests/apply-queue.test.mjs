/**
 * apply-queue.test.mjs — tests for apply-queue.mjs
 * Run: node apply-queue.test.mjs
 */
import { QUEUE_COLUMNS, readQueue, writeQueue, upsertRow, validateRow, validateQueue, parsePipeline, rowsFromPipeline, pickAcrossPortals } from '../apply-queue.mjs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
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

const dir = mkdtempSync(join(tmpdir(), 'aq-'));
const file = join(dir, 'queue.tsv');

eq('columns are the 12 in spec order', QUEUE_COLUMNS, [
  'slug', 'url', 'company', 'role', 'location', 'archetype',
  'level', 'score', 'summary_line', 'pack', 'apply', 'date',
]);

eq('missing file reads as empty', readQueue(file), []);

const row = {
  slug: 'acme-ai-intern', url: 'https://jobs.lever.co/acme/1', company: 'Acme', role: 'AI Intern',
  location: 'Milan', archetype: 'Agentic', level: 'entry', score: 4.2,
  summary_line: 'Builds automations with coding agents.', pack: 'pending', apply: 'queued', date: '2026-09-11',
};
writeQueue(file, [row]);
eq('round-trips one row', readQueue(file), [{ ...row, score: 4.2 }]);

const two = upsertRow([row], { ...row, slug: 'other-role' });
eq('upsert appends a new slug', two.length, 2);
const replaced = upsertRow(two, { ...row, pack: 'built' });
eq('upsert replaces same slug in place', replaced.length, 2);
eq('upsert keeps position', replaced[0].pack, 'built');

eq('valid row has no problems', validateRow(row), []);
ok('bad pack state is reported', validateRow({ ...row, pack: 'nonsense' }).some(p => p.includes('pack')));
ok('bad apply state is reported', validateRow({ ...row, apply: 'nonsense' }).some(p => p.includes('apply')));
ok('out-of-range score is reported', validateRow({ ...row, score: 9 }).some(p => p.includes('score')));
ok('empty slug is reported', validateRow({ ...row, slug: '' }).some(p => p.includes('slug')));

// A tab inside a value would corrupt the TSV; it must be neutralised on write.
writeQueue(file, [{ ...row, summary_line: 'has\ttab and\nnewline' }]);
eq('tabs and newlines are neutralised', readQueue(file)[0].summary_line, 'has tab and newline');

// Comment and blank lines are ignored on read.
writeFileSync(file, `# header\n\n${QUEUE_COLUMNS.map(() => 'x').join('\t')}\n`);
eq('comments and blanks are skipped', readQueue(file).length, 1);

// -- importing data/pipeline.md into the queue --
const pipeline = `# Pipeline

## Pending

- [ ] https://jobs.lever.co/acme/1
- [ ] https://jobs.ashbyhq.com/beta/2 | Beta | AI Intern
- [ ] https://job-boards.greenhouse.io/gamma/jobs/3 | Gamma | Data Analyst | Milan, Italy
- [ ] https://jobs.ashbyhq.com/delta/4 | Delta | Growth Lead | Remote | 50000-60000 EUR
- [!] https://private.example/job — Error: login required

## Processed

- [x] #9 | https://jobs.lever.co/done/9 | Done Co | Shipped | 4.0/5 | PDF ✅
`;
const entries = parsePipeline(pipeline);
eq('only pending entries are imported', entries.length, 4);
eq('processed entries are ignored', entries.some(e => e.url.includes('/done/')), false);
eq('error entries are ignored', entries.some(e => e.url.includes('private.example')), false);
eq('a bare url still imports', entries[0].url, 'https://jobs.lever.co/acme/1');
eq('a bare url has empty company and role', [entries[0].company, entries[0].role], ['', '']);
eq('three columns give company and role', [entries[1].company, entries[1].role], ['Beta', 'AI Intern']);
eq('four columns give location', entries[2].location, 'Milan, Italy');
eq('five columns still give location', entries[3].location, 'Remote');

const fresh = rowsFromPipeline(entries, '2026-09-11');
eq('fresh rows are pending and queued', [fresh[1].pack, fresh[1].apply], ['pending', 'queued']);
eq('fresh rows carry the date', fresh[1].date, '2026-09-11');
eq('fresh rows have no score yet', fresh[1].score, '');
eq('slug comes from company and role', fresh[1].slug, 'beta-ai-intern');
ok('a bare url still gets a non-empty slug', fresh[0].slug.length > 0);
ok('slugs are unique', new Set(fresh.map(r => r.slug)).size === fresh.length);

// -- validation of pack and apply states --
ok('empty pack is reported as invalid', validateRow({ ...row, pack: '' }).some(p => p.includes('pack')));
ok('empty apply is reported as invalid', validateRow({ ...row, apply: '' }).some(p => p.includes('apply')));

// -- queue-wide validation --
ok('duplicate slugs are reported', validateQueue([row, { ...row, slug: 'acme-ai-intern' }]).some(p => p.includes('duplicate slug')));

// -- C4: a repost must not land on the original's slug (and its pack directory) --
// detect-reposts.mjs exists precisely because a company relists the same role
// at a new URL. Same company + same title = same slug, and the slug IS the
// output/apply/{slug}/ directory, so the second pack overwrote the first and
// upsertRow resolved both rows to index 0.
const repostA = { url: 'https://jobs.lever.co/acme/1', company: 'Acme', role: 'AI Intern', location: 'Milan' };
const repostB = { url: 'https://jobs.lever.co/acme/2', company: 'Acme', role: 'AI Intern', location: 'Milan' };

const firstImport = rowsFromPipeline([repostA], '2026-09-11');
const secondImport = rowsFromPipeline([repostB], '2026-09-12', firstImport.map(r => r.slug));
eq('the first import takes the bare slug', firstImport[0].slug, 'acme-ai-intern');
eq('a repost imported later gets its own slug', secondImport[0].slug, 'acme-ai-intern-2');
ok('the two rows have distinct slugs', firstImport[0].slug !== secondImport[0].slug);
ok('distinct slugs mean distinct pack directories', firstImport[0].slug !== secondImport[0].slug);
eq('both slugs survive a queue-wide validation', validateQueue([...firstImport, ...secondImport]), []);

// A third repost keeps counting rather than colliding with the -2 row.
eq('a third repost gets -3', rowsFromPipeline([{ ...repostB, url: 'https://jobs.lever.co/acme/3' }], '2026-09-13',
  [...firstImport, ...secondImport].map(r => r.slug))[0].slug, 'acme-ai-intern-3');
// Within one batch the old behaviour is unchanged.
eq('two collisions in one batch still get base and -2',
  rowsFromPipeline([repostA, repostB], '2026-09-11').map(r => r.slug), ['acme-ai-intern', 'acme-ai-intern-2']);

// -- C5: a row with no company or role cannot leave the pending state --
// `- [ ] {url}` is valid in pipeline.md, so an imported row can carry neither.
const bare = rowsFromPipeline([{ url: 'https://jobs.lever.co/acme/9', company: '', role: '', location: '' }], '2026-09-11')[0];
eq('a bare imported row is valid while pending', validateRow(bare), []);
ok('a bare row is invalid once it is built', validateRow({ ...bare, pack: 'built' }).some(p => p.includes('company')));
ok('a bare row names the missing role too', validateRow({ ...bare, pack: 'built' }).some(p => p.includes('role')));
ok('a bare row is invalid once the jd fetch failed', validateRow({ ...bare, pack: 'jd_failed' }).some(p => p.includes('company')));
eq('a built row with an identity stays valid', validateRow({ ...row, pack: 'built' }), []);

// -- apply-prep.sh: the stage-1 wiring the queue depends on --
// These are the exact lines the script runs. Asserting the text AND running it
// keeps the two from drifting: change the script and this fails.
const prep = readFileSync(resolve(__dirname, 'apply-prep.sh'), 'utf-8');

// I2: an unguarded grep under `set -euo pipefail` killed the script after
// printing only "2/5 liveness sweep" whenever nothing was pending.
ok('the pending grep cannot kill the script', /grep '\^- \\\[ \\\]' data\/pipeline\.md.*\|\| true/.test(prep));
ok('an empty pending list says so and exits cleanly', /Nothing pending in data\/pipeline\.md/.test(prep) && /exit 0/.test(prep));

// C4: --validate runs right after the import, so a collision or a malformed
// row stops the run instead of reaching build-packs.
ok('--validate runs immediately after --import-pipeline',
   /node apply-queue\.mjs --import-pipeline\s*\nnode apply-queue\.mjs --validate/.test(prep));

// I1: the sweep's output is captured and its expired URLs are marked dead.
// Previously check-liveness wrote nothing anywhere and its exit code was
// discarded, so every expired posting was imported, fetched, triaged and
// rendered into a full pack.
const EXTRACT_EXPIRED = `grep '^\u274c' "$SWEEP" | awk '{print $NF}' | sort -u`;
const LOOKUP_SLUG = `awk -F'\\t' -v u="$url" '$2 == u {print $1; exit}' data/apply-queue.tsv`;
ok('the liveness sweep is captured to a file', prep.includes('| tee "$SWEEP"'));
ok('the expired URLs are extracted from it', prep.includes(EXTRACT_EXPIRED));
ok('each expired URL is resolved to a slug', prep.includes(LOOKUP_SLUG));
ok('and that slug is marked dead', /node apply-queue\.mjs --set "\$slug" apply=dead/.test(prep));

// Run those two pipelines against real fixtures, in check-liveness.mjs's own
// output format, to prove they actually parse it.
const sweepFile = join(dir, 'liveness.txt');
writeFileSync(sweepFile, [
  'Checking 3 URL(s)... (throttle ~5-10s)',
  '',
  '\u2705 active     (api) https://jobs.lever.co/acme/1',
  '\u274c expired    (api) https://jobs.ashbyhq.com/beta/2',
  '           Lever API returned 404',
  '\u26a0\ufe0f uncertain        https://job-boards.greenhouse.io/gamma/jobs/3',
  '           could not tell',
  '\u274c expired          https://jobs.ashbyhq.com/delta/4',
  '',
  'Results: 1 active  2 expired  1 uncertain  (2 via API, no browser)',
].join('\n'));
const expired = execSync(EXTRACT_EXPIRED.replace('"$SWEEP"', JSON.stringify(sweepFile)), { encoding: 'utf-8' })
  .trim().split('\n');
eq('only the expired URLs are extracted', expired,
   ['https://jobs.ashbyhq.com/beta/2', 'https://jobs.ashbyhq.com/delta/4']);

const queueFile = join(dir, 'apply-queue.tsv');
writeQueue(queueFile, [
  { ...row, slug: 'beta-ai-intern', url: 'https://jobs.ashbyhq.com/beta/2', company: 'Beta', role: 'AI Intern' },
  { ...row, slug: 'acme-ai-intern', url: 'https://jobs.lever.co/acme/1' },
]);
const lookup = (url) => execSync(
  LOOKUP_SLUG.replace('"$url"', JSON.stringify(url)).replace('data/apply-queue.tsv', JSON.stringify(queueFile)),
  { encoding: 'utf-8' },
).trim();
eq('an expired URL resolves to its slug', lookup('https://jobs.ashbyhq.com/beta/2'), 'beta-ai-intern');
eq('a URL not in the queue resolves to nothing', lookup('https://example.com/gone'), '');
eq('the lookup matches the url column, not a substring', lookup('https://jobs.ashbyhq.com/beta/'), '');

// ---------------------------------------------------------------------------
// pickAcrossPortals — il limite della ricerca
//
// Fermarsi ai primi N della lista darebbe N annunci sempre dal portale che
// risponde per primo: nei 270 trovati finora Ashby e Greenhouse da soli
// facevano il 78%. Quindi si prende a turno un portale alla volta.
// ---------------------------------------------------------------------------
const e = (host, n) => ({ url: `https://${host}/job/${n}`, company: host.split('.')[0], role: `Role ${n}`, location: '' });
const hostsOf = (picked) => picked.map((x) => new URL(x.url).host);

eq('senza limite non tocca niente',
  pickAcrossPortals([e('a.com', 1), e('a.com', 2)], undefined).length, 2);

eq('cinque su tre portali pescano a turno',
  hostsOf(pickAcrossPortals([
    e('a.com', 1), e('a.com', 2), e('a.com', 3), e('a.com', 4),
    e('b.com', 1), e('b.com', 2),
    e('c.com', 1),
  ], 5)),
  ['a.com', 'b.com', 'c.com', 'a.com', 'b.com']);

eq('cinque su tredici portali danno cinque portali distinti',
  new Set(hostsOf(pickAcrossPortals(
    Array.from({ length: 13 }, (_, i) => [e(`h${i}.com`, 1), e(`h${i}.com`, 2)]).flat(), 5,
  ))).size, 5);

eq('dentro un portale tiene l\'ordine in cui la scansione li ha trovati',
  pickAcrossPortals([e('a.com', 1), e('a.com', 2), e('a.com', 3)], 2).map((x) => x.role),
  ['Role 1', 'Role 2']);

eq('un limite più grande del disponibile prende tutto',
  pickAcrossPortals([e('a.com', 1), e('b.com', 1)], 99).length, 2);

eq('un portale solo si comporta come una lista',
  pickAcrossPortals([e('a.com', 1), e('a.com', 2), e('a.com', 3)], 2).length, 2);

eq('limite zero non prende niente', pickAcrossPortals([e('a.com', 1)], 0).length, 0);

eq('un url malformato non fa cadere la selezione',
  pickAcrossPortals([{ url: 'non-un-url', company: '', role: 'X', location: '' }, e('a.com', 1)], 2).length, 2);

eq('l\'ordine dei portali è quello di prima apparizione',
  hostsOf(pickAcrossPortals([e('z.com', 1), e('a.com', 1)], 2)), ['z.com', 'a.com']);

rmSync(dir, { recursive: true, force: true });

