// asar selective extractor: list files, extract matching ones
const fs = require('fs');
const path = require('path');
const ASAR = process.env.WB_ASAR
  || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'resources', 'app.asar');
const OUT = process.env.WB_ASAR_OUT || path.join(__dirname, '_asar_main');

function readHeader() {
  const fd = fs.openSync(ASAR, 'r');
  const first = Buffer.alloc(16);
  fs.readSync(fd, first, 0, 16, 0);
  const headerPickleSize = first.readUInt32LE(4); // size of header pickle (from offset 8)
  const headerBuf = Buffer.alloc(headerPickleSize);
  fs.readSync(fd, headerBuf, 0, headerPickleSize, 8);
  const jsonLen = headerBuf.readUInt32LE(4);
  const json = headerBuf.slice(8, 8 + jsonLen).toString('utf8');
  const dataOffset = 8 + headerPickleSize;
  return { fd, header: JSON.parse(json), dataOffset };
}

const { fd, header, dataOffset } = readHeader();

function walk(node, prefix, out) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      walk(child, prefix + '/' + name, out);
    }
  } else {
    out.push({ path: prefix, size: node.size, offset: node.offset, unpacked: !!node.unpacked });
  }
}

const files = [];
walk(header, '', files);

const mode = process.argv[2] || 'list';
if (mode === 'list') {
  // top-level summary
  const top = {};
  for (const f of files) {
    const t = f.path.split('/')[1] || '/';
    top[t] = (top[t] || 0) + 1;
  }
  console.log('TOP LEVEL:', JSON.stringify(top, null, 1));
  // js files under 8 levels, excluding node_modules, sorted by size desc, top 40
  const js = files.filter(f => f.path.endsWith('.js') && !/node_modules/.test(f.path)).sort((a, b) => b.size - a.size).slice(0, 40);
  console.log('LARGEST JS (non-node_modules):');
  for (const f of js) console.log(' ', f.size, f.path);
} else if (mode === 'grep') {
  const pattern = process.argv[3];
  const re = new RegExp(pattern);
  let n = 0;
  for (const f of files) {
    if (f.unpacked) continue;
    if (!/\.(js|html|json|ts|css)$/.test(f.path)) continue;
    const buf = Buffer.alloc(f.size);
    fs.readSync(fd, buf, 0, f.size, dataOffset + Number(f.offset));
    const text = buf.toString('utf8');
    let idx = text.search(re);
    if (idx === -1) continue;
    n++;
    console.log('=== HIT', f.path, f.size);
    console.log(text.slice(Math.max(0, idx - 400), idx + 600).replace(/\t/g, '  '));
    if (n > 25) { console.log('... truncated'); break; }
  }
  console.log('files hit:', n);
} else if (mode === 'extract') {
  const patterns = process.argv.slice(3);
  let n = 0;
  for (const f of files) {
    if (!patterns.some(p => f.path.includes(p))) continue;
    if (f.unpacked) continue; // lives in app.asar.unpacked
    const dest = OUT + f.path;
    fs.mkdirSync(dest.slice(0, dest.lastIndexOf('/')), { recursive: true });
    const buf = Buffer.alloc(f.size);
    fs.readSync(fd, buf, 0, f.size, dataOffset + Number(f.offset));
    fs.writeFileSync(dest, buf);
    n++;
    console.log('extracted', f.path, f.size);
  }
  console.log('total', n);
}
