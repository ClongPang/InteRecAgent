import { existsSync, realpathSync, rmSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

const workspace = realpathSync(process.cwd());
const relativeTargets = [
  "packages/domain/dist",
  "packages/agent/dist",
  "packages/runtime/dist",
  "packages/api/dist",
  "frontend/dist",
];

for (const relativeTarget of relativeTargets) {
  const target = resolve(workspace, relativeTarget);
  const fromWorkspace = relative(workspace, target);
  const isInsideWorkspace = fromWorkspace !== "" && fromWorkspace !== ".."
    && !fromWorkspace.startsWith(`..${sep}`)
    && !fromWorkspace.startsWith(sep);
  if (!isInsideWorkspace || basename(target) !== "dist") {
    throw new Error(`REFUSING_UNSAFE_BUILD_CLEAN:${target}`);
  }
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}

console.log(`clean build outputs: ${relativeTargets.length} verified dist directories`);
