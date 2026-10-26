// 测试与数据生成脚本共用的路径常量。
// 全部相对仓库根解析 —— 整个仓库可以搬到任意目录、任意盘符。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PAGE_FILE = path.join(ROOT, 'index.html');
export const PAGE_URL = pathToFileURL(PAGE_FILE).href;

export const TMP = path.join(os.tmpdir(), 'photo-map-wall');
export const SHOTS_DIR = path.join(ROOT, 'test', 'shots');
export const TEST_IMGS = path.join(TMP, 'testimg');
export const IMGS15 = path.join(TMP, 'imgs15');
export const EXIFCASES = path.join(TMP, 'exifcases');
export const PROV_FILE = path.join(ROOT, 'data', 'provinces.js');
export const DEMO5 = path.join(ROOT, 'assets', 'demo5');

// 别名：让各脚本保持原有的变量名，readdirSync 之类不用改。
export const SHOTS = SHOTS_DIR;
export const OUT = SHOTS_DIR;
export const IMGS = IMGS15;
export const DIR = EXIFCASES;
export const PAGE = PAGE_URL;
export const TARGET = PAGE_FILE;

// Chrome 找不到时可以用环境变量 CHROME_PATH 指定。
export function chromePath() {
  const cands = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Chrome，请设置环境变量 CHROME_PATH');
}

// 每个测试脚本一份独立的 Chrome profile 目录，避免互相抢锁。
export function userDataDir(name) {
  const d = path.join(TMP, '_chrome', name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function ensureDirs() {
  for (const d of [TMP, SHOTS_DIR, TEST_IMGS, IMGS15, EXIFCASES]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// 导入即建好目录：截图和测试用图都有地方落。
ensureDirs();
