// scrape.js (ESM) — Playwright + PHP API
// Сохраняет только 3 последние записи, остальные удаляет.

import { chromium } from 'playwright'
import fs from 'fs'

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
const SITE_BASE  = process.env.SITE_BASE  // Ссылка до папки /api/
const ADMIN_PASS = process.env.ADMIN_PASS

const DEBUG = process.argv.includes('--debug')
const SEEN_FILE = 'seen.json'
const MAX_KEEP = 3; // ОСТАВЛЯЕМ ТОЛЬКО 3 ЗАПИСИ

const INCLUDE_RE = /(изменени[яе]\s+в\s+расписани[ие])/i
const EXCLUDE_RE = /(экзамен|экзаменац|сесс(ия|ии)|олимпиад|конкурс)/i

const loadJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return fb } }
const saveJson = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf-8')
const loadSeen = () => loadJson(SEEN_FILE, { ids: [] })
const saveSeen = (s) => saveJson(SEEN_FILE, s)

async function extractPdfUrl(page) {
  const href = await page.evaluate(() => {
    const pdfRe = /\.pdf($|\?)/i
    const as = Array.from(document.querySelectorAll('a[href]'))
    const a1 = as.find(a => pdfRe.test(a.href))
    if (a1) return a1.href
    const a2 = as.find(a => /\/(media|files|download|news\/download)\//i.test(a.href))
    return a2 ? a2.href : ''
  })
  if (href) return href

  const frameSrc = await page.evaluate(() => {
    const pick = (sel, attr) => { const el = document.querySelector(sel); return el ? el.getAttribute(attr) || '' : '' }
    return pick('iframe[src*=".pdf"]', 'src') || pick('embed[src*=".pdf"]', 'src') || pick('object[data*=".pdf"]', 'data') || ''
  })
  if (frameSrc) return frameSrc

  let pdf = ''
  const onResp = resp => { try { const ct=(resp.headers()['content-type']||'').toLowerCase(); if (ct.includes('application/pdf')) pdf = resp.url() } catch {} }
  page.on('response', onResp)
  await page.waitForTimeout(1200)
  page.off('response', onResp)
  return pdf || ''
}

async function discoverNewsLinks(page) {
  let links = await page.evaluate(() => {
    const as = Array.from(document.querySelectorAll('a[href]'))
    return as.map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h))
  })
  if (links.length < 5) {
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 1200)
      await page.waitForTimeout(1200)
      const more = await page.evaluate(() => {
        const as = Array.from(document.querySelectorAll('a[href]'))
        return as.map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h))
      })
      links = Array.from(new Set(links.concat(more)))
    }
  }
  return Array.from(new Set(links))
}

async function main() {
  if (!SITE_BASE || !ADMIN_PASS) { console.error('Missing SITE_BASE/ADMIN_PASS env'); process.exit(1) }

  const seen = loadSeen()
  const browser = await chromium.launch()
  const context = await browser.newContext({ storageState: 'state.json' })
  const page = await context.newPage()

  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)

  const links = await discoverNewsLinks(page)
  const toProcess = links.filter(h => !seen.ids.includes(h))

  const collected = []
  if (toProcess.length > 0) {
    for (const url of toProcess.slice(0, 5)) {
      try {
        const p = await context.newPage()
        await p.goto(url, { waitUntil: 'domcontentloaded' })
        await p.waitForTimeout(1500)
        const title = await p.evaluate(() => {
          const el = document.querySelector('h1,h2,.title,.news-title')
          return (el?.textContent || document.title || 'Изменение').trim()
        })
        const pdf = await extractPdfUrl(p)
        await p.close()
        collected.push({ title, url: pdf, newsUrl: url })
      } catch (e) {}
    }
  }

  // Фильтр только нужных новостей
  const found = collected.filter(it => it.url && INCLUDE_RE.test(it.title || '') && !EXCLUDE_RE.test(it.title || ''))
  
  // Добавление новых
  if (found.length > 0) {
    for (const it of found) {
      try {
        const pdfResp = await context.request.get(it.url)
        if (!pdfResp.ok()) continue
        const buf = await pdfResp.body()

        const b64 = Buffer.from(buf).toString('base64')
        const upRes = await context.request.post(`${SITE_BASE}/admin_upload_pdf.php`, {
          data: { pass: ADMIN_PASS, data: b64, name: `change_${Date.now()}` }
        })
        const up = await upRes.json()
        if (!up.ok) continue

        const addRes = await context.request.post(`${SITE_BASE}/admin_change_add.php`, {
          data: { pass: ADMIN_PASS, title: it.title, url: up.url, source: it.newsUrl }
        })
        const add = await addRes.json()

        if (add.ok && add.added) {
          console.log('ДОБАВЛЕНО:', it.title)
          await context.request.post(`${SITE_BASE}/admin_broadcast.php`, {
            data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n${it.title}` }
          }).catch(() => {})
        }
        seen.ids.push(it.newsUrl)
      } catch (e) { console.log('Ошибка при добавлении:', e.message) }
    }
    saveSeen(seen)
  }

  // --- БЛОК ОЧИСТКИ (ОСТАВЛЯЕМ ТОЛЬКО 3 ЗАПИСИ) ---
  try {
    if (DEBUG) console.log('Проверка лимита записей...')
    const listRes = await context.request.get(`${SITE_BASE}/admin_change_list.php`, { params: { pass: ADMIN_PASS } })
    const data = await listRes.json()
    let items = Array.isArray(data.items) ? data.items : []

    // Сортируем: новые ID (таймстампы) всегда больше, значит будут первыми
    items.sort((a, b) => (b.id || 0) - (a.id || 0))

    if (items.length > MAX_KEEP) {
      const toDelete = items.slice(MAX_KEEP) // Берем всё что после 3-го элемента
      console.log(`Лимит превышен. Удаляю ${toDelete.length} старых записей...`)
      
      for (const item of toDelete) {
        const delRes = await context.request.post(`${SITE_BASE}/admin_change_delete.php`, {
          data: { pass: ADMIN_PASS, id: item.id }
        })
        const res = await delRes.json()
        if (res.ok) console.log(`Удалено: ${item.title} (ID: ${item.id})`)
      }
    } else {
      if (DEBUG) console.log('Записей 3 или меньше, удаление не требуется.')
    }
  } catch (e) { console.error('Ошибка в блоке очистки:', e.message) }

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
