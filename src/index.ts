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

      // Tenta clicar no primeiro card de resultado da lista lateral
      try {
        // Múltiplos seletores para o primeiro resultado
        const selectors = [
          'a[href*="/maps/place/"]',
          'div[role="article"] a',
          'a[class*="place"]',
        ];
        let clicked = false;
        for (const sel of selectors) {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
            await el.click();
            clicked = true;
            break;
          }
        }
        if (!clicked) {
          // Último recurso: clica no centro da tela (pode ativar o primeiro resultado)
          await page.mouse.click(600, 300);
        }
        await delay(4000, 7000);
      } catch (e) {
        console.log(`  -> Não conseguiu clicar em resultado`);
      }

      // Busca a seção de lotação
      let status_movimento = 'Sem dados ao vivo';
      let percentual_estimado = null;

      // Scrolla o painel lateral para baixo para carregar seções lazy
      try {
        // Tenta scrollar o painel principal do Maps
        const scrollable = page.locator('div[role="main"], div.m6QErb, div[aria-label*="Resultados"], div[aria-label*="Informações"]').first();
        if (await scrollable.isVisible({ timeout: 2000 }).catch(() => false)) {
          await scrollable.evaluate(el => {
            el.scrollTop = el.scrollHeight;
          });
          await delay(1500, 3000);
          // Scrolla de novo para garantir (conteúdo lazy pode carregar em etapas)
          await scrollable.evaluate(el => {
            el.scrollTop = el.scrollHeight;
          });
          await delay(1500, 3000);
        } else {
          // Fallback: scrolla a página toda
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await delay(1500, 3000);
        }
      } catch (e) {
        console.log('  -> Aviso: não conseguiu scrollar');
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
