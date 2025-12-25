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
    const months = {'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'мая': 4, 'июня': 5, 'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11};
    const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
    const match = title.match(/(\d{1,2})\s+([а-яё]+)/i);
    if (match) {
      const dayNum = parseInt(match[1]);
      const monthStr = match[2].toLowerCase();
      const dateObj = new Date(new Date().getFullYear(), months[monthStr], dayNum);
      return `📅 ${days[dateObj.getDay()]} - ${dayNum} ${monthStr}`;
    }
  } catch (e) {}
  return `📅 ${title}`;
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: fs.existsSync('state.json') ? 'state.json' : undefined, acceptDownloads: true });
  const page = await context.newPage();

  try {
    console.log('Поиск новостей на портале...');
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 60000 });
    const links = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h)))));

    // Обрабатываем новости от старых к новым (чтобы лимит в 3 записи работал корректно)
    for (const url of links.reverse().slice(-10)) {
      const p = await context.newPage();
      try {
        await p.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        const title = (await p.innerText('h1, h2, .title').catch(() => '')).trim();
        
        if (INCLUDE_RE.test(title) && !EXCLUDE_RE.test(title)) {
           const pdfSelector = 'a[href*=".pdf"], a[href*="/download/"]';
           if (await p.$(pdfSelector)) {
              const prettyTitle = formatRussianTitle(title);
              const download = await (async () => {
                const [d] = await Promise.all([p.waitForEvent('download'), p.click(pdfSelector)]);
                return d;
              })();
              
              const buf = fs.readFileSync(await download.path());
              if (buf.length > 1000) {
                // Грузим PDF
                const upRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, { data: { pass: ADMIN_PASS, data: buf.toString('base64'), name: `change_${Date.now()}` } });
                const up = await upRes.json().catch(() => ({}));
                
                if (up.ok && up.url) {
                  // Пытаемся добавить. PHP сам решит, слать уведомление или нет!
                  const addRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                    data: { pass: ADMIN_PASS, title: prettyTitle, url: up.url, source: url }
                  });
                  const add = await addRes.json().catch(() => ({}));
                  if (add.added) console.log(`🚀 Реально новая новость: ${prettyTitle}`);
                  else console.log(`Уже было на сайте: ${prettyTitle}`);
                }
              }
           }
        }
      } catch (e) {}
      await p.close();
    }
  } catch (err) { console.error('Ошибка:', err.message); }

  // Очистка сайта (оставляем 3) и ТГ (40 часов)
  await context.request.get(`${SITE_BASE_RAW}/admin_change_list.php`, { params: { pass: ADMIN_PASS } }).then(async r => {
    const data = await r.json();
    if (data.items && data.items.length > MAX_KEEP) {
      for (const it of data.items.sort((a,b) => b.id - a.id).slice(MAX_KEEP)) {
        await context.request.post(`${SITE_BASE_RAW}/admin_change_delete.php`, { data: { pass: ADMIN_PASS, id: it.id } });
      }
    }
  }).catch(() => {});
  await context.request.get(`${SITE_BASE_RAW}/admin_auto_cleanup.php`, { params: { pass: ADMIN_PASS } }).catch(() => {});

  await browser.close();
}
main().catch(() => process.exit(1));
