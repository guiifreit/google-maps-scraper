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

async function delay(min: number, max: number) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapePlaces() {
  console.log('Iniciando o scraper...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  
  const lote_hora = new Date().toISOString();

  for (let idx = 0; idx < places.length; idx++) {
    const placeName = places[idx]!;
    const page = await context.newPage();
    try {
      console.log(`Buscando: ${placeName}`);
      const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(placeName)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(5000, 8000);

      // Fecha consentimento de cookies se aparecer
      try {
        const consentButton = page.locator('button:has-text("Aceitar tudo")');
        if (await consentButton.isVisible({ timeout: 2000 })) {
          await consentButton.click();
          await delay(1000, 2000);
        }
      } catch (e) { /* ignora */ }

      // Aguarda a lista de resultados carregar
      try {
        await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 15000 });
        await delay(1500, 3000);
      } catch (e) {
        console.log('  -> Aviso: resultados demoraram, tentando continuar...');
      }

      // Tenta clicar no primeiro resultado usando force:true para garantir
      try {
        const firstLink = page.locator('a[href*="/maps/place/"]').first();
        await firstLink.waitFor({ state: 'attached', timeout: 10000 });
        await firstLink.click({ force: true, timeout: 10000 });
        console.log('  -> Clicou no primeiro resultado');
        await delay(4000, 7000);

        // Aguarda o painel de detalhes do lugar carregar (h1 com o nome)
        try {
          await page.waitForSelector('h1', { timeout: 10000 });
          console.log('  -> Painel de detalhes carregado');
        } catch {
          console.log('  -> Painel pode não ter carregado completamente');
        }
        await delay(2000, 4000);
      } catch (e) {
        console.log('  -> Não conseguiu clicar, tenta scrollar lista e tentar de novo');
        // Tenta dar scroll na lista e clicar de novo
        try {
          const listPanel = page.locator('div[role="feed"], div[role="main"], div.m6QErb').first();
          await listPanel.evaluate(el => el.scrollBy(0, 200));
          await delay(1000, 2000);
          const retryLink = page.locator('a[href*="/maps/place/"]').first();
          await retryLink.click({ force: true, timeout: 8000 });
          await delay(4000, 7000);
        } catch (e2) {
          console.log('  -> Realmente não conseguiu clicar');
        }
      }

      // Busca a seção de lotação
      let status_movimento = 'Sem dados ao vivo';
      let percentual_estimado = null;

      // Scrolla o painel lateral de INFORMAÇÕES (não o body) usando JS puro
      try {
        const scrollScript = `
          () => {
            // Procura o elemento com scroll na lateral esquerda (overflow auto/scroll)
            const allDivs = document.querySelectorAll('div');
            let target = null;
            for (const div of allDivs) {
              const style = window.getComputedStyle(div);
              if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && div.scrollHeight > div.clientHeight) {
                target = div;
                break;
              }
            }
            if (target) {
              target.scrollTop = target.scrollHeight;
              return 'scrollou no: ' + (target.id || target.className || 'desconhecido');
            }
            return 'nenhum container com scroll encontrado';
          }
        `;
        for (let s = 0; s < 5; s++) {
          const result = await page.evaluate(scrollScript);
          if (s === 0) console.log(`  -> ${result}`);
          await delay(1200, 2000);
        }
      } catch (e) {
        console.log('  -> Erro ao scrollar:', e);
      }

      // Patterns de aria-label para buscar
      const patterns = [
        'Atualmente',
        'ocupação',
        'movimentado',
        'movimento',
        'lotado',
        'Popular',
        'Horários',
        'pico',
      ];

      for (const pattern of patterns) {
        if (status_movimento !== 'Sem dados ao vivo') break;
        try {
          const els = page.locator(`[aria-label*="${pattern}"]`);
          const count = await els.count();
          for (let i = 0; i < count; i++) {
            const text = await els.nth(i).getAttribute('aria-label');
            if (text && (text.includes('Atualmente') || text.includes('Agora') || text.includes('Normalmente'))) {
              status_movimento = text;
              const match = text.match(/(\d+)%/);
              if (match) percentual_estimado = parseInt(match[1]!, 10);
              break;
            }
          }
        } catch (e) { /* fallback */ }
      }

      // Fallback: varre o texto visível da página
      if (status_movimento === 'Sem dados ao vivo') {
        try {
          const bodyText = await page.locator('body').innerText();
          const lines = bodyText.split('\n');
          for (const line of lines) {
            if (line.includes('Atualmente') || line.includes('Agora')) {
              status_movimento = line.trim().substring(0, 100);
              const match = line.match(/(\d+)%/);
              if (match) percentual_estimado = parseInt(match[1]!, 10);
              break;
            }
          }
        } catch (e) { /* fallback */ }
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

    } catch (error: any) {
      console.error(`Erro ao buscar ${placeName}: ${error.message}`);
    } finally {
      const safeName = placeName.replace(/[^a-zA-Z0-9]/g, '_');
      try {
        // Só salva screenshot dos 3 primeiros para debug
        if (idx < 3) {
          await page.screenshot({ path: `debug_${safeName}.png`, fullPage: false });
        }
      } catch (e) { /* ignora */ }
      await page.close();
      await delay(2000, 5000);
    }
  }

  await browser.close();
  console.log('Finalizado com sucesso.');
}

scrapePlaces().catch(console.error);
