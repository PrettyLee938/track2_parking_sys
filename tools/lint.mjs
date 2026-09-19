import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const roots = ["server/src", "server/test", "shared/src", "web/src"];
const extensions = new Set([".ts", ".tsx", ".css"]);
const errors = [];

function visit(relative) {
  const absolute = path.join(root, relative);
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) visit(child);
    else if (extensions.has(path.extname(entry.name))) check(child);
  }
}

function check(relative) {
  const lines = readFileSync(path.join(root, relative), "utf8").split(/\r?\n/);
  if (lines.length > 200) errors.push(`${relative}: ${lines.length} lines (maximum 200)`);
  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) errors.push(`${relative}:${index + 1}: trailing whitespace`);
    if (line.includes("`r`n")) errors.push(`${relative}:${index + 1}: literal shell newline marker`);
  });
}

for (const relative of roots) visit(relative);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`lint ok: checked ${roots.join(", ")}`);
}
