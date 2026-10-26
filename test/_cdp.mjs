// 可复用的 Chrome DevTools Protocol 测试底座。
// 各测试脚本只管业务断言，启停浏览器、切窗口尺寸、上传文件、跑 evaluate 都在这里。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PAGE_URL, SHOTS_DIR, chromePath, userDataDir } from './_env.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch(opts = {}) {
  const port = opts.port || 9500;
  const profile = opts.profile || 'default';
  const win = opts.window || [1600, 1000];
  const profileDir = userDataDir(profile);

  // R13 之后照片会存进 IndexedDB —— 上一轮跑的残留会让这一轮「凭空多出照片」。
  // 除非显式 `fresh:false`，否则每次起浏览器都从空 profile 开始（同一轮内的 reload 仍然保留数据，
  // cdp-persist 正是靠这个验证「刷新复原」）。
  if (opts.fresh !== false) {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { }
  }
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e) { }

  const chrome = spawn(chromePath(), [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${win[0]},${win[1]}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--allow-file-access-from-files',
    'about:blank',
  ], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { ver = await r.json(); break; }
    } catch (e) { /* 还没起来 */ }
    await sleep(200);
  }
  if (!ver) { try { chrome.kill(); } catch (e) { } throw new Error('Chrome 没起来，端口 ' + port); }

  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  let seq = 0;
  const waiters = new Map();
  const events = { exceptions: [], errors: [], log: [] };
  const pending = (mid) => {
    const w = waiters.get(mid);
    waiters.delete(mid);
    return w;
  };

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      events.exceptions.push((d.exception && d.exception.description) || d.text || 'exception');
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      events.errors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };

  // send：CDP 响应是 { id, result: {...} }，个别方法自己再嵌一层 result。
  // 这里统一只剥一层，调用方需要拿 nodeId 之类的自己取 m.result.xxx。
  function send(method, params = {}) {
    const mid = ++seq;
    return new Promise((res, rej) => {
      waiters.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => {
        if (waiters.has(mid)) { waiters.delete(mid); rej(new Error(method + ' 超时')); }
      }, opts.timeout || 60000);
    });
  }

  async function evaluate(expr) {
    const m = await send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    const d = m.result || {};
    if (d.exceptionDetails) {
      const ex = d.exceptionDetails;
      throw new Error('页面内异常：' + ((ex.exception && ex.exception.description) || ex.text));
    }
    return d.result ? d.result.value : undefined;
  }

  // 取 querySelector 元素一次，返回 nodeId，之后可反复操作它。
  async function nodeId(selector) {
    const doc = await send('DOM.getDocument', { depth: 1 });
    const root = doc.result.root.nodeId;
    const q = await send('DOM.querySelector', { nodeId: root, selector });
    if (!q.result.nodeId) throw new Error('找不到元素：' + selector);
    return q.result.nodeId;
  }

  async function setFiles(selector, files) {
    const nid = await nodeId(selector);
    const r = await send('DOM.setFileInputFiles', { nodeId: nid, files });
    if (r.error) throw new Error('上传失败：' + JSON.stringify(r.error));
  }

  async function resize(w, h, opts2 = {}) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h,
      deviceScaleFactor: opts2.dsf || 1,
      mobile: !!opts2.mobile,
      screenWidth: w, screenHeight: h,
    });
    if (opts2.touch) await send('Emulation.setTouchEmulationEnabled', { maxTouchPoints: 5 });
    await sleep(opts2.settle || 420);      // 页面里 resize 防抖 150ms
  }

  async function screenshot(name) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const p = path.join(SHOTS_DIR, name);
    fs.writeFileSync(p, Buffer.from(shot.result.data, 'base64'));
    return p;
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await send('DOM.enable');

  const api = {
    send, evaluate, nodeId, setFiles, resize, screenshot, events, sleep,
    async goto(url) {
      await send('Page.navigate', { url: url || PAGE_URL });
      await sleep(opts.loadWait || 2400);
    },
    async close() {
      try { ws.close(); } catch (e) { }
      try { chrome.kill(); } catch (e) { }
      await sleep(250);
    },
    // 断言小工具：收集失败而不是立刻抛，最后一次性报告。
    checks: [],
    ok(name, cond, detail) {
      api.checks.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
      return !!cond;
    },
    report() {
      const bad = api.checks.filter((c) => !c.ok);
      for (const c of api.checks) {
        console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.detail ? '  [' + c.detail + ']' : ''));
      }
      const exc = events.exceptions.concat(events.errors);
      console.log('--- 页面异常 ---');
      console.log(exc.length ? exc.join('\n') : '(无)');
      console.log('--- 汇总 ---');
      console.log((bad.length ? 'FAILED ' + bad.length + '/' + api.checks.length : 'ALL PASS ' + api.checks.length + ' 项'));
      return bad.length === 0 && exc.length === 0;
    },
  };
  return api;
}

export { sleep };
