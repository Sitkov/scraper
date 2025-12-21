import { chromium } from 'playwright'
import fs from 'fs'

// Настройки из переменных окружения
const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
const SITE_BASE_RAW = (process.env.SITE_BASE || '').replace(/\/+$/, '') // Убираем слэш в конце
const ADMIN_PASS    = process.env.ADMIN_PASS
const DEBUG         = true
const MAX_KEEP      = 3; // Оставляем только последние 3 записи

const SEEN_FILE  = 'seen.json'
const INCLUDE_RE = /(изменени[яе]\s+в\s+расписани[ие])/i
const EXCLUDE_RE = /(экзамен|экзаменац|сесс(ия|ии)|олимпиад|конкурс)/i

// Хелпер для безопасного парсинга JSON
async function safeJson(response, label = '') {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`!!! Ошибка в ${label}: Сервер прислал не JSON, а HTML. Возможно, неверный URL или 404.`);
    console.error(`Начало ответа сервера: ${text.slice(0, 150)}...`);
    return { ok: false, error: 'not_json' };
  }
}

const loadJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return fb } }
const saveJson = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf-8')
const loadSeen = () => loadJson(SEEN_FILE, { ids: [] })
const saveSeen = (s) => saveJson(SEEN_FILE, s)

async function extractPdfUrl(page) {
  return await page.evaluate(() => {
    const pdfRe = /\.pdf($|\?)/i
    const as = Array.from(document.querySelectorAll('a[href]'))
    const a1 = as.find(a => pdfRe.test(a.href))
    if (a1) return a1.href
    const a2 = as.find(a => /\/(media|files|download|news\/download)\//i.test(a.href))
    return a2 ? a2.href : ''
  })
}

async function main() {
  if (!SITE_BASE_RAW || !ADMIN_PASS) {
    console.error('Критическая ошибка: Переменные SITE_BASE или ADMIN_PASS не заданы в Secrets!');
    process.exit(1);
  }

  const seen = loadSeen()
  const browser = await chromium.launch()
  
  // Загружаем состояние сессии, если оно есть
  const context = await browser.newContext(fs.existsSync('state.json') ? { storageState: 'state.json' } : {})
  const page = await context.newPage()

  console.log('Захожу на сайт колледжа...')
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)

  // Ищем ссылки на новости
  const links = await page.evaluate(() => {
    return Array.from(new Set(
      Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(h => /\/news\/show\/\d+$/i.test(h))
    ))
  })

  const toProcess = links.filter(h => !seen.ids.includes(h)).slice(0, 5)
  console.log(`Найдено новых карточек: ${toProcess.length}`)

  const found = []
  for (const url of toProcess) {
    try {
      const p = await context.newPage()
      await p.goto(url, { waitUntil: 'domcontentloaded' })
      await p.waitForTimeout(1500)
      const title = (await p.innerText('h1, h2, .title, .news-title').catch(() => '')).trim()
      const pdf = await extractPdfUrl(p)
      await p.close()

      if (pdf && INCLUDE_RE.test(title) && !EXCLUDE_RE.test(title)) {
        found.push({ title, url: pdf, newsUrl: url })
      }
    } catch (e) { console.log(`Ошибка при чтении карточки ${url}: ${e.message}`) }
  }

  // Обработка найденных
  for (const it of found) {
    try {
      console.log(`Обрабатываю: ${it.title}`)
      const pdfResp = await context.request.get(it.url)
      if (!pdfResp.ok()) continue
      const buf = await pdfResp.body()

      // 1. Загрузка PDF
      const b64 = Buffer.from(buf).toString('base64')
      const upRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, {
        data: { pass: ADMIN_PASS, data: b64, name: `change_${Date.now()}` }
      })
      const up = await safeJson(upRes, 'upload_pdf')
      if (!up.ok) continue

      // 2. Добавление записи
      const addRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
        data: { pass: ADMIN_PASS, title: it.title, url: up.url, source: it.newsUrl }
      })
      const add = await safeJson(addRes, 'change_add')

      if (add.ok && add.added) {
        console.log(`Успешно добавлено: ${it.title}`)
        // 3. Рассылка
        await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
          data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n${it.title}` }
        }).catch(() => {})
      }
      seen.ids.push(it.newsUrl)
    } catch (e) { console.error(`Ошибка процесса: ${e.message}`) }
  }
  saveSeen(seen)

  // --- БЛОК ОЧИСТКИ (ТОЛЬКО 3 ЗАПИСИ) ---
  try {
    console.log('Проверка лимита записей (MAX_KEEP = 3)...')
    const listRes = await context.request.get(`${SITE_BASE_RAW}/admin_change_list.php`, { 
      params: { pass: ADMIN_PASS } 
    })
    const data = await safeJson(listRes, 'change_list')
    let items = Array.isArray(data.items) ? data.items : []

    // Сортируем: новые в начале
    items.sort((a, b) => (b.id || 0) - (a.id || 0))

    if (items.length > MAX_KEEP) {
      const toDelete = items.slice(MAX_KEEP)
      console.log(`Удаляю ${toDelete.length} старых записей...`)
      for (const item of toDelete) {
        const delRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_delete.php`, {
          data: { pass: ADMIN_PASS, id: item.id }
        })
        const res = await safeJson(delRes, 'change_delete')
        if (res.ok) console.log(`Удалено: ${item.title}`)
      }
    } else {
      console.log('Лимит не превышен.')
    }
  } catch (e) { console.error(`Ошибка очистки: ${e.message}`) }

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
