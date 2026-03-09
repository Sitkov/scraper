import { chromium } from 'playwright';
import fs from 'fs';
import crypto from 'crypto';

console.log('--- ЗАПУСК СКРИПТА (СТАБИЛЬНАЯ ВЕРСИЯ) ---');

const DASHBOARD_URL = 'https://t15.ecp.egov66.ru/dashboard';
const SITE_BASE_RAW = (process.env.SITE_BASE || '').trim().replace(/\/+$/, '');
const ADMIN_PASS    = (process.env.ADMIN_PASS || '').trim();
const MAX_KEEP      = 3;

// Функция для создания хеша (для проверки дубликатов)
function createHash(title, date) {
    const cleanTitle = title.toLowerCase().replace(/\s+/g, ' ').trim().substring(0, 100);
    return crypto.createHash('md5').update(cleanTitle + '_' + date).digest('hex');
}

const monthsMap = {'янв':1, 'фев':2, 'мар':3, 'апр':4, 'мая':5, 'июн':6, 'июл':7, 'авг':8, 'сен':9, 'окт':10, 'ноя':11, 'дек':12};
const monthsArr =['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const daysArr =['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

function parseNewsDate(title) {
    let match = title.match(/(\d{1,2})\s+([а-яё]+)/i) || title.match(/(\d{1,2})\.(\d{1,2})/);
    if (!match) return 0;
    const d = parseInt(match[1]);
    const m = (match[2].length <= 2) ? parseInt(match[2]) : (monthsMap[match[2].toLowerCase().slice(0, 3)] || 0);
    return (m * 100) + d;
}

function formatRussianTitle(title) {
    let match = title.match(/(\d{1,2})\s+([а-яё]+)/i) || title.match(/(\d{1,2})\.(\d{1,2})/);
    if (match) {
        const d = parseInt(match[1]);
        const m = (match[2].length <= 2) ? parseInt(match[2]) : (monthsMap[match[2].toLowerCase().slice(0, 3)] || 1);
        const dateObj = new Date(new Date().getFullYear(), m - 1, d);
        return `${daysArr[dateObj.getDay()]} - ${d} ${monthsArr[m - 1]}`;
    }
    return title;
}

// Функция для получения списка существующих записей
async function getExistingHashes(context) {
    try {
        const response = await context.request.get(`${SITE_BASE_RAW}/api/changes.json`);
        if (response.ok()) {
            const data = await response.json();
            if (Array.isArray(data)) {
                return data.map(item => item.hash).filter(Boolean);
            }
        }
    } catch (e) {
        console.log('Не удалось получить существующие хеши');
    }
    return [];
}

async function main() {
    const browser = await chromium.launch();
    
    const contextOptions = { 
        acceptDownloads: true,
        deviceScaleFactor: 2, 
        viewport: { width: 1000, height: 1200 }
    };
    if (fs.existsSync('state.json')) {
        contextOptions.storageState = 'state.json';
        console.log('✅ Куки (state.json) успешно загружены.');
    } else {
        console.log('⚠️ ВНИМАНИЕ: Файл state.json не найден!');
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    // Получаем список существующих хешей ДО начала работы
    const existingHashes = await getExistingHashes(context);
    console.log(`📋 Существующих записей в базе: ${existingHashes.length}`);

    try {
        console.log('Загрузка портала...');
        await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000); 

        const links = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            return Array.from(new Set(anchors.map(a => a.href).filter(h => /\/news\/show\/\d+$/i.test(h))));
        });
        
        console.log(`Найдено ссылок: ${links.length}`);
        let foundNews = [];
        
        for (const url of links.slice(0, 10)) {
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

        // СОРТИРУЕМ от новых к старым
        foundNews.sort((a, b) => parseNewsDate(b.title) - parseNewsDate(a.title));
        
        let processed = 0;
        let lastProcessed = null;

        for (const item of foundNews) {
            if (processed >= 1) break; // Обрабатываем только самую свежую новость
            
            try {
                const prettyTitle = formatRussianTitle(item.title);
                const today = new Date();
                const currentDate = `${today.getDate().toString().padStart(2, '0')}.${(today.getMonth()+1).toString().padStart(2, '0')}.${today.getFullYear()}`;
                
                // СОЗДАЕМ ХЕШ для проверки дубликата
                const hash = createHash(prettyTitle, currentDate);
                
                // ПРОВЕРЯЕМ, есть ли уже такой хеш в базе
                if (existingHashes.includes(hash)) {
                    console.log(`⏭️ ПРОПУСК (уже есть в базе): ${prettyTitle}`);
                    continue;
                }
                
                console.log(`🆕 Обработка новой записи: ${prettyTitle}`);

                const pdfResp = await context.request.get(item.url);
                const pdfBuf = await pdfResp.body();
                const b64Pdf = pdfBuf.toString('base64');

                const p = await context.newPage();
                await p.setViewportSize({ width: 1000, height: 1000 });
                
                await p.setContent(`
                    <html><head>
                        <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
                        <style>body{margin:0;background:#fff} canvas{display:block;margin:0 auto;}</style>
                    </head><body><div id="v"></div><script>
                        const pdfData = atob("${b64Pdf}");
                        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                        pdfjsLib.getDocument({data: pdfData}).promise.then(async (pdf) => {
                            const v = document.getElementById('v');
                            for(let i=1; i<=pdf.numPages; i++) {
                                const page = await pdf.getPage(i);
                                const vp = page.getViewport({scale: 2.0}); 
                                const canvas = document.createElement('canvas');
                                canvas.width = vp.width; canvas.height = vp.height;
                                v.appendChild(canvas);
                                await page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
                            }
                            document.body.classList.add('ready');
                        }).catch(e => { document.body.classList.add('error'); });
                    </script></body></html>
                `);

                await p.waitForSelector('.ready', { timeout: 60000 });
                const screenshotBuf = await p.screenshot({ type: 'jpeg', quality: 85, fullPage: true });
                await p.close();

                const fileKey = `ch_${Date.now()}`;
                
                const uploadUrl = `${SITE_BASE_RAW}/admin_upload_pdf.php?pass=${encodeURIComponent(ADMIN_PASS)}`;
                
                // 1. Грузим PDF
                console.log('Загрузка PDF...');
                const pdfUpRes = await context.request.post(uploadUrl, {
                    data: { pass: ADMIN_PASS, data: b64Pdf, name: fileKey, ext: 'pdf' }
                });
                if (!pdfUpRes.ok()) console.log(`⚠️ Ошибка загрузки PDF: HTTP ${pdfUpRes.status()}`);

                // 2. Грузим скриншот (jpg)
                console.log('Загрузка скриншота...');
                const imgRes = await context.request.post(uploadUrl, {
                    data: { pass: ADMIN_PASS, data: screenshotBuf.toString('base64'), name: fileKey, ext: 'jpg' }
                });
                
                const imgText = await imgRes.text();
                let imgUp = {};
                try { 
                    imgUp = JSON.parse(imgText); 
                    if (imgUp.ok) {
                        console.log('✅ Скриншот загружен');
                    }
                } catch(e) { 
                    console.log(`❌ ОШИБКА ХОСТИНГА (Картинка): ${imgText.substring(0, 200)}`); 
                }

                if (imgUp.ok) {
                    // 3. Записываем в БД с ХЕШЕМ
                    console.log('Добавление в базу данных...');
                    const addRes = await context.request.post(`${SITE_BASE_RAW}/admin_change_add.php`, {
                        data: { 
                            pass: ADMIN_PASS, 
                            title: prettyTitle, 
                            url: '/api/files/' + fileKey + '.pdf', 
                            source: item.newsUrl, 
                            img_url: '/api/files/' + fileKey + '.jpg',
                            hash: hash  // ОТПРАВЛЯЕМ ХЕШ НА СЕРВЕР
                        }
                    });
                    
                    const addText = await addRes.text();
                    let add = {};
                    try { 
                        add = JSON.parse(addText); 
                    } catch(e) { 
                        console.log(`❌ ОШИБКА ХОСТИНГА (БД): ${addText.substring(0, 200)}`); 
                    }

                    if (add.added) {
                        console.log(`✅ ДОБАВЛЕНО В БАЗУ: ${prettyTitle}`);
                        lastProcessed = { title: prettyTitle, img_url: '/api/files/' + fileKey + '.jpg' };
                        processed++;
                        
                        // Добавляем хеш в список, чтобы не обработать повторно в этой сессии
                        existingHashes.push(hash);
                    }
                }
            } catch (e) { console.log(`Ошибка при обработке PDF: ${e.message}`); }
        }

        // 4. Рассылка (только если добавили что-то новое)
        if (lastProcessed) {
            console.log(`📨 Отправка рассылки: ${lastProcessed.title}`);
            
            // Проверяем тест-режим через settings.json
            try {
                const settingsRes = await context.request.get(`${SITE_BASE_RAW}/api/settings.json`);
                if (settingsRes.ok()) {
                    const settings = await settingsRes.json();
                    if (settings.test_mode) {
                        console.log('🔧 Режим теста включен - рассылка только админу');
                    }
                }
            } catch (e) {}
            
            await context.request.post(`${SITE_BASE_RAW}/admin_broadcast.php`, {
                data: { 
                    pass: ADMIN_PASS, 
                    text: lastProcessed.title, 
                    img_url: lastProcessed.img_url 
                }
            });
            console.log('✅ Рассылка отправлена');
        } else {
            console.log('⏭️ Нет новых записей для рассылки');
        }
    } catch (err) { console.error('Критическая ошибка:', err.message); }

    // 5. Очистка старых записей
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
    
    await context.request.get(`${SITE_BASE_RAW}/admin_auto_cleanup.php`, { params: { pass: ADMIN_PASS } }).catch(() => {});
    await browser.close();
    console.log('--- СКРИПТ УСПЕШНО ЗАВЕРШЕН ---');
}

main();
