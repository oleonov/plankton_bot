import { main } from "../modules/exit-ownership/census/main.js";

// One line by design (§7): every branch-worthy decision — including "did the operator actually pass
// `--apply`?" — lives in `main(argv, io)` under `src`, where typecheck, lint and Vitest reach it.
process.exitCode = main(process.argv.slice(2));
