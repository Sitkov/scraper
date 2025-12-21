import { chromium } from 'playwright'
import fs from 'fs'

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '')
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim()
const MAX_KEEP      = 3;

const SEEN_FILE  = 'seen.json'
const INCLUDE_RE = /(изменени[яе]\s+в\s+расписани[ие])/i
const EXCLUDE_RE = /(экзамен|экзаменац|сесс(ия|ии)|олимпиад|конкурс)/i

// --- НОВАЯ ФУНКЦИЯ ДЛЯ КРАСИВОГО НАЗВАНИЯ ---
function formatRussianTitle(title) {
  const months = {
    'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'мая': 4, 'июня': 5,
    'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11
  };
  const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

  // Ищем число и название месяца в тексте
  const match = title.match(/(\d{1,2})\s+([а-яё]+)/i);
  if (match) {
    const dayNum = parseInt(match[1]);
    const monthStr = match[2].toLowerCase();

    if (months.hasOwnProperty(monthStr)) {
      const year = new Date().getFullYear();
      // Создаем объект даты (месяцы в JS начинаются с 0)
      const dateObj = new Date(year, months[monthStr], dayNum);
      const dayName = days[dateObj.getDay()]; // Получаем день недели
      
      return `${dayName} - ${dayNum} ${monthStr}`;
    }
  }
  return title; // Если не удалось распознать дату, оставляем как было
}
// --------------------------------------------

async function parseResponse(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`Ошибка в ${label}: Сервер прислал не JSON.`);
    return { ok: false };
  }
}

const loadJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return fb } }
const saveJson = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf-8')

async function main() {
  if (!SITE_BASE_RAW || !ADMIN_PASS) {
    console.error('Ошибка: SITE_BASE или ADMIN_PASS не заданы!');
    process.exit(1);
  }

  const seen = loadJson(SEEN_FILE, { ids: [] })
  const browser = await chromium.launch()
  const context = await browser.newContext(fs.existsSync('state.json') ? { storageState: 'state.json' } : {})
  const page = await context.newPage()

  try {
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(3000)

    const links = await page.evaluate(() => {
      return Array.from(new Set(
        Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.href)
          .filter(h => /\/news\/show\/\d+$/i.test(h))
      ))
    })

    const toProcess = links.filter(h => !seen.ids.includes(h)).slice(0, 5)

    for (const url of toProcess) {
      try {
        const p = await context.newPage()
        await p.goto(url, { waitUntil: 'domcontentloaded' })
        const originalTitle = (await p.innerText('h1, h2, .title').catch(() => '')).trim()
        
        const pdf = await p.evaluate(() => {
          const a = document.querySelector('a[href*=".pdf"]');
          return a ? a.href : '';
        });
        await p.close()

        if (pdf && INCLUDE_RE.test(originalTitle) && !EXCLUDE_RE.test(originalTitle)) {
          // ПРЕОБРАЗУЕМ НАЗВАНИЕ
          const prettyTitle = formatRussianTitle(originalTitle);
          console.log(`Найдено: ${originalTitle} -> Преобразовано в: ${prettyTitle}`);
          
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
              console.log('Запись добавлена!');
              await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n${prettyTitle}` }
              }).catch(() => {});
            }
          }
        }
        seen.ids.push(url)
      } catch (err) { console.error(`Ошибка карточки ${url}:`, err.message) }
    }
    saveJson(SEEN_FILE, seen)
  } catch (err) { console.error('Ошибка на главной:', err.message) }

  // Блок очистки
  try {
    const listRes = await context.request.get(`${SITE_BASE_RAW}/admin_change_list.php`, { params: { pass: ADMIN_PASS } });
    const data = await parseResponse(listRes, 'Получение списка');
    if (data && Array.isArray(data.items)) {
      let items = data.items;
      items.sort((a, b) => b.id - a.id);
      if (items.length > MAX_KEEP) {
        const toDelete = items.slice(MAX_KEEP);
        for (const item of toDelete) {
          await context.request.post(`${SITE_BASE_RAW}/admin_change_delete.php`, {
            data: { pass: ADMIN_PASS, id: item.id }
          });
        }
      }
    }
  } catch (e) {}

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
