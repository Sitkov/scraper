import { chromium } from 'playwright'
import fs from 'fs'

console.log('--- ИНИЦИАЛИЗАЦИЯ СКРИПТА (ВЕРСИЯ С ДИАГНОСТИКОЙ) ---');

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
        viewport: { width: 1200, height: 1600 }
    });
    const page = await context.newPage();

    try {
        console.log('Загрузка портала...');
        const response = await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log(`Статус ответа: ${response.status()}`);
        
        await page.waitForTimeout(5000); // Даем время на рендер
        
        const currentUrl = page.url();
        const pageTitle = await page.title();
        console.log(`Мы на странице: ${currentUrl}`);
        console.log(`Заголовок страницы: "${pageTitle}"`);

        // Проверка на вылет из сессии
        if (currentUrl.includes('esia.gosuslugi.ru') || pageTitle.includes('вход') || pageTitle.includes('Авторизация')) {
            console.error('❌ ОШИБКА: Сессия state.json протухла! Бот попал на страницу логина.');
            await browser.close();
            return;
        }

        const links = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            const list = anchors.map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h));
            return Array.from(new Set(list));
        });
        
        console.log(`Найдено ссылок на новости: ${links.length}`);
        if (links.length === 0) {
            console.log('--- РАБОТА ЗАВЕРШЕНА (НОВОСТЕЙ НЕТ) ---');
            await browser.close();
            return;
        }

        foundNews.sort((a, b) => parseNewsDate(a.title) - parseNewsDate(b.title));
        // ... (остальной код добавления и рассылки остается таким же) ...
        // (Я его тут пропустил для краткости, используй его из прошлого сообщения)
        
    } catch (err) {
        console.error('❌ КРИТИЧЕСКАЯ ОШИБКА В main():');
        console.error(err);
    }
    
    await browser.close();
    console.log('--- КОНЕЦ СКРИПТА ---');
}

main().catch(e => {
    console.error('ФАТАЛЬНАЯ ОШИБКА:');
    console.error(e);
    process.exit(1);
});
