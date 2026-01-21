import { chromium } from 'playwright'
import fs from 'fs'

console.log('--- ЗАПУСК СКРИПТА (ВЕРСИЯ: КАЛЕНДАРНАЯ СОРТИРОВКА) ---');

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '')
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim()
const MAX_KEEP      = 3;

const monthsMap = {'янв':1, 'фев':2, 'мар':3, 'апр':4, 'мая':5, 'июн':6, 'июл':7, 'авг':8, 'сен':9, 'окт':10, 'ноя':11, 'дек':12};
const monthsArr = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const daysArr = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

// Функция вычисления "веса" даты для сравнения (21 января = 121)
function getDateWeight(title) {
    let match = title.match(/(\d{1,2})\s+([а-яё]+)/i);
    if (match) {
        const d = parseInt(match[1]);
        const m = monthsMap[match[2].toLowerCase().slice(0, 3)] || 0;
        return (m * 100) + d;
    }
    match = title.match(/(\d{1,2})\.(\d{1,2})/);
    if (match) {
        return (parseInt(match[2]) * 100) + parseInt(match[1]);
    }
    return 0;
}

function formatRussianTitle(title) {
    let match = title.match(/(\d{1,2})\s+([а-яё]+)/i) || title.match(/(\d{1,2})\.(\d{1,2})/);
    if (match) {
        const d = parseInt(match[1]);
        const m = (match[2].length <= 2) ? parseInt(match[2]) : (monthsMap[match[2].toLowerCase().slice(0, 3)]);
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
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    try {
        console.log('Загрузка портала...');
        await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        
        const links = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h)))));
        
        let foundNews = [];

        // 1. Сначала просто собираем данные о всех подходящих новостях
        for (const url of links.slice(0, 10)) {
            const p = await context.newPage();
            try {
                await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
                const title = (await p.innerText('h1, h2, .title').catch(() => '')).trim();
                
                if (title.toLowerCase().includes('изменени')) {
                    const pdfSelector = 'a[href*=".pdf"], a[href*="/download/"], a[href*="attachment"]';
                    const hasPdf = await p.$(pdfSelector);
                    if (hasPdf) {
                        foundNews.push({
                            title,
                            url,
                            pdfSelector,
                            weight: getDateWeight(title),
                            page: p // Оставляем страницу открытой на время скачивания
                        });
                        continue; // Не закрываем страницу пока что
                    }
                }
            } catch (e) {}
            await p.close();
        }

        // 2. Сортируем найденное по дате (от старых к новым)
        foundNews.sort((a, b) => a.weight - b.weight);

        let addedCount = 0;
        let lastAddedPrettyTitle = null;

        // 3. Добавляем на сайт в правильном порядке
        for (const item of foundNews) {
            try {
                const download = await Promise.all([item.page.waitForEvent('download'), item.page.click(item.pdfSelector)]).then(v => v[0]);
                const buf = fs.readFileSync(await download.path());
                const prettyTitle = formatRussianTitle(item.title);

                const upRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, { data: { pass: ADMIN_PASS, data: buf.toString('base64'), name: `change_${Date.now()}` } });
                const up = await upRes.json().catch(() => ({}));

                if (up.ok && up.url) {
                    const addRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                        data: { pass: ADMIN_PASS, title: prettyTitle, url: up.url, source: item.url }
                    });
                    const add = await addRes.json().catch(() => ({}));
                    if (add.added) {
                        console.log(`✅ Добавлено: ${prettyTitle}`);
                        lastAddedPrettyTitle = prettyTitle;
                        addedCount++;
                    }
                }
            } catch (e) { console.log('Ошибка при добавлении', e.message); }
            await item.page.close();
        }

        // 4. Оповещение: только одно, о самой последней дате
        if (lastAddedPrettyTitle) {
            await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n\n${lastAddedPrettyTitle}` }
            });
        }

    } catch (err) { console.error('Ошибка главной:', err.message); }

    // 5. ЖЕСТКАЯ ОЧИСТКА САЙТА (по календарному весу)
    try {
        const listRes = await context.request.get(`${SITE_BASE_RAW}/admin_change_list.php`, { params: { pass: ADMIN_PASS } });
        const data = await listRes.json();
        if (data.items && data.items.length > MAX_KEEP) {
            // Сортируем всё что на сайте по весу даты
            const itemsWithWeight = data.items.map(it => ({ ...it, weight: getDateWeight(it.title) }));
            itemsWithWeight.sort((a, b) => b.weight - a.weight); // Новые (большой вес) в начале

            const toDelete = itemsWithWeight.slice(MAX_KEEP);
            for (const it of toDelete) {
                await context.request.post(`${SITE_BASE_RAW}/admin_change_delete.php`, { data: { pass: ADMIN_PASS, id: it.id } });
                console.log(`🗑 Удалено старое расписание: ${it.title}`);
            }
        }
    } catch (e) {}

    await context.request.get(`${SITE_BASE_RAW}/admin_auto_cleanup.php`, { params: { pass: ADMIN_PASS } }).catch(() => {});
    await browser.close();
}
main();
