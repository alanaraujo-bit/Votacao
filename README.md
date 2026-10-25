# Apuração Ao Vivo — 2º turno

Página única (`index.html`) que acompanha a apuração do 2º turno para Presidente em tempo real,
direto da divulgação oficial do TSE, sem precisar recarregar.

- Diferença em votos e em pontos percentuais, gigante, na cor de quem lidera
- Quanto a diferença mudou desde a última atualização (e aviso de "VIROU!")
- Quanto o segundo colocado precisa dos votos restantes para virar (estimativa)
- Gráfico da vantagem ao longo da apuração (guardado no navegador, sobrevive a recarregar)
- Placar por estado
- Modo TV (tela cheia, tela sempre acesa) e narração por voz

Abra `index.html` no navegador. `?demo=1` roda uma simulação para testar.
O ciclo e o código da eleição são descobertos sozinhos em `ele-c.json` do TSE; se falhar,
informe nas configurações (⚙️) ou na URL: `?ciclo=ele2026&eleicao=XXX`.
