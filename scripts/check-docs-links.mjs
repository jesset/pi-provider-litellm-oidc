#!/usr/bin/env node
// Documentation link check: every relative markdown link in the tracked docs
// must resolve to an existing path. External URLs and pure anchors are skipped
// (they are checked by readers and CI network access respectively).
// Zero dependencies; run with `npm run docs:check`.
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT_DOCS = ["README.md", "README.zh-cn.md", "CLAUDE.md", "CONTEXT.md", "CHANGELOG.md"];

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(path));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out.sort();
}

const DOCS = [...ROOT_DOCS.filter((path) => existsSync(path)), ...markdownFiles("docs")];

const failures = [];
for (const doc of DOCS) {
  const text = readFileSync(doc, "utf8");
  const link = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of text.matchAll(link)) {
    const raw = match[1];
    if (/^(https?:|mailto:|#)/.test(raw)) continue;
    const target = raw.split("#")[0];
    if (!target) continue;
    const resolved = resolve(dirname(doc), target);
    if (existsSync(resolved)) continue;
    failures.push(`${doc}: ${raw}`);
  }
}

if (failures.length > 0) {
  console.error("broken documentation links:");
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`documentation links ok (${DOCS.length} files checked)`);
