import { chromium } from 'playwright'
import fs from 'fs'

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '')
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim()

async function main() {
    const browser = await chromium.launch();
    const hasState = fs.existsSync('state.json');
    const context = await browser.newContext({ storageState: hasState ? 'state.json' : undefined });
    const page = await context.newPage();

    try {
        await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle' });
        const links = await page.evaluate(() => {
            return Array.from(new Set(Array.from(document.querySelectorAll('a[href*="/news/show/"]')).map(a => a.href)));
        });
        
        for (const url of links.slice(0, 1)) {
            const p = await context.newPage();
            await p.goto(url, { waitUntil: 'networkidle' });
            const title = (await p.innerText('h1, h2').catch(() => 'Изменения')).trim();
            
            if (title.toLowerCase().includes('изменени')) {
                const pdfLink = await p.getAttribute('a[href*=".pdf"]', 'href');
                if (pdfLink) {
                    const fullPdfUrl = pdfLink.startsWith('http') ? pdfLink : new URL(pdfLink, DASHBOARD_URL).href;
                    const pdfResp = await context.request.get(fullPdfUrl);
                    const pdfBuf = await pdfResp.body();
                    const fileKey = `ch_${Date.now()}`;

                    // Загружаем только PDF
                    await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, {
                        data: { pass: ADMIN_PASS, data: pdfBuf.toString('base64'), name: fileKey, ext: 'pdf' }
                    });

                    // Добавляем в список на сайт
                    await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                        data: { pass: ADMIN_PASS, title: title, url: `/api/files/${fileKey}.pdf` }
                    });

                    // Запуск рассылки (передаем путь к PDF)
                    await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                        data: { pass: ADMIN_PASS, text: `🔔 <b>${title}</b>`, pdf_url: `/api/files/${fileKey}.pdf` }
                    });
                }
            }
            await p.close();
        }
    } finally { await browser.close(); }
}
main();
