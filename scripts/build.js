const fs = require('fs-extra');
const path = require('path');

async function build() {
  const distDir = path.join(__dirname, '..', 'dist');
  await fs.ensureDir(distDir);

  const entry = `
// Auto-generated simple entrypoint.
require('../src/main');
`;
  await fs.writeFile(path.join(distDir, 'index.js'), entry.trimStart());
  console.log('Built dist/index.js');
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
