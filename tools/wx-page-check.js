#!/usr/bin/env node
/**
 * 微信小程序 Page 结构静态检查（AST 版）
 *
 * 【为什么需要这个脚本】
 *   node --check 只保证「语法可解析」，而微信开发者工具用的是 Babel 编译 + 运行时校验，
 *   两者对 Page() 参数结构的判定不同。真实故障案例（2026-11-09）：
 *
 *     //不需要渲染到wxml的数据存储在jsData中  data: {
 *
 *   这行 // 注释把 `data: {` 一起吞掉了 → Page({ 在下一页提前闭合 →
 *   onShow/onLoad 等方法落到 Page(...) 之外变成顶层标签语句。
 *   node 能解析（标签语句是合法 JS），但 Babel 报错：
 *     Unexpected token, expected "," (44:8)
 *     module 'pages/leaderboard/leaderboard.js' is not defined
 *   整个排行榜页面崩溃。
 *
 * 【检查项】
 *   1. Page() 第一个参数必须是 ObjectExpression
 *   2. 该对象必须有 data 属性（否则微信报 data 缺失）
 *   3. Page 顶层不得残留 jsData 选项（微信报 Free data 告警）
 *   4. Page() 之后不得出现游离的顶层标签语句 / 函数声明（Page 提前闭合的征兆）
 *
 * 【用法】
 *   node tools/wx-page-check.js                 # 默认扫 miniprogram/
 *   node tools/wx-page-check.js <目录>          # 指定目录
 *
 * 【依赖】
 *   npm i acorn --save-dev   （或 npx --yes acorn）
 *   若本机没有 acorn，脚本会提示并以退出码 2 结束。
 */
const fs = require('fs');
const path = require('path');

let acorn;
try {
  acorn = require('acorn');
} catch (e) {
  console.error('缺少依赖 acorn。请执行： npm i acorn --save-dev');
  process.exit(2);
}

const ROOT = process.argv[2] || path.join(__dirname, '..', 'miniprogram');
const LIFECYCLE = new Set([
  'onLoad', 'onShow', 'onReady', 'onHide', 'onUnload',
  'onPullDownRefresh', 'onReachBottom', 'onPageScroll', 'onShareAppMessage',
  'onShareTimeline', 'onResize', 'onTabItemTap', 'onAddToFavorites',
]);

function walk(dir, acc = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) {
      if (f === 'node_modules' || f === 'miniprogram_npm' || f === 'packages') continue;
      walk(p, acc);
    } else if (f.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const files = walk(ROOT);
const problems = [];
let pageCount = 0;
let parsed = 0;

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  let ast;
  try {
    ast = acorn.parse(src, {
      ecmaVersion: 2022,
      sourceType: 'module',
      locations: true,
      allowReturnOutsideFunction: true,
    });
    parsed++;
  } catch (e) {
    problems.push({ rel, line: 0, msg: '★ 语法解析失败: ' + e.message, fatal: true });
    continue;
  }

  const pageCalls = [];
  for (const node of ast.body) {
    if (node.type === 'ExpressionStatement'
      && node.expression.type === 'CallExpression'
      && node.expression.callee.type === 'Identifier'
      && node.expression.callee.name === 'Page') {
      pageCalls.push(node.expression);
    }
  }

  for (const call of pageCalls) {
    pageCount++;
    const arg = call.arguments[0];
    if (!arg || arg.type !== 'ObjectExpression') {
      problems.push({
        rel, line: call.loc.start.line,
        msg: '★ Page() 第一个参数不是对象字面量（实际: ' + (arg ? arg.type : 'undefined') + '）',
        fatal: true,
      });
      continue;
    }
    const keys = arg.properties.map(p => (p.key && (p.key.name || p.key.value)) || '?');
    if (!keys.includes('data')) {
      problems.push({
        rel, line: call.loc.start.line,
        msg: '★ Page 对象缺少 data 属性（实际 keys: ' + keys.join(',') + '）',
        fatal: true,
      });
    }
    if (keys.includes('jsData')) {
      problems.push({
        rel, line: call.loc.start.line,
        msg: '⚠ Page 顶层残留 jsData 选项（微信会报 Free data 告警）',
        fatal: false,
      });
    }
    // 提示性：页面若声明了生命周期但不完整，容易出现「方法写错层级」
    const declared = [...LIFECYCLE].filter(k => keys.includes(k));
    if (declared.length === 0 && keys.length > 0) {
      problems.push({
        rel, line: call.loc.start.line,
        msg: '⚠ Page 对象没有任何生命周期方法（可能方法写到了 Page 之外）',
        fatal: false,
      });
    }
  }

  // Page() 之后的顶层游离语句 —— Page 提前闭合的征兆
  if (pageCalls.length > 0) {
    const lastPageEnd = Math.max(...pageCalls.map(c => c.loc.end.line));
    for (const node of ast.body) {
      if (node.loc.start.line <= lastPageEnd) continue;
      if (node.type === 'LabeledStatement') {
        problems.push({
          rel, line: node.loc.start.line,
          msg: '★ Page() 之后出现顶层游离标签语句 "' + node.label.name + '"（Page 对象疑似提前闭合）',
          fatal: true,
        });
      }
      if (node.type === 'FunctionDeclaration' && node.id) {
        problems.push({
          rel, line: node.loc.start.line,
          msg: '★ Page() 之后出现顶层游离函数 ' + node.id.name + '（Page 对象疑似提前闭合）',
          fatal: true,
        });
      }
    }
  }
}

console.log('扫描目录 :', ROOT);
console.log('js 文件  :', files.length, '| 解析成功:', parsed, '| Page() 调用:', pageCount);
console.log('');
if (problems.length === 0) {
  console.log('✅ 全部通过：每个 Page() 均为对象字面量、含 data 属性、无游离顶层语句');
} else {
  const fatal = problems.filter(p => p.fatal);
  console.log('❌ ' + problems.length + ' 个问题（致命 ' + fatal.length + ' / 提示 '
    + (problems.length - fatal.length) + '）：');
  for (const p of problems) {
    console.log('  ' + (p.fatal ? '[致命] ' : '[提示] ') + p.rel + ':' + p.line + ' → ' + p.msg);
  }
}
process.exit(problems.some(p => p.fatal) ? 1 : 0);
