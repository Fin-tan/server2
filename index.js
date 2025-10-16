// server.js - phiên bản chỉnh để dùng với pkg (không dùng node-fetch)
const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const { URL } = require('url');
const http = require('http');
const https = require('https');

const app = express();
app.use(express.json());
app.use(cors());

let page = null; // tab đang thao tác
let browser = null;
let activeprofileno = null;
let wsEndpoint = null;

// simpleFetch: thay thế fetch/node-fetch, hoạt động tốt trong binary snapshot
async function simpleFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;

      const reqOptions = {
        method: (options.method || 'GET').toUpperCase(),
        headers: options.headers || {},
      };

      // Nếu body là object, stringify và set header
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
          const response = {
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            text: async () => raw,
            json: async () => {
              try { return JSON.parse(raw); }
              catch (e) { throw new Error('Invalid JSON response: ' + e.message); }
            },
          };
          resolve(response);
        });
      });

      req.on('error', (err) => reject(err));

      if (bodyData) req.write(bodyData);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Lấy ws endpoint từ service quản lý browser profile
async function getwsendpoint(profileNo) {
  const url = `http://localhost:50325/api/v2/browser-profile/active?profile_no=${profileNo}`;
  const res = await simpleFetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`getwsendpoint failed: ${res.status} ${res.statusText} ${txt}`);
  }
  const data = await res.json();
  console.log('getwsendpoint response:', data);
  // đảm bảo đường dẫn tồn tại
  if (!data || !data.data || !data.data.ws || !data.data.ws.puppeteer) {
    throw new Error('Invalid response from browser-profile service (missing data.data.ws.puppeteer)');
  }
  return data.data.ws.puppeteer;
}

// Khởi tạo browser & tìm tab cần thao tác
async function init(profileNo) {
  wsEndpoint = await getwsendpoint(profileNo);
  console.log('wsEndpoint:', wsEndpoint);
  if (!browser) {
    // connectOverCDP dùng wsEndpoint (kết nối tới browser remote)
    browser = await chromium.connectOverCDP({ endpointURL: wsEndpoint, slowMo: 0 });
  }
  const contexts = browser.contexts();
  for (const ctx of contexts) {
    const pages = ctx.pages();
    for (const p of pages) {
      const url = await p.url();
      if (url.includes("baccarat.multiplay")) {
        page = p;
        console.log('Đã kết nối tới tab:', url);
        return;
      }
    }
  }
  throw new Error("Không tìm thấy tab có baccarat.multiplay");
}

app.post('/init', async (req, res) => {
  try {
    const { profile_no } = req.body;
    if (!profile_no) return res.status(400).json({ error: 'Thiếu profile_no' });
    activeprofileno = profile_no;
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
    if (!page) return res.status(500).json({ error: 'Chưa init/không có page kết nối' });

    const parentFrame = page.frames().find(f => f.url().includes('baccarat.multiplay'));
    if (!parentFrame) return res.status(500).json({ error: 'Không tìm thấy iframe cha' });

    const childFrame = parentFrame.childFrames()[0] || parentFrame;
    const playButton = req.body.el;
    if (!playButton) return res.status(400).json({ error: 'Thiếu el trong body' });

    console.log('Selector nhận được:', playButton);
    await childFrame.waitForSelector(playButton, { timeout: 10000 });
    const locator = childFrame.locator(playButton).first();
    const box = await locator.boundingBox();

    if (!box) return res.status(500).json({ error: 'Không lấy được bounding box của button' });

    await locator.scrollIntoViewIfNeeded();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    res.json({ success: true, message: 'Đã click nút chip thành công' });
  } catch (e) {
    console.error('CLICK ERROR:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/click-table', async (req, res) => {
  try {
    if (!page) return res.status(500).json({ error: 'Chưa init/không có page kết nối' });

    const { el, tableId } = req.body;
    if (!el || !tableId) {
      return res.status(400).json({ error: 'Thiếu el hoặc tableId' });
    }

    const parentFrame = page.frames().find(f => f.url().includes('baccarat.multiplay'));
    if (!parentFrame) return res.status(500).json({ error: 'Không tìm thấy iframe cha' });

    const childFrame = parentFrame.childFrames()[0] || parentFrame;
    const tables = await childFrame.$$('div[data-role="table"]');

    console.log('Tổng số bàn tìm thấy:', tables.length);
    let targetTable = null;

    for (const t of tables) {
      const nameEl = await t.$('.tableName--ed38c.name--e53b2.md--faf59');
      const name = nameEl ? (await nameEl.innerText()).trim() : '';
      console.log('Đang kiểm tra bàn:', name);
      if (name === tableId.trim()) {
        targetTable = t;
        break;
      }
    }

    if (!targetTable) {
      return res.status(404).json({ error: `Không tìm thấy bàn "${tableId}"` });
    }

    const targetLocator = childFrame.locator(`div[data-role="table"]:has(.tableName--ed38c.name--e53b2.md--faf59:has-text("${tableId.trim()}")) ${el}`);
    await targetLocator.click({ force: true, timeout: 8000 });

    res.json({ success: true, message: `Đã click trong bàn ${tableId}` });
  } catch (e) {
    console.error('CLICK-TABLE ERROR:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API server chạy tại http://localhost:${PORT}`);
});
