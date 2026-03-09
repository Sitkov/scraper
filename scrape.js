import { chromium } from 'playwright';
import fs from 'fs';

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard';
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '');
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim();

const monthsMap = {'янв':1, 'фев':2, 'мар':3, 'апр':4, 'мая':5, 'июн':6, 'июл':7, 'авг':8, 'сен':9, 'окт':10, 'ноя':11, 'дек':12};
const monthsArr =['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const daysArr =['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

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
    const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1000, height: 1000 } });
    if (fs.existsSync('state.json')) await context.storageState({path:'state.json'});
    const page = await context.newPage();

    try {
        console.log("Поиск новостей...");
        await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const links = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('a[href*="/news/show/"]')).map(a => a.href))));
        
        let lastNewsItem = null;

        for (const url of links.slice(0, 5)) {
            const p = await context.newPage();
            try {
                await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                const title = (await p.innerText('h1, h2, .title').catch(() => '')).trim();
                
                if (title.toLowerCase().includes('изменени')) {
                    const pdfLink = await p.getAttribute('a[href*=".pdf"], a[href*="/download/"]', 'href');
                    if (pdfLink) {
                        const prettyTitle = formatRussianTitle(title);
                        const pdfResp = await context.request.get(new URL(pdfLink, DASHBOARD_URL).href);
                        const pdfBuf = await pdfResp.body();

                        // Генерация скриншотов
                        await p.setViewportSize({ width: 1000, height: 1200 });
                        await p.setContent(`<html><body style="margin:0;background:#fff"><div id="v"></div>
                            <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
                            <script>
                                pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                                pdfjsLib.getDocument({data: atob("${pdfBuf.toString('base64')}")}).promise.then(async pdf => {
                                    const page = await pdf.getPage(1);
                                    const vp = page.getViewport({scale: 2.0});
                                    const canvas = document.createElement('canvas');
                                    canvas.width = vp.width; canvas.height = vp.height;
                                    document.getElementById('v').appendChild(canvas);
                                    await page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
                                    document.body.classList.add('ready');
                                });
                            </script></body></html>`);

                        await p.waitForSelector('.ready', { timeout: 60000 });
                        const fullImg = await p.screenshot({ type: 'jpeg', quality: 85 });
                        const thumbImg = await p.screenshot({ type: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: 1000, height: 500 } });

                        const fileKey = `ch_${Date.now()}`;
                        const uploadUrl = `${SITE_BASE_RAW}/admin_upload_pdf.php?pass=${encodeURIComponent(ADMIN_PASS)}`;
                        
                        await context.request.post(uploadUrl, { data: { pass: ADMIN_PASS, data: pdfBuf.toString('base64'), name: fileKey, ext: 'pdf' } });
                        const imgRes = await context.request.post(uploadUrl, { data: { pass: ADMIN_PASS, data: fullImg.toString('base64'), name: fileKey, ext: 'jpg' } });
                        await context.request.post(uploadUrl, { data: { pass: ADMIN_PASS, data: thumbImg.toString('base64'), name: fileKey + '_thumb', ext: 'jpg' } });
                        
                        const imgUp = await imgRes.json().catch(() => ({}));
                        if (imgUp.ok) {
                            const addRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                                data: { pass: ADMIN_PASS, title: prettyTitle, url: '/api/files/' + fileKey + '.pdf', source: url, img_url: imgUp.url, thumb_url: imgUp.url.replace('.jpg', '_thumb.jpg') }
                            });
                            const addData = await addRes.json().catch(() => ({}));
                            if (addData.is_new) {
                                lastNewsItem = { title: prettyTitle, img_url: imgUp.url };
                            }
                        }
                    }
                }
            } catch (e) { console.log(e); }
            await p.close();
        }

        // РАССЫЛКА (только если нашли новую новость)
        if (lastNewsItem) {
            console.log("Запуск рассылки...");
            await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                data: { pass: ADMIN_PASS, text: lastNewsItem.title, img_url: lastNewsItem.img_url }
            });
        }

    } catch (err) { console.error(err); }
    await browser.close();
}
main();
