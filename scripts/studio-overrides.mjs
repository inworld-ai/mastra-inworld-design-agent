// `mastra build` installs .mastra/output from a generated package.json that
// drops the root `overrides`, so the Studio child (src/admin.ts) would run the
// versions they exist to replace. Copy them in and reinstall.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const output = new URL(".mastra/output/", root);
const outputPkg = new URL("package.json", output);

const { overrides } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
if (overrides && Object.keys(overrides).length > 0) {
  const pkg = JSON.parse(readFileSync(outputPkg, "utf8"));
  pkg.overrides = overrides;
  writeFileSync(outputPkg, `${JSON.stringify(pkg, null, 2)}\n`);
  execFileSync("npm", ["install", "--loglevel=error"], {
    cwd: output,
    stdio: "inherit",
  });
}
