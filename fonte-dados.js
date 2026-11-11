/* Camada de dados do site: lê os arquivos de data/ (gravados todo dia pelo GitHub Actions).
   Imita só a parte da interface que a página usa (collection/doc/get/onSnapshot/orderBy/limit),
   para o resto do código continuar igual. O site é só leitura: gravar devolve erro "somente_leitura". */
(() => {
  "use strict";
  const cache = {};
  const carrega = nome => cache[nome] || (cache[nome] = fetch('data/' + nome + '.json', {cache: 'no-cache'})
    .then(r => r.ok ? r.json() : {}).catch(() => ({})));
  const doc = (id, v) => ({id, exists: v != null, data: () => v == null ? undefined : v});
  const naoGrava = () => Promise.reject({code: 'somente_leitura', message: 'o site é só leitura'});
  function consulta(nome, ordem, lim){
    const q = {
      orderBy: (campo, dir) => consulta(nome, [campo, dir], lim),
      limit: n => consulta(nome, ordem, n),
      get: async () => {
        let docs = Object.entries(await carrega(nome)).map(([id, v]) => doc(id, v));
        if (ordem){ const [c, d] = ordem, s = d === 'desc' ? -1 : 1;
          docs.sort((a, b) => { const x = a.data()[c], y = b.data()[c]; return x < y ? -s : x > y ? s : 0; }); }
        if (lim) docs = docs.slice(0, lim);
        return {docs, empty: !docs.length, size: docs.length};
      },
      onSnapshot: (ok, erro) => { q.get().then(ok, e => erro && erro(e)); return () => {}; },
      doc: id => ({
        get: async () => doc(id, (await carrega(nome))[id]),
        onSnapshot: (ok, erro) => { carrega(nome).then(t => ok(doc(id, t[id])), e => erro && erro(e)); return () => {}; },
        set: naoGrava, update: naoGrava, delete: naoGrava
      })
    };
    return q;
  }
  const DB = {collection: nome => consulta(nome, null, 0)};
  // download direto pelo navegador (PNG, TXT, ZIP)
  const downloads = {save: async ({filename, data}) => {
    const blob = data instanceof Blob ? data : new Blob([data], {type: 'text/plain;charset=utf-8'});
    const a = document.createElement('a'), u = URL.createObjectURL(blob);
    a.href = u; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
  }};
  window.FONTE = {use: async k => k === 'db' ? DB : k === 'downloads' ? downloads : null};
})();
