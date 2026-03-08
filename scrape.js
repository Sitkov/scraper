import { chromium } from 'playwright'
import fs from 'fs'

console.log('--- ЗАПУСК СКРИПТА (ВЕРСИЯ: ИСПРАВЛЕННЫЕ СКРИНШОТЫ) ---');

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
    const m = (match[2] && match[2].length <= 2) ? parseInt(match[2]) : (monthsMap[match[2].toLowerCase().slice(0, 3)] || 0);
    return (m * 100) + d;
}

function formatRussianTitle(title) {
    let match = title.match(/(\d{1,2})\s+([а-яё]+)/i) || title.match(/(\d{1,2})\.(\d{1,2})/);
    if (match) {
        const d = parseInt(match[1]);
        const m = (match[2] && match[2].length <= 2) ? parseInt(match[2]) : (monthsMap[match[2].toLowerCase().slice(0, 3)] || 1);
        const dateObj = new Date(new Date().getFullYear(), m - 1, d);
        return `📅 ${daysArr[dateObj.getDay()]} - ${d} ${monthsArr[m - 1]}`;
    }
    return `🔔 ${title}`;
}

async function main() {
    const browser = await chromium.launch();
    const hasState = fs.existsSync('state.json');
    console.log(hasState ? "Файл state.json загружен" : "⚠️ ПРЕДУПРЕЖДЕНИЕ: state.json не найден!");

    const context = await browser.newContext({ 
        storageState: hasState ? 'state.json' : undefined,
        acceptDownloads: true,
        deviceScaleFactor: 2, 
        viewport: { width: 1200, height: 1600 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();

    try {
        console.log('Загрузка портала...');
        await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 60000 });

        const currentUrl = page.url();
        const pageTitle = await page.title();

        if (currentUrl.includes('esia.gosuslugi.ru') || pageTitle.includes('вторизац') || pageTitle.includes('Вход')) {
            console.error('❌ ОШИБКА: Авторизация не удалась.');
            await browser.close();
            return;
        }

        await page.waitForSelector('a[href*="/news/show/"]', { timeout: 15000 }).catch(() => {});

        const links = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href*="/news/show/"]'));
            return Array.from(new Set(anchors.map(a => a.href)));
        });
        
        console.log(`Найдено ссылок: ${links.length}`);
        
        let foundNews = [];
        for (const url of links.slice(0, 8)) {
            const p = await context.newPage();
            try {
                await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
                const title = (await p.innerText('h1, h2, .title, .news-title').catch(() => '')).trim();

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

        // Сортируем от старых к новым
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
                // Ставим ширину для мобильных устройств
                await p.setViewportSize({ width: 800, height: 1200 });
                await p.setContent(`
                    <html><head>
                        <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
                        <style>body{margin:0;background:#fff} canvas{display:block;margin:0 auto; max-width: 100%;}</style>
                    </head><body><div id="v"></div><script>
                        const pdfData = atob("${b64Pdf}");
                        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                        pdfjsLib.getDocument({data: pdfData}).promise.then(async (pdf) => {
                            const v = document.getElementById('v');
                            // Рендерим максимум 2 страницы, чтобы не превысить лимит высоты Telegram
                            const pagesToRender = Math.min(pdf.numPages, 2);
                            for(let i=1; i<=pagesToRender; i++) {
                                const page = await pdf.getPage(i);
                                const vp = page.getViewport({scale: 2.0}); 
                                const canvas = document.createElement('canvas');
                                canvas.width = vp.width; canvas.height = vp.height;
                                v.appendChild(canvas);
                                await page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
                            }
                            setTimeout(() => document.body.classList.add('ready'), 500);
                        }).catch(e => { document.body.classList.add('ready'); });
                    </script></body></html>
                `);

                await p.waitForSelector('.ready', { timeout: 30000 });
                
                // Исправленный скриншот: ограничение по высоте
                const screenshotBuf = await p.screenshot({ 
                    type: 'jpeg', 
                    quality: 85, 
                    fullPage: true,
                    clip: { x: 0, y: 0, width: 800, height: Math.min(2500, 2500) } // Жесткий лимит высоты
                });
                await p.close();

                const fileKey = `ch_${Date.now()}`;
                
                // Загружаем PDF
                await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, {
                    data: { pass: ADMIN_PASS, data: b64Pdf, name: fileKey, ext: 'pdf' }
                });
                
                // Загружаем PNG/JPG
                const imgRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, {
                    data: { pass: ADMIN_PASS, data: screenshotBuf.toString('base64'), name: fileKey, ext: 'jpg' }
                });
                
                const imgUp = await imgRes.json().catch(()=>({}));

                if (imgUp.ok) {
                    const addRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                        data: { pass: ADMIN_PASS, title: prettyTitle, url: '/api/files/' + fileKey + '.pdf', source: item.newsUrl, img_url: imgUp.url }
                    });
                    const add = await addRes.json().catch(()=>({}));
                    if (add.added) {
                        console.log(`✅ ДОБАВЛЕНО: ${prettyTitle}`);
                        lastPrettyTitle = prettyTitle;
                        lastImgUrl = imgUp.url;
                    }
                }
            } catch (e) { console.log(`Ошибка: ${e.message}`); }
        }

        if (lastPrettyTitle && lastImgUrl) {
            console.log(`--- ВЫЗОВ РАССЫЛКИ ---`);
            const bRes = await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n\n${lastPrettyTitle}`, img_url: lastImgUrl }
            });
            const bData = await bRes.json().catch(() => ({}));
            console.log(`Отправлено: ${bData.sent || 0}`);
        }
    } catch (err) { console.error('Критическая ошибка:', err.message); }

    // Очистка старых данных
    try {
        const listRes = await context.request.get(`${SITE_BASE_RAW}/admin_change_list.php`, { params: { pass: ADMIN_PASS } });
        const data = await listRes.json();
        if (data.items && data.items.length > MAX_KEEP) {
            const sorted = data.items.sort((a,b) => b.id - a.id);
            for (const it of sorted.slice(MAX_KEEP)) {
                await context.request.post(`${SITE_BASE_RAW}/admin_change_delete.php`, { data: { pass: ADMIN_PASS, id: it.id } });
            }
        }
    } catch (e) {}
    
    await browser.close();
    console.log('--- РАБОТА ЗАВЕРШЕНА ---');
}

main();
