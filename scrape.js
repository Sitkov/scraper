import { chromium } from 'playwright'
import fs from 'fs'

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '')
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim()

const monthsMap = {'янв':1, 'фев':2, 'мар':3, 'апр':4, 'мая':5, 'июн':6, 'июл':7, 'авг':8, 'сен':9, 'окт':10, 'ноя':11, 'дек':12};

function getCorrectTitle(rawTitle) {
    const match = rawTitle.match(/(\d{1,2})\s+([а-яё]+)/i);
    if (match) {
        const d = match[1];
        const m = monthsMap[match[2].toLowerCase().slice(0, 3)] || 1;
        const year = new Date().getFullYear();
        const dateObj = new Date(year, m - 1, d);
        const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
        const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
        return `📅 ${days[dateObj.getDay()]} - ${d} ${months[m - 1]}`;
    }
    return rawTitle;
}

async function main() {
    console.log("🚀 Поехали! Загрузка сессии...");
    const browser = await chromium.launch();
    const hasState = fs.existsSync('state.json');
    const context = await browser.newContext({ 
        storageState: hasState ? 'state.json' : undefined,
        deviceScaleFactor: 2 
    });
    const page = await context.newPage();

    try {
        console.log(`🔗 Открываю дашборд...`);
        await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 60000 });
        
        const links = await page.evaluate(() => 
            Array.from(new Set(Array.from(document.querySelectorAll('a[href*="/news/show/"]')).map(a => a.href)))
        );

        console.log(`🔎 Найдено новостей: ${links.length}`);

        for (const url of links.slice(0, 4)) { // Проверяем первые 4 новости
            console.log(`\n🔍 Проверяю: ${url}`);
            const p = await context.newPage();
            await p.goto(url, { waitUntil: 'networkidle' });
            
            const rawTitle = (await p.innerText('h1, h2, .title').catch(() => 'Без заголовка')).trim();
            console.log(`📌 Заголовок: "${rawTitle}"`);
            
            // Расширенный поиск ключевого слова
            const isChange = /изменен/i.test(rawTitle);

            if (isChange) {
                console.log("✅ Это то, что нужно! Ищу PDF...");
                const pdfLink = await p.evaluate(() => document.querySelector('a[href*=".pdf"]')?.href);

                if (pdfLink) {
                    console.log(`📎 Ссылка на PDF: ${pdfLink}`);
                    const pdfResp = await context.request.get(pdfLink);
                    const pdfBuf = await pdfResp.body();
                    const b64Pdf = pdfBuf.toString('base64');
                    const fileKey = `ch_${Date.now()}`;
                    const title = getCorrectTitle(rawTitle);

                    console.log("🎨 Рендеринг изображения...");
                    const renderPage = await context.newPage();
                    await renderPage.setViewportSize({ width: 1000, height: 1200 });
                    await renderPage.setContent(`
                        <html><head><script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script></head>
                        <body style="margin:0; background: white;"><div id="v"></div><script>
                            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                            pdfjsLib.getDocument({data: atob("${b64Pdf}")}).promise.then(async pdf => {
                                const page = await pdf.getPage(1);
                                const vp = page.getViewport({scale: 2.2});
                                const canvas = document.createElement('canvas');
                                canvas.width = vp.width; canvas.height = vp.height;
                                document.getElementById('v').appendChild(canvas);
                                await page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
                                window.ready = true;
                            }).catch(e => { console.error(e); window.ready = "error"; });
                        </script></body></html>
                    `);

                    await renderPage.waitForFunction(() => window.ready, { timeout: 30000 });
                    const imgBuf = await renderPage.screenshot({ type: 'jpeg', quality: 85, fullPage: true });
                    await renderPage.close();

                    console.log("📡 Загрузка на сервер...");
                    await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, { data: { pass: ADMIN_PASS, data: b64Pdf, name: fileKey, ext: 'pdf' } });
                    const imgRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, { data: { pass: ADMIN_PASS, data: imgBuf.toString('base64'), name: fileKey, ext: 'jpg' } });
                    const imgData = await imgRes.json().catch(() => ({}));

                    console.log("📝 Обновление базы...");
                    await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                        data: { pass: ADMIN_PASS, title: title, url: `/api/files/${fileKey}.pdf`, source: url, img_url: imgData.url }
                    });

                    console.log("📢 Отправка уведомления...");
                    await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                        data: { pass: ADMIN_PASS, text: `🔔 <b>${title}</b>` }
                    });
                    console.log("🎉 Готово для этой новости!");
                } else {
                    console.log("❌ В новости нет ссылки на PDF.");
                }
            } else {
                console.log("⏭️ Пропускаю (не про изменения).");
            }
            await p.close();
        }
    } catch (err) {
        console.error("⛔ Ошибка:", err);
    } finally {
        await browser.close();
        console.log("🏁 Скрипт завершил работу.");
    }
}
main();
