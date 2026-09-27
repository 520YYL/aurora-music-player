'use strict';
/**
 * Aurora 极光音乐 —— 免安装 Windows 打包脚本
 *
 * 不依赖 electron-builder 的二进制组件，直接把 Electron 运行时 + 应用代码 + 运行时依赖
 * 组装成一个自包含目录，并生成桌面快捷方式。
 *
 * 用法： node tools/package-portable.js [输出目录]
 * 默认输出： %USERPROFILE%\AuroraPlayer
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(os.homedir(), 'AuroraPlayer'));
const APP_NAME = 'AuroraPlayer';
const EXE = APP_NAME + '.exe';

const log = (...a) => console.log('[pack]', ...a);

/* ------------------------------ 工具函数 ------------------------------ */
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function copyFile(src, dst) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function copyTree(src, dst, opts = {}) {
  const { skip = () => false, skipDirs = () => false } = opts;
  let files = 0;
  let bytes = 0;
  const stack = [[src, dst]];
  while (stack.length) {
    const [s, d] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(s, { withFileTypes: true }); } catch { continue; }
    ensureDir(d);
    for (const e of entries) {
      const sp = path.join(s, e.name);
      const dp = path.join(d, e.name);
      if (e.isDirectory()) {
        if (skipDirs(sp, e.name)) continue;
        stack.push([sp, dp]);
      } else if (e.isFile()) {
        if (skip(sp, e.name)) continue;
        try {
          copyFile(sp, dp);
          files++;
          bytes += fs.statSync(sp).size;
        } catch { /* ignore */ }
      }
    }
  }
  return { files, bytes };
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }

const SKIP_FILE = /\.(md|markdown|map|d\.ts|flow|ts)$|^(LICENSE|CHANGELOG|AUTHORS|NOTICE|\.npmignore|\.eslintrc.*|\.editorconfig|tsconfig\.json)$/i;

/* --------------------- 1. 解析生产依赖闭包（含嵌套） --------------------- */
function resolveDependencyClosure(rootPkg) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const direct = Object.keys(pkg.dependencies || {});
  const found = new Map();      // name -> 源目录
  const queue = direct.map((name) => ({ name, from: ROOT }));

  while (queue.length) {
    const { name, from } = queue.shift();
    if (found.has(name)) continue;
    let pkgJson;
    try {
      pkgJson = require.resolve(`${name}/package.json`, { paths: [from] });
    } catch {
      try { pkgJson = require.resolve(name, { paths: [from] }); } catch { continue; }
      let dir = path.dirname(pkgJson);
      while (!fs.existsSync(path.join(dir, 'package.json')) && dir !== path.dirname(dir)) dir = path.dirname(dir);
      pkgJson = path.join(dir, 'package.json');
    }
    const dir = path.dirname(pkgJson);
    found.set(name, dir);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(pkgJson, 'utf8')); } catch { /* ignore */ }
    for (const dep of Object.keys(meta.dependencies || {})) {
      if (!found.has(dep)) queue.push({ name: dep, from: dir });
    }
  }
  return { direct, found };
}

/* ------------------------------ 2. 主流程 ------------------------------ */
function main() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'))) {
    console.error('找不到 Electron 运行时，请先执行 npm install 并确保 node_modules/electron/dist 存在。');
    process.exit(1);
  }

  log('输出目录:', OUT);
  rmrf(OUT);
  ensureDir(OUT);

  // 2.1 Electron 运行时
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  const keepLocales = new Set(['zh-CN.pak', 'en-US.pak', 'zh-TW.pak']);
  const res = copyTree(dist, OUT, {
    skip: (p, n) => {
      if (n === 'electron.exe') return true;              // 稍后改名复制
      if (p.includes(`${path.sep}locales${path.sep}`)) return !keepLocales.has(n);
      if (/\.pdb$/i.test(n)) return true;
      return false;
    }
  });
  log(`Electron 运行时: ${res.files} 个文件, ${(res.bytes / 1048576).toFixed(1)} MB`);

  // 2.2 重命名主程序
  copyFile(path.join(dist, 'electron.exe'), path.join(OUT, EXE));

  // 2.3 应用代码
  const appDir = path.join(OUT, 'resources', 'app');
  ensureDir(appDir);
  rmrf(path.join(OUT, 'resources', 'default_app.asar'));

  for (const item of ['electron', 'src', 'assets', 'music']) {
    const s = path.join(ROOT, item);
    if (!fs.existsSync(s)) continue;
    const r = copyTree(s, path.join(appDir, item), { skip: (p, n) => SKIP_FILE.test(n) });
    log(`  ${item}: ${r.files} 个文件`);
  }
  // package.json（去掉只用于打包的 build 段与 devDependencies）
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const runtimePkg = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    main: pkg.main,
    author: pkg.author,
    license: pkg.license,
    dependencies: pkg.dependencies || {}
  };
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(runtimePkg, null, 2));

  // 2.4 运行时依赖
  const { found } = resolveDependencyClosure();
  let depFiles = 0;
  for (const [name, srcDir] of found) {
    const dstDir = path.join(appDir, 'node_modules', name);
    const r = copyTree(srcDir, dstDir, {
      skip: (p, n) => SKIP_FILE.test(n) || /^\.(git|github|nyc_output|vscode)/.test(n),
      skipDirs: (p, n) => ['test', 'tests', '__tests__', 'docs', 'example', 'examples', '.github', 'coverage'].includes(n)
    });
    depFiles += r.files;
    log(`  依赖 ${name}: ${r.files} 个文件`);
  }
  log(`运行时依赖共 ${found.size} 个包 / ${depFiles} 个文件`);

  // 2.5 启动说明
  fs.writeFileSync(path.join(OUT, '使用说明.txt'), [
    'Aurora 极光音乐  v' + pkg.version,
    '=====================================',
    '',
    '直接双击 ' + EXE + ' 即可运行（免安装）。',
    '',
    '· 首次启动会自动扫描系统「音乐」文件夹，也可以在「设置 → 曲库与扫描」里添加自己的文件夹。',
    '· 桌面快捷方式：应用首次运行会自动创建；也可以点「设置 → 数据与关于 → 创建桌面快捷方式」。',
    '· 数据（曲库 / 听歌统计 / 设置 / 封面缓存）保存在：',
    '    %APPDATA%\\' + APP_NAME,
    '· 支持格式：MP3 / OGG / M4A / FLAC / WAV / AAC / OPUS',
    '',
    '删除整个目录即可卸载（再手动删除上面的数据目录可清空全部记录）。'
  ].join('\r\n'), 'utf8');

  // 2.6 统计结果
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* ignore */ } }
    }
  };
  walk(OUT);
  log(`打包完成！总大小 ${(total / 1048576).toFixed(1)} MB → ${OUT}`);
  console.log(OUT);
}

main();
