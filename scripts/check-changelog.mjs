#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const CHANGELOG_PATH = "CHANGELOG.md";
const args = new Set(process.argv.slice(2));
const checkWorkingTree = args.has("--working-tree");

function git(gitArgs) {
  return execFileSync("git", gitArgs, { encoding: "utf8" });
}

function fail(message) {
  console.error(`changelog check failed: ${message}`);
  console.error("");
  console.error("Add and stage a CHANGELOG.md entry like:");
  console.error("");
  console.error("## [pending] - YYYY-MM-DD");
  console.error("Commit: pending");
  console.error("- Describe what changed and any deploy-relevant verification.");
  process.exit(1);
}

function addedChangelogEntry(diff) {
  const addedLines = diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1).trim());

  return addedLines.some(
    (line) =>
      /^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}$/.test(line) ||
      /^(Commit|Version\/Commit):\s*\S+/i.test(line) ||
      /^- \S+/.test(line),
  );
}

function newestEntry(content) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}$/.test(line));

  if (start === -1) {
    return null;
  }

  const endOffset = lines.slice(start + 1).findIndex((line) => line.startsWith("## "));
  const end = endOffset === -1 ? lines.length : start + 1 + endOffset;

  return {
    heading: lines[start],
    body: lines.slice(start + 1, end),
  };
}

function validateNewestEntry(content) {
  const entry = newestEntry(content);

  if (!entry) {
    fail("CHANGELOG.md has no dated section header like `## [pending] - YYYY-MM-DD`.");
  }

  const commitLine = entry.body.find((line) => /^(Commit|Version\/Commit):\s*\S+/i.test(line));
  if (!commitLine) {
    fail("newest CHANGELOG.md section must include `Commit: pending` or a commit/version.");
  }

  const descriptiveBullet = entry.body
    .filter((line) => /^- \S+/.test(line))
    .some((line) => {
      const text = line.replace(/^- /, "").trim();
      return text.length >= 12 && !/^(tbd|todo|pending)$/i.test(text);
    });

  if (!descriptiveBullet) {
    fail("newest CHANGELOG.md section must include at least one descriptive bullet.");
  }
}

function stagedChangelogContent() {
  const staged = git([
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMR",
    "--",
    CHANGELOG_PATH,
  ])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

  if (!staged.includes(CHANGELOG_PATH)) {
    fail("CHANGELOG.md is not staged for this commit.");
  }

  const diff = git(["diff", "--cached", "--unified=0", "--", CHANGELOG_PATH]);
  if (!addedChangelogEntry(diff)) {
    fail("staged CHANGELOG.md diff does not add a version/commit line or change summary.");
  }

  try {
    return git(["show", `:${CHANGELOG_PATH}`]);
  } catch {
    fail("staged CHANGELOG.md content could not be read.");
  }
}

function workingTreeChangelogContent() {
  const path = resolve(process.cwd(), CHANGELOG_PATH);
  if (!existsSync(path)) {
    fail("CHANGELOG.md does not exist.");
  }

  return readFileSync(path, "utf8");
}

try {
  process.chdir(git(["rev-parse", "--show-toplevel"]).trim());
} catch {
  fail("not inside a git repository.");
}

const content = checkWorkingTree ? workingTreeChangelogContent() : stagedChangelogContent();
validateNewestEntry(content);

const source = checkWorkingTree ? "working tree" : "staged";
console.log(`changelog check passed (${source})`);
