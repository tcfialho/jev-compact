resultado | jev-compact 0.4.0; dashboard/instalacao/opcoes/compatibilidade Codex revisados

arquitetura | PreCompact seleciona evidência -> Codex compacta nativamente -> PostCompact confirma -> SessionStart(compact) restaura uma vez; UserPromptSubmit é fallback one-shot

dashboard | métricas medidas: chars antes/depois da cópia retida, contexto total devolvido pelo hook, payload de evidência, tokens reais reportados pelo Jev, requests/latência, fallback/skip/restore issue, por-tool e decisões recentes; sem chars/4 como suposta economia de billing

codex atual | additionalContext tem spill default ~2500 tokens; hooks de restore agora usam additionalContextLimit=0 para evitar segundo truncamento invisível e deixar preserve/balanced/minimal + RESTORE_MAX_CHARS controlarem o tamanho real

instalacao | setup salva provider/key, copia dist para ~/.codex/jev-compact/runtime e instala hooks apontando para runtime estável; install continua apontando para checkout atual para desenvolvimento; doctor verifica key + 4 hooks

opcoes | lossThreshold/JEV_COMPACT_LOSS_THRESHOLD é nome principal; keepThreshold/KEEP_THRESHOLD segue alias; preserve/balanced/minimal são nomes principais; knobs operacionais ficaram avançados

compat | TokenBudget também dispara ciclo compact do Codex e portanto recebe retenção; documentado. Não usar instalação direta e marketplace simultaneamente para evitar hooks duplicados

testes | rodar suite final/release depois do bump 0.4.0
