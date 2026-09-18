#!/usr/bin/env node
// 部署压缩（minify）安全性的自检。
//
// 本项目有三个模块把「写成本地函数再 toString() 注入浏览器」的前端脚本
// （cf-panel.js / stats-ui.js / config-ui.js）。这条写法本身没问题，但它和
// **部署压缩**有一处致命冲突：
//
//   旧写法是 `var CF_TREND_METRICS=${JSON}; (${cfInit.toString()})();`
//   —— 前半段的变量名是**硬编码的字符串字面量**，后半段函数体里引用的
//   CF_TREND_METRICS 是**模块级标识符**。不压缩时两者同名，一切正常；
//   一旦开了 minify，模块级标识符被重命名成单个字母，而字面量还是
//   `var CF_TREND_METRICS=` —— 名字对不上，注入到浏览器的脚本第一行就
//   ReferenceError，表现为「面板一直加载中、按钮全失灵」，而 Worker 侧
//   日志完全干净（因为错误发生在浏览器里）。
//
// 修法是把数据改成**实参**传入：`(${cfInit.toString()})(JSON1, JSON2)`。
// 函数体和调用处属于同一次压缩产出，命名必然同步，天然免疫重命名。
//
// 本文件就是这条纪律的牙齿：谁把 `var NAME=` 的写法加回来，这里必须变红。

import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
}

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.js'));

console.log('\n[1] 注入脚本一律用实参传数据，不许 var NAME= 硬编码全局名');

// 收集所有「模板串里出现 toString()」的注入点
const injections = [];
for (const f of files) {
  const src = readFileSync(join(SRC_DIR, f), 'utf8');
  const re = /\.toString\(\)\s*\}/g;          // `${xxx.toString()}` 的收尾处
  let m;
  while ((m = re.exec(src))) {
    // 往前后各取一段，覆盖同一条模板语句
    const ctx = src.slice(Math.max(0, m.index - 260), m.index + 260);
    if (ctx.includes('toString()')) injections.push({ file: f, ctx });
  }
}
check('找得到 toString() 注入点', injections.length > 0, injections.length + ' 处');

// 危险信号：同一条模板里既 var 了大写常量名、又用 toString() 注入。
// 判据收紧到 `var NAME=${...}`（旧写法就是 var 后面紧跟 JSON 插值），
// 这样注释里提到「var CF_TREND_METRICS=...」这种说明文字不会被误判。
const dangerous = injections.filter((i) => /var\s+[A-Z][A-Z0-9_]*\s*=\s*\$\{/.test(i.ctx));
check('注入点没有「var 大写名 =」的硬编码写法',
  dangerous.length === 0,
  dangerous.map((d) => d.file).join(', ') || '全部走实参');

// 正向：注入必须是「(函数)(... )」的立即调用形式，参数可以是零个或多个
const notIife = injections.filter((i) => !/\)\s*\(/.test(i.ctx));
check('注入都是立即调用形式 (fn)(...)',
  notIife.length === 0,
  notIife.map((d) => d.file).join(', ') || 'ok');

console.log('\n[2] 部署确实开启了压缩（否则上面的纪律形同虚设）');
{
  const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
  check('wrangler.toml 里 minify = true', /^\s*minify\s*=\s*true\s*$/m.test(toml));
}

console.log('\n[3] esbuild 可用时：真压缩一遍，确认注入脚本仍能被解析');
{
  // ESM 的 import('esbuild') 不认 NODE_PATH，所以先用 CJS 的 require 找一遍
  let esbuild = null;
  try { esbuild = createRequire(import.meta.url)('esbuild'); } catch { /* 继续试 ESM */ }
  if (!esbuild) { try { esbuild = await import('esbuild'); } catch { /* 本机没装就跳过 */ } }
  if (!esbuild) {
    console.log('  ⏭  未安装 esbuild，跳过（静态检查已在 [1] 覆盖）');
  } else {
    const targets = [
      ['cf-panel.js', 'CF_JS'],
      ['stats-ui.js', 'STATS_JS'],
      ['config-ui.js', 'CONFIG_JS'],
    ];
    for (const [file, key] of targets) {
      // 每个目标用独立的输出文件名：ESM 的 import() 按 URL 缓存，
      // 复用同一个路径的话第二次拿到的是第一次的模块，导出自然取不到。
      const outPath = join(SRC_DIR, '__min_probe_' + file.replace(/\W/g, '_'));
      try {
        await esbuild.build({
          entryPoints: [join(SRC_DIR, file)],
          outfile: outPath,
          format: 'esm',
          minify: true,
          logLevel: 'silent',
        });
        // Windows 下绝对路径不能直接喂给 import()，必须转成 file:// URL
        const mod = await import(pathToFileURL(outPath).href);
        const script = mod[key];
        if (typeof script !== 'string') {
          check(file + ' 压缩后仍导出 ' + key, false, '导出丢失');
          continue;
        }
        // 真正的判据：压缩产物里的这段字符串必须还是合法 JS
        let okSyntax = true;
        let why = '';
        try { new Function(script); } catch (e) { okSyntax = false; why = e.message; }
        check(file + ' 压缩后 ' + key + ' 语法正确', okSyntax, why || script.length + ' 字符');
      } catch (e) {
        check(file + ' 压缩后 ' + key, false, String(e && e.message).slice(0, 80));
      } finally {
        try { unlinkSync(outPath); } catch { /* 没生成就无所谓 */ }
      }
    }
  }
}

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
console.log(`部署压缩安全性：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
