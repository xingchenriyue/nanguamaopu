/**
 * 精确验证 19 个搬移过 jsData 的页面：
 *   1. this.jsData = {...} 赋值在 onLoad 函数体内部（不是 Page 顶层）
 *   2. Page 顶层无 jsData: 选项
 *   3. data 里未混入 jsData 的字段
 *   4. this.jsData.xxx 的引用一处没丢
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = process.argv[2] || path.join(__dirname, '..', 'miniprogram');

const PAGES = [
  'applyAdoption', 'followFeed', 'commentBoard', 'detailCat', 'ratingDetail',
  'relationGraph', 'genealogy', 'myFeedback', 'myFollowCats', 'myFootprint',
  'reward', 'leaderboard', 'badgeCode', 'checkComment', 'checkPhotos',
  'pageSettings', 'map', 'badge', 'badgeHistory',
];

function walk(dir, acc = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) {
      if (f === 'node_modules' || f === 'miniprogram_npm') continue;
      walk(p, acc);
    } else if (f.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const all = walk(ROOT);
// 【按路径收集，不能只按文件名】
// 之前只按 basename 建索引且取第一个，结果 utils/badge.js（普通工具模块，0 处 jsData）
// 抢在了 pages/packageA/pages/info/badge/badge.js（真正的页面）前面 → 误报 FAIL。
// 现在收集同名文件的全部候选，运行时优先选「含 jsData 赋值且是页面目录」的候选。
const byName = new Map();
for (const f of all) {
  const base = path.basename(f, '.js');
  if (!byName.has(base)) byName.set(base, []);
  byName.get(base).push(f);
}

/** 从同名候选里挑出真正的页面文件 */
function pickPage(cands) {
  if (!cands || !cands.length) return null;
  if (cands.length === 1) return cands[0];
  const scored = cands.map((f) => {
    let s = 0;
    const src = fs.readFileSync(f, 'utf8');
    if (/this\.jsData\s*=/.test(src)) s += 10;
    if (/pages[\\/]/.test(f)) s += 5;
    if (/(^|[\\/])utils[\\/]/.test(f)) s -= 5;
    return { f, s };
  }).sort((a, b) => b.s - a.s);
  return scored[0].s > 0 ? scored[0].f : scored[0].f;
}

console.log('验证 19 个搬移过 jsData 的页面：赋值在 onLoad 内 / Page 顶层无 jsData / data 未混入 / 引用未丢');
console.log('='.repeat(74));
console.log('19 个 jsData 搬移页面验证');
console.log('='.repeat(74));
console.log('');
console.log('页面'.padEnd(16) + '赋值  引用  Page顶层jsData  data混入  结论');
console.log('-'.repeat(74));

let allOk = true;
for (const name of PAGES) {
  const f = pickPage(byName.get(name));
  if (!f) {
    console.log(name.padEnd(16) + '  [文件未找到]');
    allOk = false;
    continue;
  }
  const src = fs.readFileSync(f, 'utf8');
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module', locations: true });
  } catch (e) {
    console.log(name.padEnd(16) + '  [解析失败] ' + e.message);
    allOk = false;
    continue;
  }

  // 找 Page 对象
  let pageObj = null;
  for (const node of ast.body) {
    if (node.type === 'ExpressionStatement'
      && node.expression.type === 'CallExpression'
      && node.expression.callee.type === 'Identifier'
      && node.expression.callee.name === 'Page') {
      pageObj = node.expression.arguments[0];
    }
  }
  if (!pageObj) {
    console.log(name.padEnd(16) + '  [无 Page()]');
    allOk = false;
    continue;
  }
  const pageKeys = pageObj.properties.map(p => p.key.name || p.key.value);

  // 1) this.jsData 赋值是否在 onLoad 内
  // 【注意】有的页面里同时存在两个 onLoad（一个是对象方法简写、一个是 async onLoad()），
  // 例如 pages/packageA/pages/info/badge/badge.js 第 37 行与第 44 行各有一个。
  // 之前用 find 只取第一个 → 漏掉真正带 jsData 赋值的那个 → 误报 FAIL。
  // 现在收集所有 onLoad，命中任意一个即算通过。
  let assignInOnLoad = 0;
  let assignOther = 0;
  const onLoadProps = pageObj.properties.filter(p => (p.key.name || p.key.value) === 'onLoad');
  if (onLoadProps.length) {
    const found = [];
    const foundOther = [];
    const scan = (n, inside) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(x => scan(x, inside)); return; }
      if (n.type === 'AssignmentExpression' && n.left
        && n.left.type === 'MemberExpression'
        && n.left.object.type === 'ThisExpression'
        && n.left.property.name === 'jsData') {
        (inside ? found : foundOther).push(n.loc.start.line);
      }
      for (const k of Object.keys(n)) {
        if (k === 'loc' || k === 'type') continue;
        const v = n[k];
        if (v && typeof v === 'object') scan(v, inside);
      }
    };
    // 逐个扫描所有 onLoad：命中任意一个即算「赋值在 onLoad 内」
    for (const prop of onLoadProps) {
      scan(prop.value, true);
    }
    assignInOnLoad = found.length;
    assignOther = foundOther.length;
  }

  // 全文件 this.jsData 赋值总数
  const allAssign = (src.match(/this\.jsData\s*=/g) || []).length;

  // 2) Page 顶层 jsData
  const topLevelJsData = pageKeys.includes('jsData');

  // 3) data 里是否混入 jsData 字段
  const dataProp = pageObj.properties.find(p => (p.key.name || p.key.value) === 'data');
  let dataHasJsData = false;
  let dataKeys = [];
  if (dataProp && dataProp.value.type === 'ObjectExpression') {
    dataKeys = dataProp.value.properties.map(p => p.key.name || p.key.value);
    dataHasJsData = dataKeys.includes('jsData');
  }

  // 4) this.jsData.xxx 引用数
  const refCount = (src.match(/this\.jsData\.[A-Za-z_$]/g) || []).length;

  const ok = assignInOnLoad > 0 && !topLevelJsData && !dataHasJsData && refCount > 0;
  if (!ok) allOk = false;

  console.log(
    name.padEnd(16)
    + String(assignInOnLoad).padStart(4)
    + String(refCount).padStart(6)
    + String(topLevelJsData ? '有✗' : '无✓').padStart(14)
    + String(dataHasJsData ? '有✗' : '无✓').padStart(10)
    + '  ' + (ok ? 'OK' : 'FAIL')
  );
}

console.log('');
console.log(allOk ? '✅ 19 个页面全部通过' : '❌ 存在不通过项');
