'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const extBase = path.join(process.env.HOME, '.antigravity', 'extensions');

if (!fs.existsSync(extBase)) {
  console.error(`Extensions base directory not found: ${extBase}`);
  process.exit(1);
}

// Find candidates
const dirs = fs.readdirSync(extBase);
const candidates = dirs.filter(d => d.includes('ag-local-bridge') || d.includes('antigravity-bridge')).map(d => path.join(extBase, d));

if (candidates.length === 0) {
  console.error(`No bridge extensions found in ${extBase}`);
  process.exit(1);
}

console.log(`=== AG Local Bridge Dev Deploy (macOS) ===`);
console.log(`Source: ${path.join(repoRoot, 'src')}`);
console.log(`Found ${candidates.length} extension dir(s):`);
candidates.forEach(c => console.log(`  → ${c}`));
console.log('');

// 1. Syntax check all JS files in src
console.log('[1/4] Syntax checking...');
function recList(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(recList(fullPath));
    } else if (file.endsWith('.js')) {
      results.push(fullPath);
    }
  });
  return results;
}

const jsFiles = recList(path.join(repoRoot, 'src'));
jsFiles.forEach(f => {
  try {
    execSync(`node -c "${f}"`);
  } catch (err) {
    console.error(`Syntax error in ${f}:`, err.message);
    process.exit(1);
  }
});
console.log(`  ✅ All ${jsFiles.length} files pass syntax check`);

// Deploy to EACH extension directory
candidates.forEach(dest => {
  console.log(`\n--- Deploying to: ${dest} ---`);

  // 2. Backup old extension.js if it exists
  const oldExt = path.join(dest, 'extension.js');
  if (fs.existsSync(oldExt)) {
    console.log('[2/4] Backing up monolithic extension.js → extension.js.bak');
    try {
      fs.renameSync(oldExt, path.join(dest, 'extension.js.bak'));
      console.log('  ✅ Backed up');
    } catch (e) {
      console.log('  ⚠️ Backup failed:', e.message);
    }
  } else {
    console.log('[2/4] No monolithic extension.js to backup');
  }

  // 3. Copy src/ and package.json
  console.log('[3/4] Deploying src/ and package.json...');
  const destSrc = path.join(dest, 'src');
  if (fs.existsSync(destSrc)) {
    fs.rmSync(destSrc, { recursive: true, force: true });
  }
  fs.cpSync(path.join(repoRoot, 'src'), destSrc, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(dest, 'package.json'));

  const deployedCount = recList(destSrc).length;
  console.log(`  ✅ Deployed ${deployedCount} files`);

  // 4. Verify critical files
  console.log('[4/4] Verifying deployment...');
  const checks = [
    path.join(dest, 'src', 'extension.js'),
    path.join(dest, 'src', 'sidecar', 'raw.js'),
    path.join(dest, 'src', 'sidecar', 'rpc.js'),
    path.join(dest, 'src', 'handlers', 'openai.js')
  ];

  checks.forEach(c => {
    if (fs.existsSync(c)) {
      console.log(`  ✅ ${path.relative(dest, c)} exists`);
    } else {
      console.log(`  ❌ MISSING: ${path.relative(dest, c)}`);
    }
  });

  const pkgContent = fs.readFileSync(path.join(dest, 'package.json'), 'utf8');
  if (/"main"\s*:\s*"\.\/src\/extension\.js"/.test(pkgContent)) {
    console.log('  ✅ package.json main → ./src/extension.js');
  } else {
    console.log('  ❌ package.json main is NOT ./src/extension.js');
  }
});

console.log(`\n🎉 Deploy complete! Reload Antigravity window to apply.`);
console.log(`   Ctrl+Shift+P → 'Developer: Reload Window'`);
