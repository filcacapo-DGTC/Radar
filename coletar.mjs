// Coletor diário de avisos – DGTC / DFEIF, Câmara Municipal de Loures
// Corre no GitHub Actions (gratuito). Sem IA, sem custos. Só escreve dados que constam das fontes.
import * as cheerio from 'cheerio';
import fs from 'node:fs';

const OUT = process.env.AVISOS_OUT || new URL('../avisos.json', import.meta.url).pathname;
const UA = 'Mozilla/5.0 (compatible; RadarAvisosLoures/1.0)';
const pad = n => String(n).padStart(2, '0');
const MESES = ['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

export function parseData(txt) {
  const t = fold(txt);
  let m = /(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/.exec(t);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = /(\d{1,2})\s*(?:de\s+)?(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s*(?:de\s+)?(\d{4})/.exec(t);
  if (m) return `${m[3]}-${pad(MESES.indexOf(m[2]) + 1)}-${pad(m[1])}`;
  m = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? m[0] : '';
}

async function get(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, 'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.5', ...(opts.headers || {}) }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
  return r;
}

// ---------- Fundo Ambiental (tabelas HTML) ----------
export function parseFundoAmbiental(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  let estado = '';
  $('h1,h2,h3,h4,h5,h6,p,strong,b,span,div,tr').each((_, el) => {
    const $el = $(el);
    if (el.tagName === 'tr') {
      const cells = $el.children('td,th').toArray().map(c => clean($(c).text()));
      if (cells.length < 2 || /^aviso$/i.test(cells[0]) || !cells[0]) return;
      const cm = /^(\d{1,3}\/[^\s]+\/\d{4})\s*[–\-:]*\s*([\s\S]*)$/.exec(cells[0]);
      const fecho = parseData(cells.slice(1).join(' '));
      if (!cm && !fecho) return;
      const dot = cells.slice(1).find(x => /€/.test(x)) || '';
      const a = $el.find('a').first().attr('href');
      let link = ''; try { link = a ? new URL(a, base).href : ''; } catch {}
      out.push({
        codigo: cm ? cm[1] : '', nome: clean((cm ? cm[2] : cells[0]).replace(/^[«"“\s]+|[»"”\s]+$/g, '')),
        fecho, dotacao: dot, link, tipo: '', estadoFonte: estado,
      });
    } else if ($el.closest('tr').length === 0) {
      const tx = clean($el.text());
      if (!tx || tx.length > 90) return;
      if (/avisos?\s+abert/i.test(tx)) estado = 'aberto';
      else if (/avisos?\s+fechad/i.test(tx)) estado = 'fechado';
    }
  });
  return out;
}
async function fundoamb() {
  const u = 'https://www.fundoambiental.pt/candidaturas/formularios.aspx';
  const html = await (await get(u)).text();
  const r = parseFundoAmbiental(html, u);
  if (!r.length) throw new Error('nenhum aviso reconhecido (a página pode ter mudado)');
  return r;
}

// ---------- Portugal 2030 (API WordPress do portal) ----------
async function pt2030() {
  // Pedido igual ao da página portugal2030.pt/avisos (estadoAvisoId=7 = avisos abertos; todos os programas 100-122)
  const U = 'https://portugal2030.pt/wp-json/avisos/query';
  const corpo = pg => {
    const p = new URLSearchParams();
    p.append('estadoAvisoId', '7');
    for (let i = 100; i <= 122; i++) p.append('programaId[]', String(i));
    ['NUTSIIIId', 'fundoId', 'tipoAvisoId', 'tipoModalidadeApresentacaoCandidaturaId'].forEach(k => p.append(k, ''));
    p.append('order_by_field', 'publicacao'); p.append('order_by_direction', 'desc');
    if (pg > 1) p.append('page', String(pg));
    return p;
  };
  const todos = new Map();
  for (let pg = 1; pg <= 300; pg++) {
    const r = await get(U, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://portugal2030.pt/avisos/' }, body: corpo(pg) });
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.avisos || j.items || j.data || []);
    const antes = todos.size;
    arr.forEach(it => { const k = it.aviso?.codigoAviso || JSON.stringify(it).slice(0, 80); todos.set(k, it); });
    if (!arr.length || todos.size === antes) break;   // sem novidades: acabou (ou a API ignora a página)
  }
  if (!todos.size) throw new Error('resposta sem avisos');
  return [...todos.values()];
}

// ---------- Turismo de Portugal ----------
export function parseTdPLista(html, base) {
  const $ = cheerio.load(html);
  const seen = new Map();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!/\/avisos-concursos\/Paginas\//i.test(href) || /default\.aspx|encerrados/i.test(href)) return;
    let link; try { link = new URL(href, base).href; } catch { return; }
    const nome = clean($(a).text());
    if (nome.length < 8) return;
    if (!seen.has(link) || seen.get(link).length < nome.length) seen.set(link, nome);
  });
  return [...seen].map(([link, nome]) => {
    const c = /\b(MPr-\d{4}[–\-]\d+)\b/i.exec(nome + ' ' + link) || [];
    return { codigo: c[1] ? c[1].replace('–', '-') : '', nome, link, estadoFonte: 'aberto', tipo: '', fecho: '' };
  });
}
async function turismo() {
  const u = 'https://business.turismodeportugal.pt/pt/Investir/Financiamento/avisos-concursos/Paginas/default.aspx';
  const lista = parseTdPLista(await (await get(u)).text(), u);
  if (!lista.length) throw new Error('nenhum aviso reconhecido (a página pode ter mudado)');
  for (const r of lista) {            // tenta ler o prazo na página do aviso; se não constar, fica por preencher
    try {
      const $ = cheerio.load(await (await get(r.link)).text());
      const txt = clean($('body').text());
      const m = /(?:prazo|encerr\w*|data\s+limite|at[eé])[^.]{0,80}?(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}|\d{1,2}\s+de\s+\w+\s+de\s+\d{4})/i.exec(txt);
      if (m) r.fecho = parseData(m[1]);
      const tx = /taxa[^.]{0,60}?(\d{1,3}\s*%)/i.exec(txt); if (tx) r.taxa = tx[1].replace(/\s/g, '');
    } catch { /* mantém sem prazo */ }
  }
  return lista;
}

