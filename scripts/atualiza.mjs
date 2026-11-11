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

/* ---------- Agenda (calendários oficiais: Fed, BLS, BEA e BCE; datas conferidas em 11/11/2026) ---------- */
// [data, hora local da fonte, fuso da fonte ('ET' ou 'CET'), evento, peso]. Atualizar 1x por ano com os calendários novos.
const CAL = [
  ...['2026-12-09','2027-01-27','2027-03-17','2027-04-28','2027-06-09','2027-07-28','2027-09-15','2027-10-27','2027-12-08'].map(d => [d, '14:00', 'ET', 'Decisão de juros do Fed (FOMC)', 3]),
  ...['2026-12-10','2027-01-13','2027-02-11','2027-03-10','2027-04-13','2027-05-12','2027-06-10','2027-07-14','2027-08-11','2027-09-14','2027-10-14','2027-11-10','2027-12-10'].map(d => [d, '08:30', 'ET', 'Inflação ao consumidor dos EUA (CPI)', 3]),
  ...['2026-12-04','2027-01-08','2027-02-05','2027-03-05','2027-04-02','2027-05-07','2027-06-04','2027-07-02','2027-08-06','2027-09-03','2027-10-08','2027-11-05','2027-12-03'].map(d => [d, '08:30', 'ET', 'Relatório de emprego dos EUA (payroll)', 3]),
  ...['2026-11-13','2026-12-15','2027-01-14','2027-02-12','2027-03-12','2027-04-14','2027-05-13','2027-06-11','2027-07-15','2027-08-10','2027-09-10','2027-10-15','2027-11-12','2027-12-15'].map(d => [d, '08:30', 'ET', 'Inflação ao produtor dos EUA (PPI)', 2]),
  ['2026-11-25', '08:30', 'ET', 'Inflação PCE e renda pessoal dos EUA', 3], ['2026-12-23', '08:30', 'ET', 'Inflação PCE e renda pessoal dos EUA', 3],
  ['2026-11-25', '08:30', 'ET', 'PIB dos EUA (3º tri, 2ª estimativa)', 2], ['2026-12-23', '08:30', 'ET', 'PIB dos EUA (3º tri, 3ª estimativa)', 2],
  ...['2026-12-17','2027-02-04','2027-03-18','2027-04-29','2027-06-10','2027-07-22','2027-09-09','2027-10-28','2027-12-16'].map(d => [d, '14:15', 'CET', 'Decisão de juros do BCE', 2])
];
// horário de verão dos EUA e da Europa (o Brasil não tem): define quantas horas somar/subtrair para Brasília
const verao = (d, ini, fim) => d >= ini && d < fim;
function horaBR(d, h, fuso){
  const y = d.slice(0, 4), [hh, mm] = h.split(':').map(Number);
  const dif = fuso === 'ET' ? (verao(d, {2026: '2026-03-08', 2027: '2027-03-14'}[y] || '', {2026: '2026-11-01', 2027: '2027-11-07'}[y] || '') ? 1 : 2)
                            : (verao(d, {2026: '2026-03-29', 2027: '2027-03-28'}[y] || '', {2026: '2026-10-25', 2027: '2027-10-31'}[y] || '') ? -5 : -4);
  return String(hh + dif).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}
async function agenda(){
  const hoje = agoraBR().data, prox = CAL.filter(e => e[0] >= hoje).sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  if (!prox.length) throw new Error('calendário acabou: atualizar a lista CAL com as datas do ano seguinte');
  const fortes = prox.filter(e => e[4] >= 3).slice(0, 5), sel = (fortes.length >= 5 ? fortes : prox.slice(0, 5)).sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  const meta = ler('noticias_meta');
  meta.agenda = {atualizado: hoje, fonte: 'Fed, BLS, BEA e BCE', itens: sel.map(([data, h, fuso, evento, peso]) => ({data, hora: horaBR(data, h, fuso), evento, esperado: '', peso}))};
  gravar('noticias_meta', meta);
  return meta.agenda.itens.map(i => i.data.slice(8) + '/' + i.data.slice(5, 7) + ' ' + i.evento.split(' (')[0]).join('; ');
}

