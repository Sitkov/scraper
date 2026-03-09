import { chromium } from 'playwright';
import fs from 'fs';

console.log('--- ЗАПУСК СКРИПТА (SMART LIST VERSION) ---');

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard';
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '');
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim();
const MAX_KEEP      = 5; // Увеличим до 5, чтобы в списке было что выбрать

const monthsMap = {'янв':1, 'фев':2, 'мар':3, 'апр':4, 'мая':5, 'июн':6, 'июл':7, 'авг':8, 'сен':9, 'окт':10, 'ноя':11, 'дек':12};
const monthsArr =['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const daysArr =['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

function parseNewsDate(title) {
    let match = title.match(/(\d{1,2})\s+([а-яё]+)/i) || title.match(/(\d{1,2})\.(\d{1,2})/);
    if (!match) return 0;
    const d = parseInt(match[1]);
    const m = (match[2].length <= 2) ? parseInt(match[2]) : (monthsMap[match[2].toLowerCase().slice(0, 3)] || 0);
    return (m * 100) + d;
}

function formatRussianTitle(title) {
    let match = title.match(/(\d{1,2})\s+([а-яё]+)/i) || title.match(/(\d{1,2})\.(\d{1,2})/);
    if (match) {
        const d = parseInt(match[1]);
        const m = (match[2].length <= 2) ? parseInt(match[2]) : (monthsMap[match[2].toLowerCase().slice(0, 3)] || 1);
        const dateObj = new Date(new Date().getFullYear(), m - 1, d);
        return `${daysArr[dateObj.getDay()]} - ${d} ${monthsArr[m - 1]}`;
    }
    return title;
}

async function main() {
    const browser = await chromium.launch();
    const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1000, height: 1200 } });
    if (fs.existsSync('state.json')) await context.storageState({path: 'state.json'});
    const page = await context.newPage();

    try {
        await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const links = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('a[href*="/news/show/"]')).map(a => a.href))));
        
        let foundNews = [];
        for (const url of links.slice(0, 5)) {
            const p = await context.newPage();
            try {
                await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                const title = (await p.innerText('h1, h2, .title').catch(() => '')).trim();
                if (title.toLowerCase().includes('изменени')) {
                    const pdfLink = await p.getAttribute('a[href*=".pdf"], a[href*="/download/"]', 'href');
                    if (pdfLink) {
                        foundNews.push({ title, url: new URL(pdfLink, DASHBOARD_URL).href, newsUrl: url });
                    }
                }
            } catch (e) {}
            await p.close();
        }

        foundNews.sort((a, b) => parseNewsDate(a.title) - parseNewsDate(b.title));

        for (const item of foundNews) {
            const prettyTitle = formatRussianTitle(item.title);
            const pdfResp = await context.request.get(item.url);
            const pdfBuf = await pdfResp.body();

            const p = await context.newPage();
            await p.setViewportSize({ width: 1000, height: 1000 });
            await p.setContent(`
                <html><head><script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script></head>
                <body style="margin:0;background:#fff"><div id="v"></div><script>
                    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                    pdfjsLib.getDocument({data: atob("${pdfBuf.toString('base64')}")}).promise.then(async (pdf) => {
                        const page = await pdf.getPage(1);
                        const vp = page.getViewport({scale: 2.0});
                        const canvas = document.createElement('canvas');
                        canvas.width = vp.width; canvas.height = vp.height;
                        document.getElementById('v').appendChild(canvas);
                        await page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
                        document.body.classList.add('ready');
                    });
                </script></body></html>
            `);

            await p.waitForSelector('.ready', { timeout: 60000 });
            const fullImg = await p.screenshot({ type: 'jpeg', quality: 85, fullPage: true });
            const thumbImg = await p.screenshot({ type: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: 1000, height: 600 } });
            await p.close();

            const fileKey = `ch_${Date.now()}`;
            const uploadUrl = `${SITE_BASE_RAW}/admin_upload_pdf.php?pass=${encodeURIComponent(ADMIN_PASS)}`;
            
            await context.request.post(uploadUrl, { data: { pass: ADMIN_PASS, data: pdfBuf.toString('base64'), name: fileKey, ext: 'pdf' } });
            const imgRes = await context.request.post(uploadUrl, { data: { pass: ADMIN_PASS, data: fullImg.toString('base64'), name: fileKey, ext: 'jpg' } });
            await context.request.post(uploadUrl, { data: { pass: ADMIN_PASS, data: thumbImg.toString('base64'), name: fileKey + '_thumb', ext: 'jpg' } });
            
            const imgUp = await imgRes.json().catch(() => ({}));
            if (imgUp.ok) {
                await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                    data: { 
                        pass: ADMIN_PASS, title: prettyTitle, url: '/api/files/' + fileKey + '.pdf', 
                        source: item.newsUrl, img_url: imgUp.url, thumb_url: imgUp.url.replace('.jpg', '_thumb.jpg') 
                    }
                });
            }
        }

        // В конце один раз вызываем рассылку для самой свежей новости
        if (foundNews.length > 0) {
            const last = foundNews[foundNews.length - 1];
            await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                data: { pass: ADMIN_PASS, text: formatRussianTitle(last.title) }
            });
        }

    } catch (err) { console.error('Критическая ошибка:', err.message); }
    await browser.close();
    console.log('--- СКРИПТ УСПЕШНО ЗАВЕРШЕН ---');
}
main();
