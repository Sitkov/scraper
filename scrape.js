import { chromium } from 'playwright'
import fs from 'fs'

console.log('--- ЗАПУСК СКРИПТА (УНИВЕРСАЛЬНЫЙ ПАРСЕР ДАТ) ---');

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '')
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim()
const MAX_KEEP      = 3;

const monthsArr = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const daysArr = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

function parseNewsDate(title) {
    let match = title.match(/(\d{1,2})\s+([а-яё]+)/i);
    if (match) {
        const day = parseInt(match[1]);
        const monthStr = match[2].toLowerCase();
        const monthIdx = monthsArr.findIndex(m => monthStr.startsWith(m.slice(0, 3)));
        if (monthIdx !== -1) return { day, month: monthIdx };
    }
    match = title.match(/(\d{1,2})\.(\d{1,2})/);
    if (match) {
        return { day: parseInt(match[1]), month: parseInt(match[2]) - 1 };
    }
    return null;
}

function formatRussianTitle(title) {
    const dateInfo = parseNewsDate(title);
    if (dateInfo) {
        const now = new Date();
        const dateObj = new Date(now.getFullYear(), dateInfo.month, dateInfo.day);
        const dayName = daysArr[dateObj.getDay()];
        return `📅 ${dayName} - ${dateInfo.day} ${monthsArr[dateInfo.month]}`;
    }
    return `📅 ${title}`;
}

function getFreshness(title) {
    const dateInfo = parseNewsDate(title);
    if (!dateInfo) return true;
    const now = new Date();
    const newsDate = new Date(now.getFullYear(), dateInfo.month, dateInfo.day);
    const diffDays = Math.abs(now - newsDate) / (1000 * 3600 * 24);
    return diffDays < 3; 
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
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    try {
        console.log('Загрузка портала...');
        // Для главной страницы используем обычную загрузку
        await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        
        const links = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h)))));
        console.log(`Всего новостей: ${links.length}`);

        let lastPrettyTitle = null;

        for (const url of links.slice(0, 10)) {
            const p = await context.newPage();
            try {
                // ПЕРЕШЛИ НА domcontentloaded И УВЕЛИЧИЛИ ТАЙМАУТ
                await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await p.waitForTimeout(2000); // Ждем 2 сек на прогрузку скриптов внутри
                
                const title = (await p.innerText('h1, h2, .title, .news-title').catch(() => '')).trim();
                
                if (!title.toLowerCase().includes('изменени')) {
                    console.log(`[Пропуск] Не расписание: "${title}"`);
                } else if (!getFreshness(title)) {
                    console.log(`[Пропуск] Старая новость: "${title}"`);
                } else {
                    const pdfSelector = 'a[href*=".pdf"], a[href*="/download/"], a[href*="attachment"]';
                    if (await p.$(pdfSelector)) {
                        const prettyTitle = formatRussianTitle(title);
                        console.log(`✅ Нашел PDF в: ${prettyTitle}`);

                        const download = await Promise.all([p.waitForEvent('download'), p.click(pdfSelector)]).then(v => v[0]);
                        const buf = fs.readFileSync(await download.path());
                        
                        if (buf.length > 1000) {
                            const upRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, { data: { pass: ADMIN_PASS, data: buf.toString('base64'), name: `change_${Date.now()}` } });
                            const up = await upRes.json().catch(() => ({}));
                            
                            if (up.ok && up.url) {
                                const addRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                                    data: { pass: ADMIN_PASS, title: prettyTitle, url: up.url, source: url }
                                });
                                const add = await addRes.json().catch(() => ({}));
                                if (add.added) {
                                    console.log(`🚀 ДОБАВЛЕНО: ${prettyTitle}`);
                                    lastPrettyTitle = prettyTitle;
                                } else {
                                    console.log(`[Ок] Уже есть на сайте: ${prettyTitle}`);
                                }
                            }
                        }
                    } else {
                        console.log(`[⚠️] PDF не найден в: ${title}`);
                    }
                }
            } catch (e) { 
                console.log(`[!] Ошибка страницы ${url}: ${e.message.split('\n')[0]}`); 
            }
            await p.close();
        }

        if (lastPrettyTitle) {
            await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n\n${lastPrettyTitle}` }
            });
        }

    } catch (err) { console.error('Критическая ошибка главной:', err.message); }

    // Очистка сайта
    try {
        const listRes = await context.request.get(`${SITE_BASE_RAW}/admin_change_list.php`, { params: { pass: ADMIN_PASS } });
        const data = await listRes.json();
        if (data.items && data.items.length > MAX_KEEP) {
            const toDelete = data.items.sort((a, b) => b.id - a.id).slice(MAX_KEEP);
            for (const it of toDelete) {
                await context.request.post(`${SITE_BASE_RAW}/admin_change_delete.php`, { data: { pass: ADMIN_PASS, id: it.id } });
            }
        }
    } catch (e) {}

    await context.request.get(`${SITE_BASE_RAW}/admin_auto_cleanup.php`, { params: { pass: ADMIN_PASS } }).catch(() => {});
    await browser.close();
}
main();
