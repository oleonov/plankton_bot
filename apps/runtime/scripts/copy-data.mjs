#!/usr/bin/env node
// Post-tsc step (audit doc §D2 / §G10). `tsc -b` only compiles `.ts` files;
// the soft-ranking model artifact (and any future static assets in
// `apps/runtime/src/data/`) need to be copied to `dist/data/` so
// `node dist/index.js` can resolve them at runtime via import.meta.url.

import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "..", "src", "data");
const distRoot = path.resolve(here, "..", "dist", "data");

// Always start from a clean dist/data so removing an artifact from src/data
// (e.g. rolling back the soft-ranking model) actually disappears from the
// build output. Without this, a stale dist/data file would keep loading
// silently and defeat the disabled-no-op contract (audit doc §F1 / §F14).
if (existsSync(distRoot)) {
  rmSync(distRoot, { recursive: true, force: true });
}

if (!existsSync(srcRoot)) {
  // No data dir = nothing to copy. Soft-ranking-only build path is fine without it.
  process.exit(0);
}

mkdirSync(distRoot, { recursive: true });

function copyTree(srcDir, dstDir) {
  for (const entry of readdirSync(srcDir)) {
    const src = path.join(srcDir, entry);
    const dst = path.join(dstDir, entry);
    const st = statSync(src);
    if (st.isDirectory()) {
      mkdirSync(dst, { recursive: true });
      copyTree(src, dst);
    } else if (st.isFile()) {
      copyFileSync(src, dst);
    }
  }
}

copyTree(srcRoot, distRoot);
