// Schema-drift check for the transcript fixtures. The Claude Code JSONL format is undocumented and
// unstable, so the committed fixtures in test/fixtures are hand-written approximations of it. This
// script is what keeps them honest: it reads the real eval corpus, collects the set of field paths
// and leaf types per record type, and diffs that against what the fixtures encode.
//
// It prints field paths, record-type names and leaf types only, never field values, so its output
// is safe to paste into an issue. The corpus is never committed, so this is a local gate, never a
// CI one. Point it at a corpus with the first argument or SEBASTIAN_EVAL_CORPUS.
//
// Exits 1 when a fixture asserts something the corpus does not support: a missing contract path,
// an invented record type, an invented field path, or a leaf type the corpus never produces. An
// uncovered corpus record type only reports: fixtures cover the types the loop reasons about.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const MAX_DEPTH = 8;
const MAX_LISTED = 15;

// Paths src/transcript reads by name. Absence is fatal to a specific behaviour, named here so a
// failure says what broke rather than which regex missed. The fallbacks that only apply when a
// primary is absent (attachment.filePath, attachment.path, session_id) are deliberately excluded.
const CONTRACT_PATHS = [
  ['uuid', 'anchor identity and the preserved-message join'],
  ['sessionId', 'anchor provenance'],
  ['type', 'record classification'],
  ['timestamp', 'anchor ordering'],
  ['message.role', 'speaker attribution'],
  ['message.content', 'every anchor body'],
  ['subtype', 'compact_boundary detection'],
  ['compactMetadata.trigger', 'auto-versus-manual steering'],
  ['compactMetadata.preservedMessages.allUuids', 'reconciliation preserved set'],
  ['isCompactSummary', 'summary exclusion from anchors'],
  ['isMeta', 'genuine-user predicate'],
  ['attachment.type', 'restored-file classification'],
  ['attachment.filename', 'restoredPaths'],
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function leafType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function note(shape, path, type) {
  const types = shape.get(path) ?? new Set();
  types.add(type);
  shape.set(path, types);
}

// Every node contributes its own container type before the walk descends, so a field that changes
// from string to array shows up as a conflict on the field itself, not only on its children.
function collectPaths(value, prefix, shape, depth) {
  if (prefix !== '') note(shape, prefix, leafType(value));
  if (depth >= MAX_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, `${prefix}[]`, shape, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    collectPaths(child, prefix === '' ? key : `${prefix}.${key}`, shape, depth + 1);
  }
}

function jsonlRecords(path) {
  const records = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const record = JSON.parse(line);
      if (isPlainObject(record)) records.push(record);
    } catch {
      continue;
    }
  }
  return records;
}

// One census: record type to its field paths, plus how many records of that type were seen.
function census(paths) {
  const shapes = new Map();
  const counts = new Map();
  for (const file of paths) {
    for (const record of jsonlRecords(file)) {
      const type = typeof record.type === 'string' ? record.type : '(untyped)';
      counts.set(type, (counts.get(type) ?? 0) + 1);
      if (!shapes.has(type)) shapes.set(type, new Map());
      collectPaths(record, '', shapes.get(type), 0);
    }
  }
  return { shapes, counts };
}

function allPaths(shapes) {
  const paths = new Set();
  for (const shape of shapes.values()) for (const path of shape.keys()) paths.add(path);
  return paths;
}

function uncoveredTypes(corpus, fixtures) {
  return [...corpus.counts.entries()]
    .filter(([type]) => !fixtures.shapes.has(type))
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type} (${count} records)`);
}

function missingContractPaths(corpus) {
  const present = allPaths(corpus.shapes);
  return CONTRACT_PATHS.filter(([path]) => !present.has(path)).map(
    ([path, why]) => `${path} — absent from the corpus; it carries ${why}`,
  );
}

// A conflict is any leaf type a fixture asserts for a path that the corpus never produces for
// that same record type. Checked per type rather than as a set intersection, so one faithful
// fixture cannot mask a wrong shape in another.
function typeConflicts(corpus, fixtures) {
  const findings = [];
  for (const [type, fixtureShape] of fixtures.shapes) {
    const corpusShape = corpus.shapes.get(type);
    if (corpusShape === undefined) continue;
    for (const [path, fixtureTypes] of fixtureShape) {
      const corpusTypes = corpusShape.get(path);
      if (corpusTypes === undefined) continue;
      const unsupported = [...fixtureTypes].filter((t) => !corpusTypes.has(t));
      if (unsupported.length === 0) continue;
      findings.push(
        `${type}.${path}: fixture has ${unsupported.join('|')}, corpus has ${[...corpusTypes].join('|')}`,
      );
    }
  }
  return findings;
}

function inventedTypes(corpus, fixtures) {
  return [...fixtures.shapes.keys()]
    .filter((type) => !corpus.shapes.has(type))
    .sort()
    .map((type) => `${type} — no corpus record carries this type`);
}

// A path is invented when the corpus has the record type but no record of that type carries the
// path. Checked per type, not against a global path set: a global set reads `uuid` as present
// because user and assistant records carry it, and so cannot see a fixture putting a uuid on a
// `mode` record, which never has one. Types absent from the corpus are inventedTypes' finding, and
// the census unions every record of a type, so a path missing here is missing from all of them.
function inventedPaths(corpus, fixtures) {
  const findings = [];
  for (const [type, shape] of fixtures.shapes) {
    const corpusShape = corpus.shapes.get(type);
    if (corpusShape === undefined) continue;
    for (const path of shape.keys()) {
      if (!corpusShape.has(path)) findings.push(`${type}.${path} — no ${type} record carries this`);
    }
  }
  return findings.sort();
}

function report(title, lines, fatal) {
  if (lines.length === 0) return 0;
  console.log(`\n${fatal ? 'FAIL' : 'INFO'}  ${title}`);
  for (const line of lines.slice(0, MAX_LISTED)) console.log(`  ${line}`);
  if (lines.length > MAX_LISTED) console.log(`  ...and ${lines.length - MAX_LISTED} more`);
  return fatal ? lines.length : 0;
}

function jsonlIn(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(dir, name));
}

function main() {
  const corpusDir = process.argv[2] ?? process.env.SEBASTIAN_EVAL_CORPUS;
  if (corpusDir === undefined) {
    console.error('usage: node scripts/check-fixture-shapes.mjs <corpus-dir>');
    console.error('   or: SEBASTIAN_EVAL_CORPUS=<corpus-dir> npm run check:shapes');
    process.exit(2);
  }
  const corpus = census(jsonlIn(corpusDir));
  const fixtures = census(jsonlIn(FIXTURE_DIR));
  console.log(
    `corpus: ${corpus.counts.size} record types, ${allPaths(corpus.shapes).size} field paths\n` +
      `fixtures: ${fixtures.counts.size} record types, ${allPaths(fixtures.shapes).size} field paths`,
  );
  let failures = 0;
  failures += report('contract paths missing from the corpus', missingContractPaths(corpus), true);
  failures += report('fixture record types the corpus never has', inventedTypes(corpus, fixtures), true);
  failures += report('leaf-type conflicts', typeConflicts(corpus, fixtures), true);
  failures += report('fixture paths no corpus record has', inventedPaths(corpus, fixtures), true);
  report('corpus record types no fixture covers', uncoveredTypes(corpus, fixtures), false);
  console.log(failures === 0 ? '\nno drift.' : `\n${failures} drift findings.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
