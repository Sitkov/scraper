import { chromium } from 'playwright'
import fs from 'fs'

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '')
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim()

function getFreshness(title) {
    const months = {'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'мая': 4, 'июня': 5, 'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11};
    const match = title.match(/(\d{1,2})\s+([а-яё]+)/i);
    if (!match) return false;
    
    const day = parseInt(match[1]);
    const month = months[match[2].toLowerCase()];
    const now = new Date();
    const newsDate = new Date(now.getFullYear(), month, day);
    
    // Если новость старше 2 дней - она нам не интересна
    const diffDays = (now - newsDate) / (1000 * 3600 * 24);
    return diffDays < 2; 
}

async function main() {
    const browser = await chromium.launch();
    const context = await browser.newContext({ storageState: fs.existsSync('state.json') ? 'state.json' : undefined, acceptDownloads: true });
    const page = await context.newPage();

    try {
        console.log('Проверка новостей...');
        await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 60000 });
        const links = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h)))));

        let lastTitle = null;

        for (const url of links.slice(0, 5)) { // Смотрим только первые 5
            const p = await context.newPage();
            try {
                await p.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
                const title = (await p.innerText('h1, h2, .title').catch(() => '')).trim();
                
                // ФИЛЬТР: Только изменения + Только свежие (до 2 дней)
                if (title.toLowerCase().includes('изменени') && getFreshness(title)) {
                    const pdfSelector = 'a[href*=".pdf"], a[href*="/download/"]';
                    if (await p.$(pdfSelector)) {
                        const download = await Promise.all([p.waitForEvent('download'), p.click(pdfSelector)]).then(v => v[0]);
                        const buf = fs.readFileSync(await download.path());
                        
                        const upRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, { data: { pass: ADMIN_PASS, data: buf.toString('base64'), name: `change_${Date.now()}` } });
                        const up = await upRes.json().catch(() => ({}));
                        
                        if (up.ok && up.url) {
                            const addRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                                data: { pass: ADMIN_PASS, title: `📅 ${title}`, url: up.url, source: url }
                            });
                            const add = await addRes.json().catch(() => ({}));
                            if (add.added) {
                                console.log(`Добавлено: ${title}`);
                                lastTitle = title; // Запоминаем последнюю реально добавленную
                            }
                        }
                    }
                }
            } catch (e) {}
            await p.close();
        }

        // РАССЫЛКА ОДИН РАЗ В КОНЦЕ
        if (lastTitle) {
            await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n\n📅 ${lastTitle}` }
            });
        }

    } catch (err) { console.error(err.message); }

    // Очистка старья на сервере (запускать всегда)
    await context.request.get(`${SITE_BASE_RAW}/admin_auto_cleanup.php`, { params: { pass: ADMIN_PASS } }).catch(() => {});
    await browser.close();
}
main();
