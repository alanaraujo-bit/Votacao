# Apuração Ao Vivo — 2º turno

Acompanha a apuração do 2º turno para Presidente em tempo real, com os dados oficiais do TSE:
diferença em votos, mapa por estado, probabilidade de vitória (Monte Carlo) e modo TV.

## Como funciona

- `server.js` busca o arquivo nacional do TSE a cada ~0,7s e os 28 estaduais a cada ~4s, e **transmite cada
  mudança na hora** para todos os navegadores conectados (Server-Sent Events, em `/api/stream`).
  O TSE recebe as buscas de um servidor só, não as de cada pessoa.
- Se a transmissão cair, ou se o servidor ficar mais de 5s sem conseguir falar com o TSE, a página passa
  sozinha a buscar direto no TSE pelo navegador e volta para a transmissão quando ela se recupera.
- `index.html` também funciona sozinho (aberto como arquivo ou em qualquer hospedagem estática), buscando
  direto no TSE.

Sem dependências: só Node 18 ou mais novo.

```
npm start        # http://localhost:3000
```

`/health` mostra se o servidor está conseguindo falar com o TSE, quantas pessoas estão conectadas etc.

## Publicar no Railway

1. Em https://railway.com, **New Project → Deploy from GitHub repo** e escolha este repositório.
2. Em **Settings → Source**, escolha a branch publicada (ex.: `claude/live-voting-comparison-rj1cvr`).
3. Em **Settings → Networking**, clique em **Generate Domain**. O link gerado é o que você manda para as pessoas.

O Railway lê o `railway.json` (comando de início, verificação em `/health` e reinício automático).

Variáveis opcionais: `ELEICAO` e `CICLO` (forçar o código da eleição, padrão detectado sozinho, 6258/ele2026),
`POLL_MS` (pausa entre buscas do nacional, padrão 700) e `STATES_MS` (estados, padrão 4000).

## Testar

`?demo=1` no fim do endereço roda uma simulação completa, sem depender do TSE.

Contornos do mapa: [@svg-maps/brazil](https://github.com/VictorCazanave/svg-maps) (CC BY 4.0).
