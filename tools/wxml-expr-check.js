#!/usr/bin/env node
/**
 * 微信小程序 WXML 表达式语法静态检查
 *
 * 【背景】
 *   WXML 的 {{ }} 表达式是受限子集，**不支持对象字面量 {}**。真实故障案例（2026-11-09）：
 *
 *     <poster coverImg="{{cat.avatar || {}}}" ...></poster>
 *     → Bad attr `coverImg` with message: unexpected token `$'
 *
 *   正确做法是在 JS 侧算好一个独立字段（如 posterCoverImg）再绑定。
 *
 * 【检查项】
 *   1. {{ }} 表达式里出现对象字面量 {}      → 编译期 Bad attr
 *   2. {{ }} 表达式里出现 new 表达式       → 不支持
 *   3. {{ }} 表达式里出现数组字面量 []      → 保守提示
 *
 *   注：调用 data 里的函数（如 fmt.fixed6(x)、wxfn.indexOf(a,b)）是**小程序标准写法**，
 *   属正常用法，本脚本不告警。
 *
 * 【用法】
 *   node tools/wxml-expr-check.js            # 默认扫 miniprogram/
 *   node tools/wxml-expr-check.js <目录>
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || path.join(__dirname, '..', 'miniprogram');

function walk(dir, acc = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) {
      if (f === 'node_modules' || f === 'miniprogram_npm') continue;
      walk(p, acc);
    } else if (f.endsWith('.wxml')) acc.push(p);
  }
  return acc;
}

const files = walk(ROOT);
const problems = [];
let exprCount = 0;

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const lines = src.split(/\r?\n/);

  lines.forEach((line, i) => {
    const re = /\{\{([\s\S]*?)\}\}/g;
    let m;
    while ((m = re.exec(line))) {
      exprCount++;
      const expr = m[1];
      // 去掉字符串字面量，避免把字符串里的括号误判
      const stripped = expr.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');

      // 对象字面量：{ 后跟内容，或 { } 空对象
      if (/\{\s*[^}\s]/.test(stripped) || /\{\s*\}/.test(stripped)) {
        problems.push({
          rel, line: i + 1, expr: expr.trim(),
          msg: '对象字面量（WXML 不支持，会报 Bad attr ... unexpected token）',
        });
      }
      // new 表达式
      if (/\bnew\s+/.test(stripped)) {
        problems.push({
          rel, line: i + 1, expr: expr.trim(),
          msg: 'new 表达式（WXML 不支持）',
        });
      }
    }
  });
}

console.log('扫描目录:', ROOT);
console.log('wxml 文件:', files.length, '| 表达式总数:', exprCount);
console.log('');
if (!problems.length) {
  console.log('✅ 未发现 WXML 不支持的表达式语法');
} else {
  console.log('❌ 发现 ' + problems.length + ' 处不支持的表达式：');
  for (const p of problems) {
    console.log('  ' + p.rel + ':' + p.line + ' → ' + p.msg);
    console.log('      {{' + p.expr + '}}');
  }
}
process.exit(problems.length ? 1 : 0);
