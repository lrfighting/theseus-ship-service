import { readdir, readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', 'dist');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath);
    } else if (entry.name.endsWith('.js')) {
      let content = await readFile(fullPath, 'utf-8');
      const original = content;
      // 给相对路径 import/export 添加 .js 扩展名（跳过已有扩展名的）
      content = content.replace(
        /from\s+(['"])(\.{1,2}\/[^'"]+?)\1/g,
        (_m, q, p) => {
          if (p.endsWith('.js') || p.endsWith('.json')) return _m;
          return `from ${q}${p}.js${q}`;
        }
      );
      if (content !== original) {
        await writeFile(fullPath, content);
        console.log('Fixed:', fullPath.replace(distDir + '/', ''));
      }
    }
  }
}

walk(distDir).catch(console.error);