/* ---------- Alphractal (API com chave, 10 créditos por chamada) ---------- */
const AX = (process.env.ALPHRACTAL_API_URL || 'https://api.alphractal.com').replace(/\/+$/, '');
async function ax(caminho, q = {}){
  const u = new URL(AX + caminho); Object.entries(q).forEach(([k, v]) => { if (v != null) u.searchParams.set(k, v); });
  const r = await fetch(u, {headers: {'X-Api-Key': process.env.ALPHRACTAL_API_KEY, 'Accept': 'application/json'}, signal: AbortSignal.timeout(120000)});
  if (r.status === 429){ await espera(5000); return ax(caminho, q); }
  if (!r.ok) throw new Error(caminho + ' HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return r.json();
}
// mesmas séries do painel (constante BUSCAS), com o caminho de cada uma na API
const S = (ind, cam, o = {}) => ({ind, cam, ...o});
const BUSCAS = [
  S('btc_preco', '/btc/market/PriceUSD', {desde: '2011-01-01'}),
  S('mvrv', '/btc/market/CapMVRVCur', {desde: '2011-01-01'}),
  S('nupl', '/btc/market/Nupl', {desde: '2011-01-01'}),
  S('realized_price', '/btc/lifespan/realized_price', {desde: '2011-01-01'}),
  S('sth_realized_price', '/btc/lifespan/sth_realized_price', {desde: '2011-01-01'}),
  S('lth_realized_price', '/btc/lifespan/lth_realized_price', {desde: '2011-01-01'}),
  S('true_market_mean', '/btc/lifespan/true_market_mean_price', {desde: '2011-01-01'}),
  S('active_realized_price', '/btc/lifespan/active_realized_price'),
  S('investor_price', '/btc/lifespan/investor_price'),
  S('alpha_price', '/btc/lifespan/alpha_price'),
  S('lth_supply_in_profit_pct', '/btc/market/lth_supply_in_profit_pct', {desde: '2011-01-01'}),
  S('sth_supply_in_profit_pct', '/btc/market/sth_supply_in_profit_pct', {desde: '2011-01-01'}),
  S('reserva', '/btc/exchange_flow/exchange_reserve'),
  S('netflow', '/btc/exchange_flow/exchange_netflow'),
  S('entrada_ex', '/btc/exchange_flow/FlowInExNtv'),
  S('saida_ex', '/btc/exchange_flow/FlowOutExNtv'),
  S('enderecos', '/btc/addresses/AdrActCnt'),
  S('hashrate', '/btc/mining/HashRate', {fator: 1e-6}),
  S('funding', '/btc/derivatives/Funding_Rate', {fator: 100, desde: '2020-01-01', campo: 'value'}),
  S('oi_usd', '/btc/derivatives/Open_Interest', {desde: '2020-01-01', campo: 'Open_Interest_Usd', tf: '1d'}),
  S('whale_ratio', '/btc/derivatives/whale_vs_retail_ratio', {tf: '1d'}),
  S('whale_delta', '/btc/derivatives/whale_vs_retail_delta', {desde: '2020-01-01', tf: '1d'}),
  S('toptrader', '/btc/derivatives/toptrader_long_short_ratio', {desde: '2020-01-01', tf: '1d'}),
  S('taker', '/btc/derivatives/taker_long_short_vol_ratio', {tf: '1d'}),
  S('vol_compra', '/btc/derivatives/buy_volume', {tf: '1d'}),
  S('vol_venda', '/btc/derivatives/sell_volume', {tf: '1d'}),
  S('fear_greed', '/crypto_fear_and_greed/sentiment', {desde: '2018-02-01', campo: 'value'}),
  S('altseason', '/btc/spot/altseason', {desde: '2021-01-01', alt: true, tf: '1d'}),
  ...[['dxy','dxy'],['sp500','sp500'],['vix','vixcls'],['ouro','gold'],['tbill','yield_3m'],['juros_10y','yield_10y'],['m2_global','m2_money_supply_global'],['nasdaq','nasdaq'],['curva_10_2','t10y2y'],['hy_spread','bamlh0a0hym2']]
    .map(([ind, c]) => S(ind, '/' + c + '/macro', {desde: '2020-01-01', campo: 'value'})),
  ...['cryptocurrency','bitcoin','doge','ethereum','xrp','solana','cardano','chainlink','litecoin','hyperliquid','binance','coinbase','bybit','okx','coinmarketcap','coingecko']
    .map(k => S('g_' + k, '/google_' + k + '/sentiment', {desde: '2011-01-01', cada: 7, campo: 'value'}))
];
const desser = s => (s || '').split(';').filter(Boolean).map(x => { const i = x.indexOf(','); return [x.slice(0, i), Number(x.slice(i + 1))]; }).filter(p => p[0].length === 10 && isFinite(p[1]));
const ser = pts => pts.map(p => p[0] + ',' + (+p[1].toPrecision(7))).join(';');
const menosDias = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') - n*864e5).toISOString().slice(0, 10);
const valor = (it, b) => { if (b.campo && it[b.campo] != null) return +it[b.campo]; const k = Object.keys(it).find(k => k !== 'time' && typeof it[k] === 'number'); return k ? +it[k] : NaN; };
const camel = o => Array.isArray(o) ? o.map(camel) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/_([a-z0-9])/g, (m, c) => c.toUpperCase()), camel(v)])) : o;
// mapa de liquidações: transforma a grade de preços em níveis (os 24 maiores, como no painel)
function niveisLiq(sn){
  const pm = sn.priceMid || [], L = sn.activeLongLiqUsd || [], Sh = sn.activeShortLiqUsd || [], pr = +sn.lastClose, out = [];
  // a API manda a liquidez de cada faixa em activeLongLiqUsd (activeShortLiqUsd vem zerado): abaixo do preço é longs, acima é shorts
  pm.forEach((p, i) => { const v = Math.max(+L[i] || 0, +Sh[i] || 0); if (!(v > 0)) return; out.push({p: +p, l: p < pr ? v : 0, s: p > pr ? v : 0}); });
  // os 12 maiores de cada lado: longs (abaixo do preço) e shorts (acima). Pegar os 24 maiores juntos deixava só longs.
  const lado = k => out.filter(n => n[k] > 0).sort((a, b) => b[k] - a[k]).slice(0, 12);
  const top = lado('l').concat(lado('s')).sort((a, b) => b.p - a.p);
  if (!top.length) return null;
  return {data: String(sn.lastBucketTime || '').slice(0, 10), t: sn.lastBucketTime || new Date().toISOString(), tf: sn.timeframe, preco: pr || null, niveis: top};
}
const PER = {'7d': {tf: '15m', tfV: '1h', dias: 7}, '30d': {tf: '30m', tfV: '1h', dias: 30}, '90d': {tf: '4h', tfV: '4h', dias: 90}, '365d': {tf: '1d', tfV: '1d', dias: 365}};
async function velas(tfV, dias){
  const r = await ax('/btc/spot/OHLCV', {timeframe: tfV, startDate: new Date(Date.now() - dias*864e5).toISOString()});
  const pts = (Array.isArray(r) ? r : []).map(x => [Date.parse(x.time), +x.open, +x.high, +x.low, +x.close]).filter(x => x.every(isFinite)).sort((a, b) => a[0] - b[0]);
  return pts.length ? {tf: tfV, pts: pts.map(x => x.map((v, i) => i ? +v.toFixed(2) : v).join(',')).join(';')} : null;
}
async function alphractal(){
  if (!process.env.ALPHRACTAL_API_KEY) return 'sem ALPHRACTAL_API_KEY, pulado';
  const series = ler('series'), mercado = ler('mercado'), hoje = agoraBR().data;
  const meta = mercado.meta || {}; meta.buscas = meta.buscas || {}; meta.hist = meta.hist || {};
  let ok = 0, chamadas = 0; const falhas = [];
  for (const b of BUSCAS){
    const ult = meta.buscas[b.ind];
    if (ult && (b.cada ? (Date.parse(hoje) - Date.parse(ult))/864e5 < b.cada : ult === hoje)) continue;
    const atual = desser(series[b.ind] && series[b.ind].pts), ini = atual.length ? menosDias(atual[atual.length-1][0], 3) : (b.desde || menosDias(hoje, 730));
    try {
      chamadas++;
      let r = await ax(b.cam, {startDate: ini + 'T00:00:00Z', endDate: hoje + 'T23:59:59Z', timeframe: b.tf});
      if (b.alt) r = (r && r.series) || [];
      const m = new Map(atual); let n = 0;
      for (const it of (Array.isArray(r) ? r : [])){ const d = String(it.time || '').slice(0, 10), v = (b.alt ? +it.seasonIndex : valor(it, b)) * (b.fator || 1); if (d.length === 10 && isFinite(v)){ m.set(d, v); n++; } }
      if (n){ series[b.ind] = {pts: ser([...m.entries()].sort((a, c) => a[0] < c[0] ? -1 : 1))}; ok++; }
      meta.buscas[b.ind] = hoje;
    } catch (e){ falhas.push(b.ind + ' (' + e.message + ')'); }
  }
  gravar('series', series);
  // resumo do mercado (preço, OI, long/short, liquidações 24h)
  try { chamadas++; const r = camel(await ax('/summary/btc')); if (r && r.priceUsd){ mercado.resumo = {...(mercado.resumo || {}), ...r}; delete mercado.resumo.liqJanelas; } }
  catch (e){ falhas.push('resumo (' + e.message + ')'); }
  // mapa de liquidações nos 4 períodos + candles
  for (const [per, c] of Object.entries(PER)){
    try {
      chamadas += 2;
      const liq = niveisLiq(await ax('/liquidation_levels/snapshot', {asset: 'btc', timeframe: c.tf})), v = await velas(c.tfV, c.dias);
      if (!liq) throw new Error('sem níveis');
      if (per === '30d'){
        mercado.liquidacoes = liq; if (v) mercado.velas = v;
        const h = (mercado.liq_hist && mercado.liq_hist.snaps) || [], s = {t: liq.t, preco: liq.preco, n: liq.niveis.map(x => [Math.round(x.p), Math.round(x.l), Math.round(x.s)].join(',')).join(';')};
        const u = h[h.length-1]; if (u && Math.abs(Date.parse(liq.t) - Date.parse(u.t)) < 3*3600e3) h[h.length-1] = s; else h.push(s);
        mercado.liq_hist = {snaps: h.slice(-120)};
      } else mercado['mapa_' + per] = {liq, velas: v};
    } catch (e){ falhas.push('mapa ' + per + ' (' + e.message + ')'); }
  }
  mercado.meta = {...meta, atualizado: new Date().toISOString()};
  gravar('mercado', mercado);
  return ok + ' séries atualizadas, ' + chamadas + ' chamadas (~' + chamadas*10 + ' créditos)' + (falhas.length ? '; falharam: ' + falhas.join('; ') : '');
}

await parte('Pools', pools);
await parte('ETFs', etfs);
await parte('Notícias', noticias);
await parte('Agenda', agenda);
await parte('Alphractal', alphractal);
console.log(relatorio.join('\n'));
