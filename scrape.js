import { chromium } from 'playwright'
import fs from 'fs'

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '')
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim()

function parseNewsDate(title) {
    let match = title.match(/(\d{1,2})\s+([а-яё]+)/i) || title.match(/(\d{1,2})\.(\d{1,2})/);
    return match ? (parseInt(match[2].length <= 2 ? match[2] : 1) * 100 + parseInt(match[1])) : 0;
}

async function main() {
    const browser = await chromium.launch();
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    try {
        await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const links = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h)))));
        
        let foundNews = [];
        for (const url of links.slice(0, 5)) {
            const p = await context.newPage();
            try {
                await p.goto(url, { waitUntil: 'domcontentloaded' });
                const title = (await p.innerText('h1, h2, .title').catch(() => '')).trim();
                if (title.toLowerCase().includes('изменени')) {
                    const pdfLink = await p.getAttribute('a[href*=".pdf"], a[href*="/download/"]', 'href');
                    if (pdfLink) foundNews.push({ title, url: pdfLink.startsWith('http') ? pdfLink : new URL(pdfLink, DASHBOARD_URL).href, newsUrl: url });
                }
            } catch (e) {}
            await p.close();
        }

        for (const item of foundNews) {
            const p = await context.newPage();
            try {
                await p.goto(item.url, { waitUntil: 'networkidle' });
                await p.waitForTimeout(5000); 

                // Определяем высоту контента, чтобы порезать на страницы
                const fullHeight = await p.evaluate(() => document.body.scrollHeight);
                const pageHeight = 1200; // Высота одной "страницы"
                const pageCount = Math.ceil(fullHeight / pageHeight);
                const images = [];

                for (let i = 0; i < pageCount; i++) {
                    const fileKey = `img_${Date.now()}_p${i}`;
                    const buf = await p.screenshot({ 
                        type: 'png', 
                        clip: { x: 0, y: i * pageHeight, width: 1000, height: Math.min(pageHeight, fullHeight - i * pageHeight) } 
                    });

                    const imgRes = await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, {
                        data: { pass: ADMIN_PASS, data: buf.toString('base64'), name: fileKey, ext: 'png' }
                    });
                    const up = await imgRes.json();
                    if (up.ok) images.push(up.url);
                }

                if (images.length > 0) {
                    await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                        data: { pass: ADMIN_PASS, title: item.title, url: item.url, source: item.newsUrl, images: images }
                    });
                    // Уведомление шлем только для последней найденной новости
                    await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                        data: { pass: ADMIN_PASS, text: `🔔 Новое изменение!\n\n${item.title}`, change_id: images[0].match(/\d+/)[0] }
                    });
                }
            } catch (e) { console.log(e.message); }
            await p.close();
        }
    } catch (err) { console.error(err.message); }
    await browser.close();
}
main();
