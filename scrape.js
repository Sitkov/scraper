import { chromium } from 'playwright'
import fs from 'fs'

console.log('--- ЗАПУСК СКРИПТА (FINAL VERSION) ---');

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
        const m = (match[2].length <= 2) ? parseInt(match[2]) : monthsMap[match[2].toLowerCase().slice(0, 3)];
        const dateObj = new Date(new Date().getFullYear(), m - 1, d);
        return `📅 ${daysArr[dateObj.getDay()]} - ${d} ${monthsArr[m - 1]}`;
    }
    return `📅 ${title}`;
}

async function main() {
    const browser = await chromium.launch();
    const context = await browser.newContext({ 
        storageState: fs.existsSync('state.json') ? 'state.json' : undefined,
        acceptDownloads: true,
        viewport: { width: 1000, height: 1300 }
    });
    const page = await context.newPage();

    try {
        console.log('Загрузка портала...');
        await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const links = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h)))));
        
        let foundNews = [];
        for (const url of links.slice(0, 10)) {
            const p = await context.newPage();
            try {
                await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                const title = (await p.innerText('h1, h2, .title').catch(() => '')).trim();
                if (title.toLowerCase().includes('изменени')) {
                    const pdfLink = await p.getAttribute('a[href*=".pdf"], a[href*="/download/"]', 'href');
                    if (pdfLink) {
                        foundNews.push({ title, url: pdfLink.startsWith('http') ? pdfLink : new URL(pdfLink, DASHBOARD_URL).href, newsUrl: url });
                    }
                }
            } catch (e) {}
            await p.close();
        }

        // Сортируем от старых к новым
        foundNews.sort((a, b) => parseNewsDate(a.title) - parseNewsDate(b.title));

        let lastPrettyTitle = null;

        for (const item of foundNews) {
            try {
                const pdfResp = await context.request.get(item.url);
                const pdfBuf = await pdfResp.body();
                const b64Pdf = pdfBuf.toString('base64');

                // Создаем скриншоты каждой страницы (нарезаем по 1200px высотой)
                const p = await context.newPage();
                await p.setViewportSize({ width: 1000, height: 1300 });
                await p.setContent(`<html><body style="margin:0;padding:0;overflow:hidden"><embed src="data:application/pdf;base64,${b64Pdf}" type="application/pdf" width="100%" height="100%"></body></html>`);
                await p.waitForTimeout(5000);

                const fullHeight = await p.evaluate(() => document.body.scrollHeight);
                const pageHeight = 1200;
                const pageCount = Math.ceil(fullHeight / pageHeight);
                const imageUrls = [];

                for (let i = 0; i < pageCount; i++) {
                    const screenshotBuf = await p.screenshot({ type: 'png', clip: { x:0, y: i*pageHeight, width: 1000, height: Math.min(pageHeight, fullHeight - i*pageHeight) }});
                    const imgRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, {
                        data: { pass: ADMIN_PASS, data: screenshotBuf.toString('base64'), name: `img_${Date.now()}_p${i}`, ext: 'png' }
                    });
                    const up = await imgRes.json();
                    if (up.ok) imageUrls.push(up.url);
                }
                await p.close();

                const prettyTitle = formatRussianTitle(item.title);
                const fileKey = `ch_${Date.now()}`;

                // Грузим сам PDF
                const upRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, {
                    data: { pass: ADMIN_PASS, data: b64Pdf, name: fileKey, ext: 'pdf' }
                });
                const up = await upRes.json();

                if (up.ok) {
                    const addRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                        data: { pass: ADMIN_PASS, title: prettyTitle, url: up.url, source: item.newsUrl, images: imageUrls }
                    });
                    const add = await addRes.json();
                    if (add.added) {
                        console.log(`✅ ДОБАВЛЕНО: ${prettyTitle}`);
                        lastPrettyTitle = prettyTitle;
                    }
                }
            } catch (e) { console.log(`Ошибка обработки: ${e.message}`); }
        }

        if (lastPrettyTitle) {
            await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n\n${lastPrettyTitle}` }
            });
        }
    } catch (err) { console.error(err.message); }

    // Очистка сайта
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
