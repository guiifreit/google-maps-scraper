import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();
// Apply stealth plugin
chromium.use(stealth());
// Initialize Supabase client
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sua-url.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sua-chave';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const places = JSON.parse(fs.readFileSync(path.join(__dirname, 'places.json'), 'utf-8'));
async function delay(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function scrapePlaces() {
    console.log('Iniciando o scraper...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
    });
    const lote_hora = new Date().toISOString();
    for (const placeName of places) {
        const page = await context.newPage();
        try {
            console.log(`Buscando: ${placeName}`);
            const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(placeName)}`;
            await page.goto(searchUrl, { waitUntil: 'networkidle' });
            await delay(4000, 7000);
            // Fecha consentimento de cookies se aparecer
            try {
                const consentButton = page.locator('button:has-text("Aceitar tudo")');
                if (await consentButton.isVisible({ timeout: 2000 })) {
                    await consentButton.click();
                    await delay(1000, 2000);
                }
            }
            catch (e) { /* ignora */ }
            // Clica no primeiro resultado da lista lateral
            try {
                const firstResult = page.locator('a[href*="/maps/place/"]').first();
                await firstResult.waitFor({ state: 'visible', timeout: 8000 });
                await firstResult.click();
                await delay(3000, 6000);
                // Aguarda o painel direito carregar
                await page.waitForSelector('h1, [role="main"]', { timeout: 10000 }).catch(() => { });
                await delay(2000, 4000);
            }
            catch (e) {
                console.log(`  -> Não encontrou lista de resultados, tentando direto...`);
            }
            // Busca a seção de lotação por múltiplos seletores
            let status_movimento = 'Sem dados ao vivo';
            let percentual_estimado = null;
            // Seletor 1: aria-label contendo "Atualmente" (ao vivo)
            try {
                const liveEl = page.locator('[aria-label*="Atualmente"]').first();
                if (await liveEl.isVisible({ timeout: 3000 })) {
                    const text = await liveEl.getAttribute('aria-label');
                    if (text) {
                        status_movimento = text;
                        const match = text.match(/(\d+)%/);
                        if (match)
                            percentual_estimado = parseInt(match[1], 10);
                    }
                }
            }
            catch (e) { /* fallback */ }
            // Seletor 2: procura aria-label contendo "ocupação" ou "movimentado"
            if (status_movimento === 'Sem dados ao vivo') {
                try {
                    const busyElements = page.locator('[aria-label*="ocupação"], [aria-label*="movimentado"], [aria-label*="movimento"]');
                    const count = await busyElements.count();
                    for (let i = 0; i < count; i++) {
                        const text = await busyElements.nth(i).getAttribute('aria-label');
                        if (text && (text.includes('Atualmente') || text.includes('Agora') || text.includes('Normalmente'))) {
                            status_movimento = text;
                            const match = text.match(/(\d+)%/);
                            if (match)
                                percentual_estimado = parseInt(match[1], 10);
                            break;
                        }
                    }
                }
                catch (e) { /* fallback */ }
            }
            // Seletor 3: procura texto na página sobre horários de pico
            if (status_movimento === 'Sem dados ao vivo') {
                try {
                    const bodyText = await page.locator('body').innerText();
                    const lines = bodyText.split('\n');
                    for (const line of lines) {
                        if (line.includes('Atualmente') || line.includes('Agora')) {
                            status_movimento = line.trim();
                            const match = line.match(/(\d+)%/);
                            if (match)
                                percentual_estimado = parseInt(match[1], 10);
                            break;
                        }
                    }
                    // Se achou algo no texto, limita a 100 caracteres
                    if (status_movimento.length > 100)
                        status_movimento = status_movimento.substring(0, 100);
                }
                catch (e) { /* fallback */ }
            }
            console.log(`-> Resultado para ${placeName}: ${status_movimento} (${percentual_estimado}%)`);
            // Salva no Supabase (se as variáveis estiverem configuradas corretamente, senão apenas loga)
            if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
                const { error } = await supabase
                    .from('historico_movimento')
                    .insert([
                    {
                        nome_local: placeName,
                        lote_hora: lote_hora,
                        status_movimento: status_movimento,
                        percentual_estimado: percentual_estimado
                    }
                ]);
                if (error) {
                    console.error(`Erro ao salvar ${placeName}:`, error.message);
                }
            }
        }
        catch (error) {
            console.error(`Erro ao buscar ${placeName}: ${error.message}`);
        }
        finally {
            await page.close();
            await delay(2000, 5000); // Pausa humana entre locais
        }
    }
    await browser.close();
    console.log('Finalizado com sucesso.');
}
scrapePlaces().catch(console.error);
//# sourceMappingURL=index.js.map