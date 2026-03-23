import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    ".": {
      entry: [],
      ignoreDependencies: ["pino-pretty"],
      ignoreBinaries: ["gitleaks"],
    },
    "packages/*": {
      entry: ["src/index.ts"],
    },
    "apps/runtime": {
      entry: ["src/index.ts"],
    },
    "apps/api": {
      entry: ["src/index.ts"],
    },
    "apps/web": {
      entry: ["src/main.tsx"],
    },
  },
};

export default config;
