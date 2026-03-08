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
        console.log('Захожу на дашборд...');
        await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 60000 });
        
        const links = await page.evaluate(() => {
            return Array.from(new Set(Array.from(document.querySelectorAll('a[href*="/news/show/"]')).map(a => a.href)));
        });
        
        console.log(`Найдено новостей: ${links.length}`);

        for (const url of links.slice(0, 1)) {
            console.log(`Проверяю новость: ${url}`);
            const p = await context.newPage();
            try {
                await p.goto(url, { waitUntil: 'networkidle', timeout: 40000 });
                const title = (await p.innerText('h1, h2, .title').catch(() => 'Изменения')).trim();
                
                if (title.toLowerCase().includes('изменени')) {
                    // Ищем любую ссылку, похожую на документ
                    const pdfLink = await p.evaluate(() => {
                        const anchor = document.querySelector('a[href*=".pdf"], a[href*="/download/"], a[class*="download"]');
                        return anchor ? anchor.href : null;
                    });

                    if (pdfLink) {
                        console.log(`Найден PDF: ${pdfLink}`);
                        const pdfResp = await context.request.get(pdfLink);
                        const pdfBuf = await pdfResp.body();
                        const fileKey = `ch_${Date.now()}`;

                        // Загружаем PDF на хостинг
                        await context.request.post(`${SITE_BASE_RAW}/admin_upload_pdf.php`, {
                            data: { pass: ADMIN_PASS, data: pdfBuf.toString('base64'), name: fileKey, ext: 'pdf' }
                        });

                        // Добавляем запись в базу
                        await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                            data: { pass: ADMIN_PASS, title: title, url: `/api/files/${fileKey}.pdf` }
                        });

                        // Рассылка файла
                        await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                            data: { pass: ADMIN_PASS, text: `🔔 <b>${title}</b>`, pdf_url: `/api/files/${fileKey}.pdf` }
                        });
                        console.log('Готово! Файл отправлен.');
                    } else {
                        console.log('⚠️ Ссылка на PDF не найдена на странице новости.');
                        // Делаем скриншот для дебага, если хочешь увидеть, что не так
                        await p.screenshot({ path: 'debug_error.png' });
                    }
                }
            } catch (e) {
                console.log(`Ошибка при обработке новости: ${e.message}`);
            } finally {
                await p.close();
            }
        }
    } catch (err) {
        console.error('Критическая ошибка:', err.message);
    } finally {
        await browser.close();
    }
}
main();
