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
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });
  
  const lote_hora = new Date().toISOString();

  for (const placeName of places) {
    const page = await context.newPage();
    try {
      console.log(`Buscando: ${placeName}`);
      const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(placeName)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
      
      // Espera um pouco para o carregamento do mapa e painel lateral
      await delay(3000, 6000);

      // Tenta fechar o consentimento de cookies se aparecer
      try {
        const consentButton = page.locator('button:has-text("Aceitar tudo")');
        if (await consentButton.isVisible({ timeout: 2000 })) {
          await consentButton.click();
          await delay(1000, 2000);
        }
      } catch (e) {}

      // A busca pode retornar uma lista ou abrir direto o lugar.
      // Se tiver uma lista (vários resultados), clica no primeiro que parece ser o principal
      const firstResult = page.locator('a[href*="/maps/place/"]').first();
      if (await firstResult.isVisible({ timeout: 3000 })) {
        await firstResult.click();
        await delay(3000, 5000);
      }

      // Agora procuramos a seção de horários de pico
      // Geralmente tem aria-labels descrevendo a ocupação
      const busyElements = page.locator('[aria-label*="ocupação"], [aria-label*="movimentado"]');
      const count = await busyElements.count();
      
      let status_movimento = 'Sem dados ao vivo';
      let percentual_estimado = null;

      if (count > 0) {
        for (let i = 0; i < count; i++) {
          const text = await busyElements.nth(i).getAttribute('aria-label');
          if (text && (text.includes('Atualmente') || text.includes('Agora'))) {
            status_movimento = text;
            const match = text.match(/(\d+)%/);
            if (match) {
              percentual_estimado = parseInt(match[1]!, 10);
            }
            break; // Achou o ao vivo
          }
        }
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
      await page.close();
      await delay(2000, 5000); // Pausa humana entre locais
    }
  }

  await browser.close();
  console.log('Finalizado com sucesso.');
}

scrapePlaces().catch(console.error);
