import { chromium } from 'playwright'
import fs from 'fs'

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '')
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim()
const MAX_KEEP      = 3;

const monthsMap = {'янв':1, 'фев':2, 'мар':3, 'апр':4, 'мая':5, 'июн':6, 'июл':7, 'авг':8, 'сен':9, 'окт':10, 'ноя':11, 'дек':12};
const monthsArr = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const daysArr = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

function parseNewsDate(title) {
    let match = title.match(/(\d{1,2})\s+([а-яё]+)/i) || title.match(/(\d{1,2})\.(\d{1,2})/);
    if (!match) return 0;
    const d = parseInt(match[1]);
    const m = match[2].length <= 2 ? parseInt(match[2]) : (monthsMap[match[2].toLowerCase().slice(0, 3)] || 0);
    return (m * 100) + d;
}

function formatRussianTitle(title) {
    let match = title.match(/(\d{1,2})\s+([а-яё]+)/i) || title.match(/(\d{1,2})\.(\d{1,2})/);
    if (match) {
        const d = parseInt(match[1]);
        const m = match[2].length <= 2 ? parseInt(match[2]) : monthsMap[match[2].toLowerCase().slice(0, 3)];
        const dateObj = new Date(new Date().getFullYear(), m - 1, d);
        return `📅 ${daysArr[dateObj.getDay()]} - ${d} ${monthsArr[m - 1]}`;
    }
    return `📅 ${title}`;
}

async function main() {
    const browser = await chromium.launch();
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    try {
        await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const links = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h)))));
        
        let foundNews = [];
        for (const url of links.slice(0, 8)) {
            const p = await context.newPage();
            try {
                await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                const title = (await p.innerText('h1, h2, .title').catch(() => '')).trim();
                if (title.toLowerCase().includes('изменени')) {
                    const pdfSelector = 'a[href*=".pdf"], a[href*="/download/"]';
                    if (await p.$(pdfSelector)) {
                        foundNews.push({ title, url, pdfSelector, weight: parseNewsDate(title), page: p });
                        continue; 
                    }
                }
            } catch (e) {}
            await p.close();
        }

        foundNews.sort((a, b) => a.weight - b.weight);

        let lastPrettyTitle = null;
        let lastImgUrl = null;

        for (const item of foundNews) {
            const download = await Promise.all([item.page.waitForEvent('download'), item.page.click(item.pdfSelector)]).then(v => v[0]);
            const pdfPath = await download.path();
            const buf = fs.readFileSync(pdfPath);
            const prettyTitle = formatRussianTitle(item.title);
            const fileKey = `ch_${Date.now()}`;

            // 📸 СКРИНШОТ: Открываем PDF прямо в браузере Playwright
            // (Chrome умеет рендерить PDF, делаем снимок области просмотра)
            await item.page.setViewportSize({ width: 800, height: 1000 });
            const screenshotBuf = await item.page.screenshot({ type: 'png' });

            // 1. Грузим PDF
            const upRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, { data: { pass: ADMIN_PASS, data: buf.toString('base64'), name: fileKey, ext: 'pdf' } });
            const up = await upRes.json().catch(() => ({}));

            // 2. Грузим Скриншот
            const imgRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, { data: { pass: ADMIN_PASS, data: screenshotBuf.toString('base64'), name: fileKey, ext: 'png' } });
            const imgUp = await imgRes.json().catch(() => ({}));

            if (up.ok && up.url) {
                const addRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                    data: { pass: ADMIN_PASS, title: prettyTitle, url: up.url, source: item.url, img_url: imgUp.url || "" }
                });
                const add = await addRes.json().catch(() => ({}));
                if (add.added) {
                    lastPrettyTitle = prettyTitle;
                    lastImgUrl = imgUp.url || "";
                }
            }
            await item.page.close();
        }

        if (lastPrettyTitle) {
            await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n\n${lastPrettyTitle}`, img_url: lastImgUrl }
            });
        }
    } catch (err) { console.error(err.message); }

    // Очистка сайта (оставляем 3)
    try {
        const listRes = await context.request.get(`${SITE_BASE_RAW}/admin_change_list.php`, { params: { pass: ADMIN_PASS } });
        const data = await listRes.json();
        if (data.items && data.items.length > MAX_KEEP) {
            const sorted = data.items.map(it => ({ ...it, w: parseNewsDate(it.title) })).sort((a,b) => b.w - a.w);
            for (const it of sorted.slice(MAX_KEEP)) {
                await context.request.post(`${SITE_BASE_RAW}/admin_change_delete.php`, { data: { pass: ADMIN_PASS, id: it.id } });
            }
        }
    } catch (e) {}

    await context.request.get(`${SITE_BASE_RAW}/admin_auto_cleanup.php`, { params: { pass: ADMIN_PASS } }).catch(() => {});
    await browser.close();
}
main();
