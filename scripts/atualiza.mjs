// Robô diário do Termômetro do BTC: busca as fontes e regrava data/*.json.
// Roda no GitHub Actions (node 20+, sem dependências). Cada parte é independente:
// se uma fonte falhar, os dados antigos dela ficam como estão e o resto segue.
// Chaves só por variável de ambiente (GitHub Secrets): SOSOVALUE_API_KEY, ALPHRACTAL_API_KEY.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
const ler = nome => { try { return JSON.parse(fs.readFileSync(path.join(DIR, nome + '.json'), 'utf8')); } catch { return {}; } };
const gravar = (nome, obj) => fs.writeFileSync(path.join(DIR, nome + '.json'), JSON.stringify(obj));
const UA = {'User-Agent': 'Mozilla/5.0 (TermometroBTC; +https://github.com)'};
const espera = ms => new Promise(r => setTimeout(r, ms));
async function baixa(url, opt = {}, tentativas = 2){
  for (let i = 0; i < tentativas; i++){
    try {
      const r = await fetch(url, {...opt, headers: {...UA, ...(opt.headers || {})}, signal: AbortSignal.timeout(120000)});
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r;
    } catch (e){ if (i === tentativas - 1) throw e; await espera(30000); }
  }
}
function agoraBR(){
  const t = new Date(Date.now() - 3*3600e3).toISOString();
  return {data: t.slice(0, 10), hora: t.slice(11, 16)};
}
const relatorio = [];
async function parte(nome, fn){
  try { relatorio.push(nome + ': ' + await fn()); }
  catch (e){ relatorio.push(nome + ': FALHOU (' + (e && e.message || e) + '), dados antigos mantidos'); }
}

/* ---------- Pools (DefiLlama) ---------- */
async function pools(){
  const raw = (await (await baixa('https://yields.llama.fi/pools')).json()).data;
  const R = new Set(['Ethereum','Solana','Base','Arbitrum','BSC','Polygon','OP Mainnet','Avalanche','Hyperliquid L1','Arc','Robinhood Chain']);
  const r2 = x => x == null ? null : Math.round(x*100)/100;
  const rows = [];
  for (const p of raw){
    if (!R.has(p.chain) || (p.tvlUsd || 0) < 1e5) continue;
    const fl = (p.stablecoin ? 's' : '') + (p.exposure === 'multi' ? 'm' : '') + (p.ilRisk === 'yes' ? 'i' : '') + (p.outlier ? 'o' : '');
    rows.push([p.pool, p.symbol, p.project, p.chain, Math.round(p.tvlUsd), r2(p.apy), r2(p.apyBase), r2(p.apyReward), r2(p.apyMean30d), null, p.volumeUsd1d == null ? null : Math.round(p.volumeUsd1d), fl, p.poolMeta || '']);
  }
  if (rows.length < 500) throw new Error('poucas pools (' + rows.length + ')');
  rows.sort((a, b) => b[4] - a[4]);
  const N = 10, k = Math.ceil(rows.length/N), out = {};
  for (let i = 0; i < N; i++) out['p' + i] = {i, rows: rows.slice(i*k, (i+1)*k)};
  out.meta = {...agoraBR(), n: rows.length, partes: N, fonte: 'DefiLlama', url: 'https://defillama.com/yields'};
  gravar('pools', out);
  return rows.length + ' pools';
}

/* ---------- ETFs (SoSoValue) ---------- */
async function etfs(){
  const K = process.env.SOSOVALUE_API_KEY; if (!K) return 'sem SOSOVALUE_API_KEY, pulado';
  const j = await (await baixa('https://openapi.sosovalue.com/openapi/v1/etfs/summary-history?symbol=BTC&country_code=US&limit=30', {headers: {'x-soso-api-key': K}})).json();
  if (j.code !== 0 || !Array.isArray(j.data) || !j.data.length) throw new Error('resposta inesperada: ' + (j.message || j.code));
  const meta = ler('noticias_meta'), atual = meta.etf2 || {}, D = new Map((atual.dias || []).map(r => [r[0], r]));
  const n0 = D.size;
  for (const r of j.data) D.set(r.date, [r.date, Math.round(+r.total_net_inflow), Math.round(+r.cum_net_inflow), Math.round(+r.total_value_traded), Math.round(+r.total_net_assets)]);
  const ds = [...D.keys()].sort(); if (ds.length < n0) throw new Error('histórico encolheu');
  meta.etf2 = {...agoraBR(), fonte: 'SoSoValue', url: 'https://sosovalue.com/assets/etf/us-btc-spot', dias: ds.map(d => D.get(d))};
  gravar('noticias_meta', meta);
  const u = D.get(ds[ds.length-1]); return ds.length + ' dias, último ' + u[0] + ' (' + Math.round(u[1]/1e6) + ' mi)';
}

