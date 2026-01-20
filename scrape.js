import { chromium } from 'playwright'
import fs from 'fs'

console.log('--- ЗАПУСК СКРИПТА (ВЕРСИЯ: ГЛУБОКИЙ ПОИСК И ДЕБАГ) ---');

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '')
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim()
const MAX_KEEP      = 3;

function formatRussianTitle(title) {
    try {
        const months = {'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'мая': 4, 'июня': 5, 'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11};
        const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
        const match = title.match(/(\d{1,2})\s+([а-яё]+)/i);
        if (match) {
            const dayNum = parseInt(match[1]);
            const monthStr = match[2].toLowerCase();
            if (months.hasOwnProperty(monthStr)) {
                const now = new Date();
                const dateObj = new Date(now.getFullYear(), months[monthStr], dayNum);
                return `📅 ${days[dateObj.getDay()]} - ${dayNum} ${monthStr}`;
            }
        }
    } catch (e) {}
    return `📅 ${title}`;
}

function getFreshness(title) {
    const months = {'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'мая': 4, 'июня': 5, 'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11};
    const match = title.match(/(\d{1,2})\s+([а-яё]+)/i);
    if (!match) return false;
    const day = parseInt(match[1]);
    const month = months[match[2].toLowerCase()];
    const newsDate = new Date(new Date().getFullYear(), month, day);
    const diffDays = (new Date() - newsDate) / (1000 * 3600 * 24);
    // Пропускаем если новость из будущего (даты > сегодня) или не старее 3 дней
    return diffDays < 3; 
}

async function parseResponse(response, label) {
    const text = await response.text();
    try { return JSON.parse(text); } catch (e) { return { ok: false }; }
}

async function main() {
    const browser = await chromium.launch();
    const context = await browser.newContext({ storageState: fs.existsSync('state.json') ? 'state.json' : undefined, acceptDownloads: true });
    const page = await context.newPage();

    try {
        console.log('Загрузка портала...');
        await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 60000 });
        
        // Берем больше ссылок, чтобы не пропустить из-за объявлений
        const links = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h)))));
        console.log(`Всего новостей на странице: ${links.length}`);

        let lastPrettyTitle = null;

        // Проверяем первые 15 новостей
        for (const url of links.slice(0, 15)) {
            const p = await context.newPage();
            try {
                await p.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
                const title = (await p.innerText('h1, h2, .title, .news-title').catch(() => '')).trim();
                
                if (!title.toLowerCase().includes('изменени')) {
                    console.log(`[Пропуск] Не расписание: "${title}"`);
                } else if (!getFreshness(title)) {
                    console.log(`[Пропуск] Старая новость: "${title}"`);
                } else {
                    const pdfSelector = 'a[href*=".pdf"], a[href*="/download/"], a[href*="attachment"]';
                    const pdfElement = await p.$(pdfSelector);
                    
                    if (pdfElement) {
                        const prettyTitle = formatRussianTitle(title);
                        const download = await (async () => {
                            const [d] = await Promise.all([p.waitForEvent('download'), p.click(pdfSelector)]);
                            return d;
                        })();
                        
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
                                    console.log(`✅ ДОБАВЛЕНО: ${prettyTitle}`);
                                    lastPrettyTitle = prettyTitle;
                                } else {
                                    console.log(`[Ок] Уже есть на сайте: ${prettyTitle}`);
                                }
                            }
                        }
                    } else {
                        console.log(`[⚠️ Ошибка] В новости "${title}" не найден файл PDF!`);
                    }
                }
            } catch (e) {
                console.log(`[Ошибка] Не удалось открыть ${url}`);
            }
            await p.close();
        }

        if (lastPrettyTitle) {
            await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n\n${lastPrettyTitle}` }
            });
        }

    } catch (err) { console.error('Критическая ошибка:', err.message); }

    // Чистка сайта (MAX 3)
    try {
        const listRes = await context.request.get(`${SITE_BASE_RAW}/admin_change_list.php`, { params: { pass: ADMIN_PASS } });
        const data = await listRes.json();
        if (data.items && data.items.length > MAX_KEEP) {
            const toDelete = data.items.sort((a, b) => b.id - a.id).slice(MAX_KEEP);
            for (const it of toDelete) {
                await context.request.post(`${SITE_BASE_RAW}/admin_change_delete.php`, { data: { pass: ADMIN_PASS, id: it.id } });
                console.log(`Удалено из базы: ${it.title}`);
            }
        }
    } catch (e) {}

    await context.request.get(`${SITE_BASE_RAW}/admin_auto_cleanup.php`, { params: { pass: ADMIN_PASS } }).catch(() => {});
    await browser.close();
    console.log('--- РАБОТА ЗАВЕРШЕНА ---');
}
main();
