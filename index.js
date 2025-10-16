const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const { URL } = require('url');
const http = require('http');
const https = require('https');

const app = express();
app.use(express.json());
app.use(cors());

// sessions lưu profile_no -> { browser, page, wsEndpoint }
const sessions = {};

async function simpleFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const reqOptions = {
        method: (options.method || 'GET').toUpperCase(),
        headers: options.headers || {},
      };
      let bodyData = null;
      if (options.body !== undefined && options.body !== null) {
        if (typeof options.body === 'string' || Buffer.isBuffer(options.body)) {
          bodyData = options.body;
        } else {
          bodyData = JSON.stringify(options.body);
          if (!reqOptions.headers['content-type'] && !reqOptions.headers['Content-Type']) {
            reqOptions.headers['Content-Type'] = 'application/json';
          }
        }
        reqOptions.headers['Content-Length'] = Buffer.byteLength(bodyData);
      }
      const req = lib.request(u, reqOptions, (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            text: async () => raw,
            json: async () => JSON.parse(raw),
          });
        });
      });
      req.on('error', (err) => reject(err));
      if (bodyData) req.write(bodyData);
      req.end();
    } catch (err) { reject(err); }
  });
}

async function getwsendpoint(profileNo) {
  const url = `http://localhost:50325/api/v2/browser-profile/active?profile_no=${profileNo}`;
  const res = await simpleFetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`getwsendpoint failed: ${res.status} ${res.statusText} ${txt}`);
  }
  const data = await res.json();
  if (!data?.data?.ws?.puppeteer) {
    throw new Error('Invalid response from browser-profile service (missing data.data.ws.puppeteer)');
  }
  return data.data.ws.puppeteer;
}

async function init(profileNo) {
  if (sessions[profileNo]) return sessions[profileNo]; // đã init trước đó
  const wsEndpoint = await getwsendpoint(profileNo);
  const browser = await chromium.connectOverCDP({ endpointURL: wsEndpoint, slowMo: 0 });
  let page = null;
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      const url = await p.url();
      if (url.includes("baccarat.multiplay")) {
        page = p;
        break;
      }
    }
    if (page) break;
  }
  if (!page) throw new Error("Không tìm thấy tab có baccarat.multiplay");
  sessions[profileNo] = { browser, page, wsEndpoint };
  return sessions[profileNo];
}

app.post('/init', async (req, res) => {
  try {
    const { profile_no } = req.body;
    if (!profile_no) return res.status(400).json({ error: 'Thiếu profile_no' });
    await init(profile_no);
    res.json({ success: true, message: `Đã kết nối profile ${profile_no}` });
  } catch (e) {
    console.error('INIT ERROR:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// click generic
app.post('/click', async (req, res) => {
  try {
    const { profile_no, el } = req.body;
    if (!profile_no || !el) return res.status(400).json({ error: 'Thiếu profile_no hoặc el' });
    const session = await init(profile_no);
    const page = session.page;

    const parentFrame = page.frames().find(f => f.url().includes('baccarat.multiplay'));
    if (!parentFrame) return res.status(500).json({ error: 'Không tìm thấy iframe cha' });

    const childFrame = parentFrame.childFrames()[0] || parentFrame;
    await childFrame.waitForSelector(el, { timeout: 10000 });
    const locator = childFrame.locator(el).first();
    const box = await locator.boundingBox();
    if (!box) return res.status(500).json({ error: 'Không lấy được bounding box của button' });

    await locator.scrollIntoViewIfNeeded();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    res.json({ success: true, message: `Đã click nút chip profile ${profile_no}` });
  } catch (e) {
    console.error('CLICK ERROR:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// click table
app.post('/click-table', async (req, res) => {
  try {
    const { profile_no, el, tableId } = req.body;
    if (!profile_no || !el || !tableId) return res.status(400).json({ error: 'Thiếu profile_no, el hoặc tableId' });
    const session = await init(profile_no);
    const page = session.page;

    const parentFrame = page.frames().find(f => f.url().includes('baccarat.multiplay'));
    if (!parentFrame) return res.status(500).json({ error: 'Không tìm thấy iframe cha' });
    const childFrame = parentFrame.childFrames()[0] || parentFrame;

    const tables = await childFrame.$$('div[data-role="table"]');
    let targetTable = null;
    for (const t of tables) {
      const nameEl = await t.$('.tableName--ed38c.name--e53b2.md--faf59');
      const name = nameEl ? (await nameEl.innerText()).trim() : '';
      if (name === tableId.trim()) { targetTable = t; break; }
    }
    if (!targetTable) return res.status(404).json({ error: `Không tìm thấy bàn "${tableId}"` });

    const targetLocator = childFrame.locator(`div[data-role="table"]:has(.tableName--ed38c.name--e53b2.md--faf59:has-text("${tableId.trim()}")) ${el}`);
    await targetLocator.click({ force: true, timeout: 8000 });

    res.json({ success: true, message: `Đã click trong bàn ${tableId} profile ${profile_no}` });
  } catch (e) {
    console.error('CLICK-TABLE ERROR:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API server chạy tại http://localhost:${PORT}`));
