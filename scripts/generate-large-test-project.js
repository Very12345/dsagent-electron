'use strict';

const fs = require('fs');
const path = require('path');

const target = path.resolve(process.argv[2] || 'D:\\Code\\Project\\WebAgentLargeTest');
if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error('Refusing to overwrite a non-empty target: ' + target);
fs.mkdirSync(target, { recursive: true });

function write(relative, content) {
  const file = path.join(target, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

const packages = ['kernel', 'protocol', 'storage', 'search', 'memory', 'scheduler', 'gateway', 'renderer', 'cli', 'analytics', 'testing', 'workflows'];
write('.webagent-large-test', JSON.stringify({ version: 1, generated_at: new Date().toISOString(), packages: packages.length }, null, 2));
write('package.json', JSON.stringify({
  name: 'webagent-large-test', private: true, version: '1.0.0',
  scripts: { typecheck: 'tsc -p tsconfig.json --noEmit', test: 'node scripts/smoke.js' },
  workspaces: ['packages/*']
}, null, 2) + '\n');
write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'CommonJS', strict: true, skipLibCheck: true, noEmit: true }, include: ['packages/**/*.ts'] }, null, 2) + '\n');
write('README.md', '# WebAgent Large Test\n\nSynthetic multi-package TypeScript workspace for context rollover, search, patch, command, test, and agent routing acceptance.\n');
write('scripts/smoke.js', `'use strict';\nconst fs=require('fs'),path=require('path');\nconst root=path.resolve(__dirname,'..','packages');\nconst packages=fs.readdirSync(root);\nconst modules=packages.reduce((n,p)=>n+fs.readdirSync(path.join(root,p,'src')).filter(f=>f.endsWith('.ts')).length,0);\nif(packages.length!==12||modules<2000)throw new Error('fixture incomplete');\nconsole.log(JSON.stringify({packages:packages.length,modules,ok:true}));\n`);

for (let packageIndex = 0; packageIndex < packages.length; packageIndex += 1) {
  const name = packages[packageIndex];
  const base = `packages/${name}`;
  write(`${base}/package.json`, JSON.stringify({ name: `@wa-test/${name}`, version: '1.0.0', main: 'src/index.ts', private: true }, null, 2) + '\n');
  write(`${base}/README.md`, `# ${name}\n\nPackage ${packageIndex + 1} in the WebAgent acceptance workspace. Owns deterministic domain transformations.\n`);
  const exports = [];
  for (let moduleIndex = 0; moduleIndex < 170; moduleIndex += 1) {
    const id = String(moduleIndex).padStart(3, '0');
    const previous = moduleIndex ? `import { value${moduleIndex - 1} } from './module-${String(moduleIndex - 1).padStart(3, '0')}';\n` : '';
    const expression = moduleIndex ? `value${moduleIndex - 1} + ${packageIndex + moduleIndex + 1}` : String(packageIndex + 1);
    write(`${base}/src/module-${id}.ts`, `${previous}export const value${moduleIndex}: number = ${expression};\nexport function transform${moduleIndex}(input: string): string { return \`${name}:${id}:\${input.trim()}\`; }\n`);
    if (moduleIndex % 17 === 0) exports.push(`export { value${moduleIndex}, transform${moduleIndex} } from './module-${id}';`);
  }
  write(`${base}/src/index.ts`, exports.join('\n') + '\n');
  for (let testIndex = 0; testIndex < 30; testIndex += 1) {
    const moduleIndex = (testIndex * 5) % 170;
    write(`${base}/test/case-${String(testIndex).padStart(2, '0')}.test.ts`, `import { transform${moduleIndex} } from '../src/module-${String(moduleIndex).padStart(3, '0')}';\nexport const case${testIndex} = transform${moduleIndex}('fixture') === '${name}:${String(moduleIndex).padStart(3, '0')}:fixture';\n`);
  }
  for (let docIndex = 0; docIndex < 10; docIndex += 1) write(`${base}/docs/topic-${String(docIndex).padStart(2, '0')}.md`, `# ${name} topic ${docIndex}\n\nDecision: keep package ownership explicit and event routing keyed by session, run, call, and lease identifiers.\n`);
}

console.log(JSON.stringify({ target, files: packages.length * (170 + 30 + 10 + 3) + 5, packages: packages.length }, null, 2));
