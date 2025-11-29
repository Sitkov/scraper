// scrape.js — Playwright + ЕСИА (state.json) + добавление ТОЛЬКО "Изменения в расписании"
const { chromium } = require('playwright');
const fs = require('fs');

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard';
const SITE_BASE     = 'https://xn--e1aabhcpqfgk.xn--e1akvd.xn--p1ai';
const ADMIN_PASS    = '22801!_adm';

const DEBUG = process.argv.includes('--debug');
const FORCE = process.argv.includes('--force');

const SEEN_FILE  = 'seen.json';

// Фильтры заголовков
// Включаем только заголовки вида "Изменения в расписании ..." (регистронезависимо)
const INCLUDE_RE = /(изменени[яе]\s+в\s+расписани[ие])/i;
// Доп. исключения (экзамены/сессии/олимпиады и прочее нерелевантное)
const EXCLUDE_RE = /(экзамен|экзаменац|сесс(ия|ии)|олимпиад|конкурс)/i;

function loadJson(path, fallback) { try { return JSON.parse(fs.readFileSync(path, 'utf-8')); } catch { return fallback; } }
function saveJson(path, data) { fs.writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8'); }
function loadSeen() { return loadJson(SEEN_FILE, { ids: [] }); }
function saveSeen(s) { saveJson(SEEN_FILE, s); }

async function extractPdfUrl(page) {
  const href = await page.evaluate(() => {
    const pdfRe = /\.pdf($|\?)/i;
    const as = Array.from(document.querySelectorAll('a[href]'));
    const a1 = as.find(a => pdfRe.test(a.href));
    if (a1) return a1.href;
    const a2 = as.find(a => /\/(media|files|download|news\/download)\//i.test(a.href));
    return a2 ? a2.href : '';
  });
  if (href) return href;

  const frameSrc = await page.evaluate(() => {
    const pick = (sel, attr) => { const el = document.querySelector(sel); return el ? el.getAttribute(attr) || '' : ''; };
    return (
      pick('iframe[src*=".pdf"]', 'src') ||
      pick('embed[src*=".pdf"]', 'src') ||
      pick('object[data*=".pdf"]', 'data') || ''
    );
  });
  if (frameSrc) return frameSrc;

  let pdfFromNet = '';
  const onResp = (resp) => {
    try { const ct = (resp.headers()['content-type'] || '').toLowerCase(); if (ct.includes('application/pdf')) pdfFromNet = resp.url(); } catch {}
  };
  page.on('response', onResp);
  await page.waitForTimeout(1200);
  page.off('response', onResp);
  return pdfFromNet || '';
}

async function discoverNewsLinks(page) {
  let links = await page.evaluate(() => {
    const as = Array.from(document.querySelectorAll('a[href]'));
    return as.map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h));
  });
  if (links.length < 5) {
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(1200);
      const more = await page.evaluate(() => {
        const as = Array.from(document.querySelectorAll('a[href]'));
        return as.map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h));
      });
      links = Array.from(new Set(links.concat(more)));
    }
  }
  return Array.from(new Set(links));
}

async function main() {
  const seen = loadSeen();
  const browser = await chromium.launch({ headless: !DEBUG });
  const context = await browser.newContext({ storageState: 'state.json' });
  const page = await context.newPage();

  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  const allLinks = await discoverNewsLinks(page);
  if (DEBUG) console.log('Нашли карточек:', allLinks.length);

  let toProcess = allLinks.filter(h => !seen.ids.includes(h));
  if (FORCE) toProcess = allLinks;
  if (DEBUG) console.log('К обработке:', toProcess.length);
  if (!toProcess.length) { console.log('Новых изменений нет'); await browser.close(); return; }

  // Собираем (title, pdf)
  const collected = [];
  for (const url of toProcess.slice(0, 20)) {
    try {
      const p = await context.newPage();
      await p.goto(url, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(1500);

      const title = await p.evaluate(() => {
        const el = document.querySelector('h1,h2,.title,.news-title');
        return (el?.textContent || document.title || 'Изменение').trim();
      });
      const pdf = await extractPdfUrl(p);
      await p.close();

      collected.push({ title, url: pdf, newsUrl: url });
      if (DEBUG) console.log(pdf ? `PDF: ${title} -> ${pdf}` : `PDF не найден на ${url}`);
    } catch (e) {
      console.log('Ошибка карточки:', url, e.message);
    }
  }

  // ФИЛЬТР: берём только «Изменения в расписании», исключаем нерелевантные
  const foundItems = collected.filter(it =>
    it.url &&
    INCLUDE_RE.test(it.title || '') &&
    !EXCLUDE_RE.test(it.title || '')
  );

  if (!foundItems.length) {
    console.log('Подходящих изменений не найдено');
    // помечаем просмотренными, чтобы не гонять по кругу
    seen.ids = Array.from(new Set(seen.ids.concat(toProcess)));
    saveSeen(seen);
    await browser.close();
    return;
  }

  // Получаем уже добавленные (антидубликаты)
  let existing = [];
  try {
    const listRes = await context.request.get(`${SITE_BASE}/api/admin/change_list`, { params: { pass: ADMIN_PASS } });
    const j = await listRes.json();
    existing = Array.isArray(j.items) ? j.items : [];
  } catch {}
  const existingUrls = new Set(existing.map(it => (it.url || '').trim()));

  const toAdd = foundItems.filter(it => !existingUrls.has((it.url || '').trim()));
  if (!toAdd.length) {
    console.log('Нет новых к добавлению после фильтра');
    seen.ids = Array.from(new Set(seen.ids.concat(toProcess)));
    saveSeen(seen);
    await browser.close();
    return;
  }

  // Добавляем и рассылаем только после успешного add
  for (const it of toAdd) {
    try {
      const addRes = await context.request.post(`${SITE_BASE}/api/admin/change_add`, {
        data: { pass: ADMIN_PASS, title: it.title, url: it.url }
      });
      if (!addRes.ok()) { console.log('ADD failed', addRes.status()); continue; }

      if (DEBUG) console.log('ADD ok:', it.title);
      await new Promise(r => setTimeout(r, 1200)); // троттлинг

      await context.request.post(`${SITE_BASE}/api/admin/broadcast`, {
        data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n${it.title}` }
      });

      // отмечаем карточку как обработанную (по URL новости)
      seen.ids = Array.from(new Set(seen.ids.concat([it.newsUrl])));
      saveSeen(seen);
    } catch (e) {
      console.log('Ошибка отправки', it.title, e.message);
    }
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
