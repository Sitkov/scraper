import { chromium } from 'playwright'
import fs from 'fs'

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '')
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim()
const MAX_KEEP      = 3;

const INCLUDE_RE = /(изменени[яе]\s+в\s+расписани[ие])/i
const EXCLUDE_RE = /(экзамен|экзаменац|сесс(ия|ии)|олимпиад|конкурс)/i

function formatRussianTitle(title) {
  try {
    const months = {
      'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'мая': 4, 'июня': 5,
      'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11
    };
    const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
    const match = title.match(/(\d{1,2})\s+([а-яё]+)/i);
    if (match) {
      const dayNum = parseInt(match[1]);
      const monthStr = match[2].toLowerCase();
      if (months.hasOwnProperty(monthStr)) {
        const year = new Date().getFullYear();
        const dateObj = new Date(year, months[monthStr], dayNum);
        return `📅 ${days[dateObj.getDay()]} - ${dayNum} ${monthStr}`;
      }
    }
  } catch (e) {}
  return `📅 ${title}`;
}

async function parseResponse(response, label) {
  const text = await response.text();
  try { return JSON.parse(text); } catch (e) { return { ok: false }; }
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: fs.existsSync('state.json') ? 'state.json' : undefined,
    acceptDownloads: true
  });
  const page = await context.newPage();

  try {
    // 1. ПОЛУЧАЕМ ТЕКУЩИЙ СПИСОК С ТВОЕГО САЙТА (ЧТОБЫ НЕ ДУБЛИРОВАТЬ УВЕДЫ)
    const listRes = await context.request.get(`${SITE_BASE_RAW}/admin_change_list.php`, { params: { pass: ADMIN_PASS } });
    const remoteData = await parseResponse(listRes, 'Загрузка текущего списка');
    const existingTitles = new Set((remoteData.items || []).map(it => it.title));

    console.log('Захожу на сайт колледжа...');
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 60000 });
    
    const links = await page.evaluate(() => {
      return Array.from(new Set(Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h))));
    });

    const toProcess = links.slice(0, 10); 
    let addedAnything = false;
    let lastAddedTitle = "";

    for (const url of toProcess) {
      const p = await context.newPage();
      try {
        await p.goto(url, { waitUntil: 'networkidle', timeout: 40000 });
        const title = (await p.innerText('h1, h2, .title, .news-title').catch(() => '')).trim();
        
        if (INCLUDE_RE.test(title) && !EXCLUDE_RE.test(title)) {
           const prettyTitle = formatRussianTitle(title);
           
           // ЕСЛИ ТАКОЙ ЗАГОЛОВОК УЖЕ ЕСТЬ НА САЙТЕ - ИГНОРИРУЕМ ПОЛНОСТЬЮ
           if (existingTitles.has(prettyTitle)) {
             console.log(`Уже есть на сайте: ${prettyTitle}`);
             continue;
           }

           const pdfSelector = 'a[href*=".pdf"], a[href*="/download/"]';
           const hasPdf = await p.$(pdfSelector);

           if (hasPdf) {
              console.log(`✅ Нашел новое: "${prettyTitle}"`);
              const downloadPromise = p.waitForEvent('download');
              await p.click(pdfSelector); 
              const download = await downloadPromise;
              const buf = fs.readFileSync(await download.path());
              
              if (buf && buf.length > 1000) {
                const upRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, {
                  data: { pass: ADMIN_PASS, data: buf.toString('base64'), name: `change_${Date.now()}` }
                });
                const up = await parseResponse(upRes, 'Загрузка PDF');
                
                if (up.ok && up.url) {
                  const addRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                    data: { pass: ADMIN_PASS, title: prettyTitle, url: up.url, source: url }
                  });
                  const add = await parseResponse(addRes, 'Добавление');
                  if (add.ok && add.added) {
                    console.log(`🚀 ДОБАВЛЕНО: ${prettyTitle}`);
                    addedAnything = true;
                    lastAddedTitle = prettyTitle;
                  }
                }
              }
           }
        }
      } catch (e) { console.error(`Ошибка: ${e.message}`); }
      await p.close();
    }

    // ОТПРАВЛЯЕМ УВЕДОМЛЕНИЕ ТОЛЬКО ОДИН РАЗ (о самом свежем)
    if (addedAnything) {
        await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
          data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n\n${lastAddedTitle}` }
        }).catch(() => {});
    }

  } catch (err) { console.error('Критическая ошибка:', err.message); }

  // Очистка сайта
  try {
    const listRes = await context.request.get(`${SITE_BASE_RAW}/admin_change_list.php`, { params: { pass: ADMIN_PASS } });
    const data = await parseResponse(listRes, 'Очистка');
    if (data && Array.isArray(data.items)) {
      let items = data.items.sort((a, b) => b.id - a.id);
      if (items.length > MAX_KEEP) {
        for (const item of items.slice(MAX_KEEP)) {
          await context.request.post(`${SITE_BASE_RAW}/admin_change_delete.php`, { data: { pass: ADMIN_PASS, id: item.id } });
        }
      }
    }
  } catch (e) {}

  // Очистка старых уведомлений в ТГ
  try {
    await context.request.get(`${SITE_BASE_RAW}/admin_auto_cleanup.php`, { params: { pass: ADMIN_PASS } });
  } catch (e) {}

  await browser.close();
}

main().catch(e => { process.exit(1); });
