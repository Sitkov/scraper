import { chromium } from 'playwright'
import fs from 'fs'

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard'
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '')
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim()

async function main() {
    console.log("🚀 Глубокая диагностика...");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ 
        viewport: { width: 1280, height: 1000 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    try {
        console.log(`🔗 Открываю: ${DASHBOARD_URL}`);
        const response = await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        console.log(`📡 Статус ответа: ${response.status()}`);

        // Ждем 5 секунд принудительно, чтобы всё прогрузилось
        console.log("⏳ Жду прогрузки JS (5 сек)...");
        await page.waitForTimeout(5000);

        // Смотрим, есть ли вообще текст на странице
        const bodyText = await page.innerText('body').catch(() => 'Текст не найден');
        console.log(`📝 Обрывок текста со страницы (первые 200 символов): "${bodyText.substring(0, 200).replace(/\n/g, ' ')}..."`);

        // Пробуем найти ссылки ДРУГИМ способом - через селектор всех элементов
        const links = await page.evaluate(() => {
            const results = [];
            const elements = document.querySelectorAll('a');
            for (let el of elements) {
                results.push({ href: el.href, text: el.innerText.trim() });
            }
            return results;
        });

        console.log(`🔎 Всего ссылок на странице: ${links.length}`);
        
        // Фильтруем те, что ведут на новости
        const newsLinks = links.filter(l => l.href.includes('news') || l.text.toLowerCase().includes('изменен'));
        console.log(`✅ Из них похожи на новости: ${newsLinks.length}`);

        if (newsLinks.length > 0) {
            for (let link of newsLinks.slice(0, 1)) {
                console.log(`🎯 Иду по ссылке: ${link.href} (${link.text})`);
                await page.goto(link.href, { waitUntil: 'networkidle' });
                // ... тут логика обработки PDF как раньше ...
                console.log("Страница новости открыта, ищу PDF...");
                const pdf = await page.evaluate(() => document.querySelector('a[href*=".pdf"]')?.href);
                console.log(pdf ? `Найден PDF: ${pdf}` : "PDF не найден");
            }
        } else {
            console.log("❌ Ссылок на новости нет. Список всех найденных доменов на странице:");
            const domains = [...new Set(links.map(l => new URL(l.href).hostname))];
            console.log(domains.join(', '));
        }

    } catch (err) {
        console.error("⛔ Ошибка:", err.message);
    } finally {
        await browser.close();
        console.log("🏁 Завершено.");
    }
}
main();
