// server.js
const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());
app.use(cors());

let page = null; // lưu tab đang thao tác
let browser = null;
let activeprofileno=null;
let wsEndpoint = null; 

async function getwsendpoint(profileNo) {
  const url = `http://localhost:50325/api/v2/browser-profile/active?profile_no=${profileNo}`;
  const res = await fetch(url);
  const data = await res.json();
  console.log(data);
  return data.data.ws.puppeteer;
}
// Khởi tạo browser & lấy tab hiện có
async function init(profileNo) {
  wsEndpoint = await getwsendpoint(profileNo);
  console.log('wsEndpoint:', wsEndpoint);
  if (!browser) {
    browser = await chromium.connectOverCDP({ wsEndpoint });
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
    activeprofileno=profile_no;
    await init(profile_no);
    res.json({ success: true, message: `Đã kết nối profile ${profile_no}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});


// Route POST /click
app.post('/click', async (req, res) => {
  try {
    

    // Tìm frame cha / frame con
    const parentFrame = page.frames().find(f => f.url().includes('baccarat.multiplay'));
    if (!parentFrame) return res.status(500).json({ error: 'Không tìm thấy iframe cha' });

    let childFrame = parentFrame.childFrames()[0] || parentFrame;

    const playButton = req.body.el; // Lấy selector từ body
    console.log('Selector nhận được:', playButton);
    await childFrame.waitForSelector(playButton, { timeout: 10000 });
    const box = await childFrame.locator(playButton).first().boundingBox();

    if (!box) return res.status(500).json({ error: 'Không lấy được bounding box của button' });

    await childFrame.locator(playButton).scrollIntoViewIfNeeded();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    res.json({ success: true, message: 'Đã click nút chip thành công' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/click-table', async (req, res) => {
  try {
   

    const { el, tableId } = req.body;
    if (!el || !tableId) {
      return res.status(400).json({ error: 'Thiếu el hoặc tableId' });
    }

    const parentFrame = page.frames().find(f => f.url().includes('baccarat.multiplay'));
    if (!parentFrame)
      return res.status(500).json({ error: 'Không tìm thấy iframe cha' });

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


    const tableSelector = await targetTable.evaluate(el => el.getAttribute('data-id') || el.outerHTML);
    console.log('Đã tìm thấy bàn:', tableSelector?.slice(0, 200));


    const targetLocator = childFrame.locator(`div[data-role="table"]:has(.tableName--ed38c.name--e53b2.md--faf59:has-text("${tableId.trim()}")) ${el}`);
    await targetLocator.click({ force: true, timeout: 8000 });

    res.json({ success: true, message: `Đã click trong bàn ${tableId}` });
  } catch (e) {
    console.error('Lỗi khi click:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});




// Start server
app.listen(3000, () => {
  console.log('API server chạy tại http://localhost:3000');
});
