import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './utils.js';

// Detect cross-file reliance on encoded identifier formats, not one specific ID scheme.
// Conservative by design: multiple independent consumers must parse an ID string.
export function detectEncodedIdContract(root, files, projectId) {
  const consumers = [];
  for (const file of files) {
    if (file.isTestFile || file.isToolingFile || !/\.[cm]?[jt]sx?$/.test(file.path) || file.bytes > 1024 * 1024) continue;
    const absolute = path.resolve(root, file.path);
    if (!absolute.startsWith(path.resolve(root) + path.sep)) continue;
    let source;
    try { if (!fs.realpathSync(absolute).startsWith(fs.realpathSync(root) + path.sep)) continue; source = fs.readFileSync(absolute, 'utf8'); } catch { continue; }
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(?:\/\/|\*)/.test(line)) continue;
      const nearby = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join(' ');
      const parseId = /\b(?:match|exec|split|slice|substring|parseInt|Number)\s*\(/.test(nearby);
      const idAccess = /\b\w+\.id\b/.test(nearby);
      const encodedFormat = /(?:\\d|\\w|\^|\$|\[a-z|split\s*\(|substring\s*\(|slice\s*\()/i.test(nearby);
      if (parseId && idAccess && encodedFormat && /\.id\b/.test(line)) {
        consumers.push({ path: file.path, line: i + 1, excerpt: line.trim().slice(0, 160) });
        break;
      }
    }
  }
  const related = { possibleProducers: [], possibleModels: [], relationship: 'Lexical candidates only; producer-consumer dataflow is not proven.' };
  for (const file of files) {
    if (file.isTestFile || file.isToolingFile || !/\.[cm]?[jt]sx?$/.test(file.path) || file.bytes > 1024 * 1024) continue;
    const absolute = path.resolve(root, file.path);
    try {
      if (!fs.realpathSync(absolute).startsWith(fs.realpathSync(root) + path.sep)) continue;
      const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > 400 || /^\s*(?:\/\/|\*)/.test(line)) continue;
        if (related.possibleProducers.length < 6 && /\bid\s*:\s*.*(?:Date\.now\(|randomUUID\(|uuid\(|nanoid\()/.test(line)) related.possibleProducers.push({ path: file.path, line: i + 1, excerpt: line.trim().slice(0, 160) });
        if (related.possibleModels.length < 6 && /^\s*(?:readonly\s+)?id\??\s*:\s*string\s*[;,}]?\s*$/.test(line)) related.possibleModels.push({ path: file.path, line: i + 1, excerpt: line.trim().slice(0, 160) });
      }
    } catch { /* source unavailable */ }
  }
  const paths = [...new Set(consumers.map(c => c.path))];
  if (paths.length < 2) return null;
  return {
    id: 'VM-' + sha256(projectId + '|data-contract|encoded-identifier').slice(0, 10).toUpperCase(),
    family: 'data-contract', stage: 'S2', score: 40, confidence: 0.57,
    target: 'project', title: 'Multiple modules parse an implicit identifier format',
    evidenceQuality: 'direct+heuristic',
    signals: [{ active: true, name: 'encoded_id_consumers', value: paths.length, evidence: 'Source-level identifier parsing across files', bucket: 'medium', independenceGroup: 'contract' }],
    sourceEvidence: consumers,
    relatedEvidence: related,
    whyItMatters: 'Changing the ID generator may silently break consumers that extract data from its string representation.',
    doNow: ['Document the ID format as a contract and add focused tests for consumers before changing it.'],
    prepare: ['Prefer explicit typed fields for values extracted from IDs when the data model evolves.'],
    doNotDoYet: ['Do not migrate IDs or storage solely because a parsing convention exists.'],
    nextTrigger: 'A second ID producer, persistence migration, external IDs, or a change in the ID format.',
    heuristicDisclosure: 'Lexical pattern detection only; the same identifier may legitimately encode data. Review source evidence before acting.'
  };
}
