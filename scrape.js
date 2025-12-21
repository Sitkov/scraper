import { chromium } from 'playwright'
import fs from 'fs'

// ПРОВЕРКА ЗАПУСКА
console.log('--- ИНИЦИАЛИЗАЦИЯ СКРИПТА ---');

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '')
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim()
const MAX_KEEP      = 3;

const SEEN_FILE  = 'seen.json'
const INCLUDE_RE = /(изменени[яе]\s+в\s+расписани[ие])/i
const EXCLUDE_RE = /(экзамен|экзаменац|сесс(ия|ии)|олимпиад|конкурс)/i

// Функция для красивого названия (Понедельник - 22 декабря)
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
        const dayName = days[dateObj.getDay()];
        return `${dayName} - ${dayNum} ${monthStr}`;
      }
    }
  } catch (e) {
    console.log('Не удалось отформатировать заголовок, использую оригинал');
  }
  return title;
}

async function parseResponse(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`Ошибка в ${label}: Сервер прислал не JSON. Ответ: ${text.slice(0, 100)}`);
    return { ok: false };
  }
}

const loadJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return fb } }
const saveJson = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf-8')

async function main() {
  console.log('--- СТАРТ ГЛАВНОЙ ФУНКЦИИ ---');
  
  if (!SITE_BASE_RAW || !ADMIN_PASS) {
    console.error('КРИТИЧЕСКАЯ ОШИБКА: Нет переменных SITE_BASE или ADMIN_PASS в Secrets!');
    return;
  }

  const seen = loadJson(SEEN_FILE, { ids: [] });
  const browser = await chromium.launch();
  
  const hasState = fs.existsSync('state.json');
  console.log(hasState ? 'Файл сессии state.json найден' : 'Файл state.json ОТСУТСТВУЕТ');
  
  const context = await browser.newContext(hasState ? { storageState: 'state.json' } : {});
  const page = await context.newPage();

  try {
    console.log('Перехожу на сайт колледжа...');
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    const links = await page.evaluate(() => {
      return Array.from(new Set(
        Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.href)
          .filter(h => /\/news\/show\/\d+$/i.test(h))
      ))
    });

    console.log(`Найдено ссылок на новости: ${links.length}`);
    // На GitHub Actions seen всегда пустой при старте, так что он увидит все новости как новые
    const toProcess = links.slice(0, 5); 

    for (const url of toProcess) {
      try {
        const p = await context.newPage();
        await p.goto(url, { waitUntil: 'domcontentloaded' });
        const originalTitle = (await p.innerText('h1, h2, .title').catch(() => '')).trim();
        
        const pdf = await p.evaluate(() => {
          const a = document.querySelector('a[href*=".pdf"]');
          return a ? a.href : '';
        });
        await p.close();

        if (pdf && INCLUDE_RE.test(originalTitle) && !EXCLUDE_RE.test(originalTitle)) {
          const prettyTitle = formatRussianTitle(originalTitle);
          console.log(`Обработка: ${originalTitle} -> ${prettyTitle}`);
          
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
            const add = await parseResponse(addRes, 'Добавление записи');
            
            if (add.ok && add.added) {
              console.log(`УСПЕШНО ДОБАВЛЕНО: ${prettyTitle}`);
              await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n${prettyTitle}` }
              }).catch(() => {});
            } else {
              console.log(`Пропущено (уже есть на сайте): ${prettyTitle}`);
            }
          }
        }
      } catch (err) { console.error(`Ошибка при чтении карточки ${url}:`, err.message); }
    }
  } catch (err) { console.error('Ошибка при работе с сайтом:', err.message); }

  // ОЧИСТКА
  try {
    console.log('Начинаю очистку базы (оставляю 3)...');
    const listRes = await context.request.get(`${SITE_BASE_RAW}/admin_change_list.php`, { params: { pass: ADMIN_PASS } });
    const data = await parseResponse(listRes, 'Список для очистки');
    if (data && Array.isArray(data.items)) {
      let items = data.items;
      items.sort((a, b) => b.id - a.id);
      if (items.length > MAX_KEEP) {
        const toDelete = items.slice(MAX_KEEP);
        for (const item of toDelete) {
          const delRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_delete.php`, {
            data: { pass: ADMIN_PASS, id: item.id }
          });
          const delStatus = await parseResponse(delRes, 'Удаление');
          if (delStatus.ok) console.log(`Удалено: ${item.title}`);
        }
      }
    }
  } catch (e) { console.error('Ошибка в блоке очистки:', e.message); }

  await browser.close();
  console.log('--- СКРИПТ ЗАВЕРШЕН ---');
}

main().catch(e => { 
  console.error('КРИТИЧЕСКАЯ ОШИБКА ВЫПОЛНЕНИЯ:');
  console.error(e); 
  process.exit(1); 
});
