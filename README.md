# Termômetro do BTC

Site estático. A página (`index.html`) lê os arquivos de `data/`, que o robô diário (`scripts/atualiza.mjs`, rodado pelo GitHub Actions) regrava todo dia. Abrir o site não gasta crédito de nada.

- `fonte-dados.js`: camada que lê `data/<collection>.json` (um objeto `{id: documento}` por arquivo).
- `data/`: carga inicial exportada do painel antigo em 11/11/2026.
- Chaves de API só em GitHub Secrets, nunca no código.
