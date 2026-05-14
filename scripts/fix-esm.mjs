import { readdir, readFile, writeFile, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', 'dist');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath);
    } else if (entry.name.endsWith('.js')) {
      let content = await readFile(fullPath, 'utf-8');
      const original = content;

      const regex = /from\s+(['"])(\.\.?\/[^'"]+?)\1/g;
      let match;
      while ((match = regex.exec(original)) !== null) {
        const q = match[1];
        const importPath = match[2];
        if (importPath.endsWith('.js') || importPath.endsWith('.json')) continue;

        const baseDir = dirname(fullPath);
        const resolved = join(baseDir, importPath);

        let replacement;
        if (await exists(resolved + '.js')) {
          replacement = `from ${q}${importPath}.js${q}`;
        } else if (await exists(join(resolved, 'index.js'))) {
          replacement = `from ${q}${importPath}/index.js${q}`;
        } else {
          console.warn('Cannot resolve:', fullPath.replace(distDir + '/', ''), '->', importPath);
          continue;
        }

        content = content.replace(match[0], replacement);
      }

      if (content !== original) {
        await writeFile(fullPath, content);
        console.log('Fixed:', fullPath.replace(distDir + '/', ''));
      }
    }
  }
}

walk(distDir).catch(console.error);