// ---------- Funding & Tenders (API pública de pesquisa) ----------
const FT_STATUS = { '31094501': 'futuro', '31094502': 'aberto', '31094503': 'fechado' };
const first = v => Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
export function mapFT(res) {
  const m = res.metadata || {};
  const id = clean(first(m.identifier) || res.reference);
  const st = FT_STATUS[String(first(m.status))] || '';
  return {
    codigo: id, nome: clean(first(m.title) || res.title || res.summary || first(m.callTitle)),
    fecho: parseData(first(m.deadlineDate)), inicio: parseData(first(m.startDate)),
    link: id ? `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/${encodeURIComponent(id)}` : '',
    tipo: clean(first(m.frameworkProgramme) || first(m.programmeDivision) || ''), estadoFonte: st === 'futuro' ? '' : st,
  };
}
async function funding() {
  const q = { bool: { must: [{ terms: { type: ['1', '2', '8'] } }, { terms: { status: ['31094501', '31094502'] } }] } };
  const todos = [];
  for (let p = 1; p <= 10; p++) {
    const fd = new FormData();
    fd.append('query', new Blob([JSON.stringify(q)], { type: 'application/json' }));
    fd.append('languages', new Blob([JSON.stringify(['en'])], { type: 'application/json' }));
    fd.append('sort', new Blob([JSON.stringify({ field: 'startDate', order: 'DESC' })], { type: 'application/json' }));
    const j = await (await get(`https://api.tech.ec.europa.eu/search-api/prod/rest/search?apiKey=SEDIA&text=***&pageSize=100&pageNumber=${p}`, { method: 'POST', body: fd })).json();
    const rs = j.results || [];
    todos.push(...rs.map(mapFT));
    if (rs.length < 100) break;
  }
  // exclui ações externas da UE (EuropeAid: países terceiros), sem interesse para autarquias
  const v = todos.filter(x => x.nome && x.codigo && !/^EuropeAid\//i.test(x.codigo));
  if (!v.length) throw new Error('resposta sem avisos');
  return v;
}

const FONTES = { fundoamb, pt2030, tdp: turismo, eft: funding };

async function main() {
  let prev = { registos: {} };
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
  const registos = { ...(prev.registos || {}) }, erros = {};
  for (const [id, fn] of Object.entries(FONTES)) {
    try { registos[id] = await fn(); console.log(`OK  ${id}: ${registos[id].length}`); }
    catch (e) { erros[id] = String(e.message || e); console.error(`ERR ${id}: ${erros[id]} (mantém dados anteriores)`); }
  }
  fs.writeFileSync(OUT, JSON.stringify({ versao: 2, atualizado: new Date().toISOString(), registos, erros, avisos: [], sources: [] }));
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) await main();
