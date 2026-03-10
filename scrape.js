import { chromium } from 'playwright';
import fs from 'fs';

console.log('--- ЗАПУСК СКРИПТА (STABLE + HIGH QUALITY) ---');

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard';
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '');
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim();
const MAX_KEEP      = 3;

const monthsMap = {'янв':1, 'фев':2, 'мар':3, 'апр':4, 'мая':5, 'июн':6, 'июл':7, 'авг':8, 'сен':9, 'окт':10, 'ноя':11, 'дек':12};
const monthsArr =['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const daysArr =['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

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
    
    const contextOptions = { 
        acceptDownloads: true,
        deviceScaleFactor: 2, // Двойная плотность пикселей для Retina-качества
        viewport: { width: 1200, height: 1200 } // Увеличили ширину, чтобы листы не сжимались
    };
    if (fs.existsSync('state.json')) {
        contextOptions.storageState = 'state.json';
        console.log('✅ Куки (state.json) успешно загружены.');
    } else {
        console.log('⚠️ ВНИМАНИЕ: Файл state.json не найден!');
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    try {
        console.log('Загрузка портала...');
        await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000); 

        const links = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            return Array.from(new Set(anchors.map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h))));
        });
        
        console.log(`Найдено ссылок: ${links.length}`);
        let foundNews =[];
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

                const p = await context.newPage();
                await p.setViewportSize({ width: 1200, height: 1000 });
                
                // === КРАСИВЫЙ РЕНДЕР С ТЕНЯМИ И ВЫСОКИМ КАЧЕСТВОМ ===
                await p.setContent(`
                    <html><head>
                        <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
                        <style>
                            /* Серый фон, как в реальных просмотрщиках */
                            body { margin: 0; padding: 40px 20px; background: #e2e8f0; }
                            #v { display: flex; flex-direction: column; align-items: center; gap: 30px; }
                            /* Белые листы с красивыми тенями и скруглениями */
                            canvas { 
                                display: block; 
                                max-width: 100%; 
                                height: auto;
                                background: #fff;
                                box-shadow: 0 10px 25px rgba(0,0,0,0.15); 
                                border-radius: 6px;
                            }
                        </style>
                    </head><body><div id="v"></div><script>
                        const pdfData = atob("${b64Pdf}");
                        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                        pdfjsLib.getDocument({data: pdfData}).promise.then(async (pdf) => {
                            const v = document.getElementById('v');
                            for(let i=1; i<=pdf.numPages; i++) {
                                const page = await pdf.getPage(i);
                                // Масштаб 2.5 дает идеальную резкость текста (раньше было 2.0)
                                const vp = page.getViewport({scale: 2.5}); 
                                const canvas = document.createElement('canvas');
                                canvas.width = vp.width; 
                                canvas.height = vp.height;
                                v.appendChild(canvas);
                                await page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
                            }
                            document.body.classList.add('ready');
                        }).catch(e => { document.body.classList.add('error'); });
                    </script></body></html>
                `);

                await p.waitForSelector('.ready', { timeout: 60000 });
                
                // Качество 92 - золотая середина (идеально для текста, но легкий вес)
                const screenshotBuf = await p.screenshot({ type: 'jpeg', quality: 92, fullPage: true });
                await p.close();

                const fileKey = `ch_${Date.now()}`;
                const uploadUrl = `${SITE_BASE_RAW}/admin_upload_pdf.php?pass=${encodeURIComponent(ADMIN_PASS)}`;
                
                await context.request.post(uploadUrl, {
                    data: { pass: ADMIN_PASS, data: b64Pdf, name: fileKey, ext: 'pdf' }
                });

                const imgRes = await context.request.post(uploadUrl, {
                    data: { pass: ADMIN_PASS, data: screenshotBuf.toString('base64'), name: fileKey, ext: 'jpg' }
                });
                
                let imgUp = {};
                try { imgUp = JSON.parse(await imgRes.text()); } catch(e) {}

                if (imgUp.ok) {
                    const addRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                        data: { pass: ADMIN_PASS, title: prettyTitle, url: '/api/files/' + fileKey + '.pdf', source: item.newsUrl, img_url: imgUp.url }
                    });
                    
                    let add = {};
                    try { add = JSON.parse(await addRes.text()); } catch(e) {}

                    if (add.added && add.is_new) {
                        console.log(`✅ ДОБАВЛЕНО НОВОЕ РАСПИСАНИЕ: ${prettyTitle}`);
                        lastPrettyTitle = prettyTitle;
                        lastImgUrl = imgUp.url;
                    } else if (add.added && !add.is_new) {
                        console.log(`🔄 Уже есть в базе: ${prettyTitle}`);
                    }
                }
            } catch (e) { console.log(`Ошибка при обработке PDF: ${e.message}`); }
        }

        // 4. РАССЫЛКА
        if (lastPrettyTitle && lastImgUrl) {
            console.log(`📨 Отправка рассылки: ${lastPrettyTitle}`);
            const bUrl = `${SITE_BASE_RAW}/admin_broadcast.php?pass=${encodeURIComponent(ADMIN_PASS)}`;
            const bRes = await context.request.post(bUrl, {
                data: { pass: ADMIN_PASS, text: lastPrettyTitle, img_url: lastImgUrl }
            });
            console.log(`ОТВЕТ СЕРВЕРА РАССЫЛКИ:`, await bRes.text());
        }

    } catch (err) { console.error('Критическая ошибка:', err.message); }

    await context.request.get(`${SITE_BASE_RAW}/admin_auto_cleanup.php`, { params: { pass: ADMIN_PASS } }).catch(() => {});
    await browser.close();
    console.log('--- СКРИПТ УСПЕШНО ЗАВЕРШЕН ---');
}

main();
