import { chromium } from 'playwright'
import fs from 'fs'

console.log('--- ИНИЦИАЛИЗАЦИЯ СКРИПТА (FINAL STABLE VERSION) ---');

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

async function parseResponse(response, label) {
    const text = await response.text();
    try { return JSON.parse(text); } catch (e) { return { ok: false }; }
}

async function main() {
    const browser = await chromium.launch();
    const context = await browser.newContext({ 
        storageState: fs.existsSync('state.json') ? 'state.json' : undefined,
        acceptDownloads: true,
        viewport: { width: 1200, height: 1600 }
    });
    const page = await context.newPage();

    try {
        console.log('Загрузка портала...');
        const response = await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000); 

        console.log(`Страница: ${page.url()}`);
        console.log(`Заголовок: "${await page.title()}"`);

        const links = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            return Array.from(new Set(anchors.map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h))));
        });
        
        console.log(`Найдено ссылок: ${links.length}`);
        
        // Массив для хранения данных новостей перед обработкой
        let foundNews = [];

        for (const url of links.slice(0, 10)) {
            const p = await context.newPage();
            try {
                await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                const title = (await p.innerText('h1, h2, .title').catch(() => '')).trim();
                if (title.toLowerCase().includes('изменени')) {
                    const pdfLink = await p.getAttribute('a[href*=".pdf"], a[href*="/download/"]', 'href');
                    if (pdfLink) {
                        const fullPdfUrl = pdfLink.startsWith('http') ? pdfLink : new URL(pdfLink, DASHBOARD_URL).href;
                        foundNews.push({ title, url: fullPdfUrl, newsUrl: url });
                    }
                }
            } catch (e) {}
            await p.close();
        }

        // Сортировка по календарной дате
        foundNews.sort((a, b) => parseNewsDate(a.title) - parseNewsDate(b.title));

        let lastPrettyTitle = null;
        let lastImgUrl = null;

        for (const item of foundNews) {
            try {
                const prettyTitle = formatRussianTitle(item.title);
                console.log(`Обработка: ${prettyTitle}`);

                const pdfResp = await context.request.get(item.url);
                const pdfBuf = await pdfResp.body();
                const b64Pdf = pdfBuf.toString('base64');

                // Рендеринг в длинную картинку через PDF.js
                const p = await context.newPage();
                await p.setViewportSize({ width: 1000, height: 1000 });
                await p.setContent(`
                    <html><head>
                        <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
                        <style>body{margin:0;background:#fff} canvas{display:block;margin:0 auto;border-bottom:2px solid #ccc}</style>
                    </head><body><div id="v"></div><script>
                        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                        pdfjsLib.getDocument({data: atob("${b64Pdf}")}).promise.then(async (pdf) => {
                            const v = document.getElementById('v');
                            for(let i=1; i<=pdf.numPages; i++) {
                                const page = await pdf.getPage(i);
                                const vp = page.getViewport({scale: 2.0});
                                const canvas = document.createElement('canvas');
                                canvas.width = vp.width; canvas.height = vp.height;
                                v.appendChild(canvas);
                                await page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
                            }
                            document.body.classList.add('ready');
                        });
                    </script></body></html>
                `);

                await p.waitForSelector('.ready', { timeout: 40000 });
                const screenshotBuf = await p.screenshot({ type: 'png', fullPage: true });
                await p.close();

                const fileKey = `ch_${Date.now()}`;
                await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, {
                    data: { pass: ADMIN_PASS, data: b64Pdf, name: fileKey, ext: 'pdf' }
                });
                const imgRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, {
                    data: { pass: ADMIN_PASS, data: screenshotBuf.toString('base64'), name: fileKey, ext: 'png' }
                });
                const imgUp = await imgRes.json();

                if (imgUp.ok) {
                    const addRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                        data: { pass: ADMIN_PASS, title: prettyTitle, url: '/api/files/' + fileKey + '.pdf', source: item.newsUrl, img_url: imgUp.url }
                    });
                    const add = await addRes.json();
                    if (add.added) {
                        console.log(`✅ ДОБАВЛЕНО: ${prettyTitle}`);
                        lastPrettyTitle = prettyTitle;
                        lastImgUrl = imgUp.url;
                    }
                }
            } catch (e) { console.log(`Ошибка: ${e.message}`); }
        }

        if (lastPrettyTitle) {
            await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n\n${lastPrettyTitle}`, img_url: lastImgUrl }
            });
        }
    } catch (err) { console.error('Критическая ошибка:', err.message); }

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
    console.log('--- РАБОТА ЗАВЕРШЕНА ---');
}

main();
