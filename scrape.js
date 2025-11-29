// scrape.js (ESM) — Playwright + ЕСИА (state.json) + только «Изменения в расписании»
import { chromium } from 'playwright'
import fs from 'fs'

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
const SITE_BASE  = process.env.SITE_BASE
const ADMIN_PASS = process.env.ADMIN_PASS

const DEBUG = process.argv.includes('--debug')
const SEEN_FILE = 'seen.json'

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
  if (DEBUG) console.log('Нашли карточек:', links.length)

  const toProcess = links.filter(h => !seen.ids.includes(h))
  if (!toProcess.length) { if (DEBUG) console.log('Новых нет'); await browser.close(); return }

  const collected = []
  for (const url of toProcess.slice(0, 20)) {
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
      if (DEBUG) console.log(pdf ? `PDF: ${title} -> ${pdf}` : `PDF не найден на ${url}`)
    } catch (e) { if (DEBUG) console.log('Ошибка карточки:', url, e.message) }
  }

  const found = collected.filter(it => it.url && INCLUDE_RE.test(it.title || '') && !EXCLUDE_RE.test(it.title || ''))
  if (!found.length) { if (DEBUG) console.log('Подходящих нет'); await browser.close(); return }

  // уже добавленные
  let existing = []
  try {
    const r = await context.request.get(`${SITE_BASE}/api/admin/change_list`, { params: { pass: ADMIN_PASS } })
    const j = await r.json(); existing = Array.isArray(j.items) ? j.items : []
  } catch {}
  const existingUrls = new Set(existing.map(it => (it.url || '').trim()))
  const toAdd = found.filter(it => !existingUrls.has((it.url || '').trim()))
  if (!toAdd.length) { if (DEBUG) console.log('Нет новых после фильтра'); await browser.close(); return }

  for (const it of toAdd) {
    try {
      const addRes = await context.request.post(`${SITE_BASE}/api/admin/change_add`, { data: { pass: ADMIN_PASS, title: it.title, url: it.url } })
      if (!addRes.ok()) { if (DEBUG) console.log('ADD failed', addRes.status()); continue }
      if (DEBUG) console.log('ADD ok:', it.title)
      await new Promise(r => setTimeout(r, 1200))
      await context.request.post(`${SITE_BASE}/api/admin/broadcast`, { data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n${it.title}` } })
      seen.ids = Array.from(new Set(seen.ids.concat([it.newsUrl]))); saveSeen(seen)
    } catch (e) { if (DEBUG) console.log('Ошибка отправки', it.title, e.message) }
  }

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