/* ---------- Notícias (RSS, sem IA) ---------- */
const FEEDS = [
  {fonte: 'Portal do Bitcoin', lang: 'pt', url: 'https://portaldobitcoin.uol.com.br/feed/'},
  {fonte: 'Cointelegraph Brasil', lang: 'pt', url: 'https://br.cointelegraph.com/rss'},
  {fonte: 'CoinDesk', lang: 'en', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/'},
  {fonte: 'The Block', lang: 'en', url: 'https://www.theblock.co/rss.xml'}
];
const ENT = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', hellip:'…', ndash:'–', mdash:'—', rsquo:'’', lsquo:'‘', rdquo:'”', ldquo:'“'};
const limpa = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m).replace(/\s+/g, ' ').trim();
const tag = (x, t) => { const m = x.match(new RegExp('<' + t + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + t + '>', 'i')); return m ? m[1] : ''; };
const corta = (s, n) => s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…';
// categorias e relevância por palavras-chave (sem IA)
const CAT = [
  ['macro', /\b(fed|fomc|powell|warsh|juros|rates?|inflação|inflation|cpi|ppi|pce|payroll|emprego|jobs|desemprego|unemployment|pib|gdp|dólar|dollar|dxy|treasur|tesouro|petróleo|oil|bolsas?|stocks?|nasdaq|s&p|tarifa|tariff|recess|bce|ecb|boj|banco central|central bank)\b/i],
  ['inst', /\b(blackrock|fidelity|grayscale|vaneck|bitwise|ark|strategy|microstrategy|saylor|tesla|metaplanet|tesouraria|treasury compan|banco|bank|gestora|asset manager|jpmorgan|goldman|morgan stanley|citi|hsbc|visa|mastercard|paypal|coinbase|robinhood|sec|cftc|regula|lei|bill|congress|senado|senate|stablecoin|tokeniza|tokeniz)\w*/i],
  ['onchain', /\b(etfs?|ibit|fbtc|fluxo|flows?|inflow|outflow|baleia|whale|on-chain|onchain|minera|miner|hashrate|liquida|liquidat|corretora|exchange|reserva|halving|funding|open interest)\w*/i]
];
const PESO = /\b(etf|fed|fomc|powell|sec|cpi|inflação|inflation|juros|rates|hack|halving|blackrock|strategy|payroll|liquida\w*|liquidation\w*|recorde|record|máxima|all-time high|ath)\b/gi;
const BTC = /\b(bitcoin|btc)\b/i;
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
async function noticias(){
  const atual = ler('noticias'), porUrl = new Map(Object.entries(atual).map(([id, n]) => [n.url, id]));
  const novos = [], erros = [];
  for (const F of FEEDS){
    let xml;
    try { xml = await (await baixa(F.url)).text(); } catch (e){ erros.push(F.fonte); continue; }
    for (const it of xml.split(/<item[\s>]/i).slice(1)){
      const titulo = limpa(tag(it, 'title')), url = limpa(tag(it, 'link')) || limpa(tag(it, 'guid'));
      if (!titulo || !/^https:\/\//.test(url) || porUrl.has(url)) continue;
      const quando = new Date(limpa(tag(it, 'pubDate')) || limpa(tag(it, 'dc:date')) || Date.now());
      if (isNaN(quando)) continue;
      const data = new Date(quando.getTime() - 3*3600e3).toISOString().slice(0, 10);
      const resumo = corta(limpa(tag(it, 'description')), 420);
      const txt = titulo + ' ' + resumo, cat = (CAT.find(([, re]) => re.test(txt)) || ['macro'])[0];
      novos.push({titulo, resumo, cat, fonte: F.fonte, lang: F.lang, url, data, _txt: txt.toLowerCase(), _peso: (txt.match(PESO) || []).length + (BTC.test(txt) ? 1 : 0)});
    }
  }
  // relevância 1 a 5: palavras de peso + mesmo assunto em mais de uma fonte
  const chave = n => new Set(n._txt.normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(w => w.length > 4));
  novos.forEach(n => { n._k = chave(n); });
  novos.forEach(n => {
    const eco = novos.filter(o => o !== n && o.fonte !== n.fonte && [...n._k].filter(w => o._k.has(w)).length >= 4).length;
    n.relevancia = Math.max(1, Math.min(5, 1 + Math.min(3, n._peso) + (eco ? 1 : 0)));
  });
  // até 60 por dia por idioma (as mais relevantes)
  const grupos = {};
  for (const n of novos){ const g = n.data + n.lang; (grupos[g] ||= []).push(n); }
  let entrou = 0;
  for (const g of Object.values(grupos)){
    const ja = Object.values(atual).filter(x => x.data + (x.lang || 'pt') === g[0].data + g[0].lang).length;
    g.sort((a, b) => b.relevancia - a.relevancia).slice(0, Math.max(0, 60 - ja)).forEach(n => {
      let id = n.data + '-' + slug(n.titulo); while (atual[id]) id += '-x';
      const {_txt, _peso, _k, ...doc} = n; atual[id] = doc; porUrl.set(n.url, id); entrou++;
    });
  }
  // guarda as 500 mais recentes
  const ids = Object.keys(atual).sort((a, b) => String(atual[b].data).localeCompare(String(atual[a].data)));
  const fica = {}; ids.slice(0, 500).forEach(id => { fica[id] = atual[id]; });
  gravar('noticias', fica);
  return entrou + ' novas, ' + Object.keys(fica).length + ' guardadas' + (erros.length ? ' (falhou: ' + erros.join(', ') + ')' : '');
}

/* ---------- Alphractal (aguardando endereço da API) ---------- */
async function alphractal(){
  if (!process.env.ALPHRACTAL_API_KEY || !process.env.ALPHRACTAL_API_URL) return 'sem ALPHRACTAL_API_KEY/URL, pulado';
  return 'ainda não implementado';
}

await parte('Pools', pools);
await parte('ETFs', etfs);
await parte('Notícias', noticias);
await parte('Alphractal', alphractal);
console.log(relatorio.join('\n'));
