import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const roots = ['src', 'tests'];
const violations = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
      const lines = (await readFile(path, 'utf8')).split(/\r?\n/).length;
      if (lines > 200) violations.push(`${path}: ${lines} lines`);
    }
  }
}

for (const root of roots) await walk(root);
if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log('Line-count check passed');
