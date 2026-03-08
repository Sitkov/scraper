import { chromium } from 'playwright'
import fs from 'fs'

console.log('--- ЗАПУСК СКРИПТА (ВЕРСИЯ: ФОТО ИЗ ПДФ) ---');

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
        viewport: { width: 1000, height: 1400 } // Размер листа А4 примерно
    });

    // ХИТРОСТЬ: Перехватываем PDF и заставляем браузер его ПОКАЗАТЬ, а не скачать
    await context.route('**/*', async route => {
        const response = await route.fetch();
        const headers = response.headers();
        delete headers['content-disposition']; // Удаляем принудительное скачивание
        await route.fulfill({ response, headers });
    });

    const page = await context.newPage();

    try {
        console.log('Загрузка портала...');
        await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000); 

        const links = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            return Array.from(new Set(anchors.map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h))));
        });
        
        let foundNews = [];
        for (const url of links.slice(0, 8)) {
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
            const p = await context.newPage();
            try {
                console.log(`Открываю документ для фото: ${item.url}`);
                
                // Переходим на PDF. Благодаря нашему route выше, он откроется как страница
                await p.goto(item.url, { waitUntil: 'networkidle', timeout: 45000 });
                await p.waitForTimeout(4000); // Даем время рендеру PDF

                const prettyTitle = formatRussianTitle(item.title);
                const fileKey = `ch_${Date.now()}`;

                // Делаем скриншот центральной части, где само расписание
                const screenshotBuf = await p.screenshot({ type: 'png', fullPage: false });

                // Скачиваем сам PDF для архива
                const pdfResp = await context.request.get(item.url);
                const pdfBuf = await pdfResp.body();

                // 1. Грузим PDF
                await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, {
                    data: { pass: ADMIN_PASS, data: pdfBuf.toString('base64'), name: fileKey, ext: 'pdf' }
                });

                // 2. Грузим Фото (PNG)
                const imgRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, {
                    data: { pass: ADMIN_PASS, data: screenshotBuf.toString('base64'), name: fileKey, ext: 'png' }
                });
                const imgUp = await imgRes.json().catch(() => ({}));

                if (imgUp.ok) {
                    const addRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                        data: { pass: ADMIN_PASS, title: prettyTitle, url: '/api/files/' + fileKey + '.pdf', source: item.newsUrl, img_url: imgUp.url }
                    });
                    const add = await addRes.json().catch(() => ({}));
                    if (add.added) {
                        console.log(`✅ ДОБАВЛЕНО С ФОТО: ${prettyTitle}`);
                        lastPrettyTitle = prettyTitle;
                        lastImgUrl = imgUp.url;
                    }
                }
            } catch (e) { console.log(`Ошибка на этапе создания фото: ${e.message}`); }
            await p.close();
        }

        if (lastPrettyTitle && lastImgUrl) {
            await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n\n${lastPrettyTitle}`, img_url: lastImgUrl }
            });
        }
    } catch (err) { console.error('Ошибка:', err.message); }

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

    await browser.close();
    console.log('--- РАБОТА ЗАВЕРШЕНА ---');
}

main().catch(e => { console.error(e); process.exit(1); });
