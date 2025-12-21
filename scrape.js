import { chromium } from 'playwright'
import fs from 'fs'

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
// Убираем лишние пробелы и слэши из адреса
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '')
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim()
const MAX_KEEP      = 3; // ОСТАВЛЯЕМ ТОЛЬКО 3

const SEEN_FILE  = 'seen.json'
const INCLUDE_RE = /(изменени[яе]\s+в\s+расписани[ие])/i
const EXCLUDE_RE = /(экзамен|экзаменац|сесс(ия|ии)|олимпиад|конкурс)/i

// Функция для обработки ответа от вашего PHP-сервера
async function parseResponse(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`Ошибка в ${label}: Сервер прислал не JSON. Проверьте SITE_BASE.`);
    console.error(`Ответ сервера (первые 100 символов): ${text.slice(0, 100)}`);
    return { ok: false };
  }
}

const loadJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return fb } }
const saveJson = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf-8')

async function main() {
  if (!SITE_BASE_RAW || !ADMIN_PASS) {
    console.error('Ошибка: SITE_BASE или ADMIN_PASS не заданы в Secrets!');
    process.exit(1);
  }

  const seen = loadJson(SEEN_FILE, { ids: [] })
  const browser = await chromium.launch()
  
  // Используем state.json если он есть (создается из секрета в Workflow)
  const context = await browser.newContext(fs.existsSync('state.json') ? { storageState: 'state.json' } : {})
  const page = await context.newPage()

  console.log(`Запуск. Целевой сайт: ${SITE_BASE_RAW}`);

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
    console.log(`Найдено новых новостей: ${toProcess.length}`)

    for (const url of toProcess) {
      try {
        const p = await context.newPage()
        await p.goto(url, { waitUntil: 'domcontentloaded' })
        const title = (await p.innerText('h1, h2, .title').catch(() => '')).trim()
        
        // Ищем PDF
        const pdf = await p.evaluate(() => {
          const a = document.querySelector('a[href*=".pdf"]');
          return a ? a.href : '';
        });
        await p.close()

        if (pdf && INCLUDE_RE.test(title) && !EXCLUDE_RE.test(title)) {
          console.log(`Найдено подходящее: ${title}`);
          
          // 1. Качаем
          const pdfResp = await context.request.get(pdf);
          const buf = await pdfResp.body();
          
          // 2. Грузим PDF
          const upRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, {
            data: { pass: ADMIN_PASS, data: buf.toString('base64'), name: `change_${Date.now()}` }
          });
          const up = await parseResponse(upRes, 'Загрузка PDF');
          
          if (up.ok && up.url) {
            // 3. Добавляем в список
            const addRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
              data: { pass: ADMIN_PASS, title: title, url: up.url, source: url }
            });
            const add = await parseResponse(addRes, 'Добавление записи');
            
            if (add.ok && add.added) {
              console.log('Запись добавлена на сайт!');
              // Рассылка
              await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n${title}` }
              }).catch(() => {});
            }
          }
        }
        seen.ids.push(url)
      } catch (err) { console.error(`Ошибка карточки ${url}:`, err.message) }
    }
    saveJson(SEEN_FILE, seen)

  } catch (err) { console.error('Ошибка на главной:', err.message) }

  // --- БЛОК ЖЕСТКОЙ ОЧИСТКИ ---
  try {
    console.log('--- Начинаю очистку (оставляю только 3) ---');
    const listRes = await context.request.get(`${SITE_BASE_RAW}/admin_change_list.php`, { params: { pass: ADMIN_PASS } });
    const data = await parseResponse(listRes, 'Получение списка');
    
    if (data && Array.isArray(data.items)) {
      let items = data.items;
      // Сортируем по ID (таймстамп), новые сверху
      items.sort((a, b) => b.id - a.id);

      if (items.length > MAX_KEEP) {
        const toDelete = items.slice(MAX_KEEP);
        console.log(`Лишних записей: ${toDelete.length}. Удаляю...`);
        
        for (const item of toDelete) {
          const delRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_delete.php`, {
            data: { pass: ADMIN_PASS, id: item.id }
          });
          const delStatus = await parseResponse(delRes, 'Удаление');
          if (delStatus.ok) console.log(`Удалено: ${item.title}`);
        }
      } else {
        console.log('Лимит не превышен, записей 3 или меньше.');
      }
    }
  } catch (e) {
    console.error('Ошибка в блоке очистки:', e.message);
  }

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
