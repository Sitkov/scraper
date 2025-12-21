import { chromium } from 'playwright'
import fs from 'fs'

console.log('--- ИНИЦИАЛИЗАЦИЯ СКРИПТА ---');

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '')
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim()
const MAX_KEEP      = 3;

const SEEN_FILE  = 'seen.json'
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
        return `${days[dateObj.getDay()]} - ${dayNum} ${monthStr}`;
      }
    }
  } catch (e) {}
  return title;
}

async function parseResponse(response, label) {
  const text = await response.text();
  try { return JSON.parse(text); } catch (e) {
    console.error(`Ошибка в ${label}: Сервер прислал не JSON. Текст: ${text.slice(0, 50)}`);
    return { ok: false };
  }
}

async function main() {
  console.log('--- СТАРТ ГЛАВНОЙ ФУНКЦИИ ---');
  
  const browser = await chromium.launch();
  const context = await browser.newContext(fs.existsSync('state.json') ? { storageState: 'state.json' } : {});
  const page = await context.newPage();

  try {
    console.log('Загрузка списка с вашего сайта для проверки...');
    const listRes = await context.request.get(`${SITE_BASE_RAW}/admin_change_list.php`, { params: { pass: ADMIN_PASS } });
    const currentData = await parseResponse(listRes, 'Первичная проверка списка');
    const isSiteEmpty = !currentData.items || currentData.items.length === 0;

    console.log('Перехожу на сайт колледжа...');
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    const links = await page.evaluate(() => {
      return Array.from(new Set(Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h))));
    });

    console.log(`Найдено ссылок на новости: ${links.length}`);

    // Если на сайте пусто, мы игнорируем "seen.json" и обрабатываем всё заново
    const seen = isSiteEmpty ? { ids: [] } : (JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8').catch(() => '{"ids":[]}')));
    const toProcess = links.filter(h => !seen.ids.includes(h)).slice(0, 5);

    console.log(`Будет обработано новостей: ${toProcess.length}`);

    for (const url of toProcess) {
      console.log(`Открываю новость: ${url}`);
      const p = await context.newPage();
      try {
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const title = (await p.innerText('h1, h2, .title, .news-title').catch(() => '')).trim();
        console.log(`Заголовок: "${title}"`);

        const pdf = await p.evaluate(() => {
          const a = document.querySelector('a[href*=".pdf"]');
          return a ? a.href : '';
        });

        if (pdf && INCLUDE_RE.test(title) && !EXCLUDE_RE.test(title)) {
          const prettyTitle = formatRussianTitle(title);
          console.log(`✅ Найдено расписание! PDF: ${pdf}. Название: ${prettyTitle}`);
          
          const pdfResp = await context.request.get(pdf);
          const buf = await pdfResp.body();
          
          const upRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, {
            data: { pass: ADMIN_PASS, data: buf.toString('base64'), name: `change_${Date.now()}` }
          });
          const up = await parseResponse(upRes, 'Загрузка PDF');
          
          if (up.ok && up.url) {
            const addRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
              data: { pass: ADMIN_PASS, title: prettyTitle, url: up.url, source: url }
            });
            const add = await parseResponse(addRes, 'Добавление');
            if (add.ok) console.log(`🚀 УСПЕШНО ДОБАВЛЕНО: ${prettyTitle}`);
          }
        } else {
          console.log(`❌ Пропускаю (не подходит по фильтру или нет PDF)`);
        }
      } catch (e) { console.error(`Ошибка страницы ${url}: ${e.message}`); }
      await p.close();
    }
  } catch (err) { console.error('Ошибка:', err.message); }

  // Очистка
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

  await browser.close();
  console.log('--- СКРИПТ ЗАВЕРШЕН ---');
}

main().catch(e => { console.error(e); process.exit(1); });
