resultado | jev-compact 0.3.0; rodada de correções/performance concluída contra Codex main atual

arquitetura preservada | PreCompact seleciona e salva evidência; Codex compacta nativamente; PostCompact confirma; SessionStart(compact) restaura uma vez. full continua default

0.3 | cache de serialização de estado Jev no caminho immutable; provider/config resolvido uma vez; inputs/perguntas reutilizados; estimator sem match-array; fitter suporta mais calls sem remover semântica; rollout suffix streaming; restore readable-before-claim; history best-effort; archives paralelos/JSON compacto; ready row sem decisões duplicadas; bounds de config e validação Noul

bench local | provider 50 batches ~136.6ms -> ~27.1ms; rollout ~20MB ~85.8ms/161.5MB RSS -> ~63.6ms/123.8MB; compactor 300 calls ~35.1ms -> ~23.7ms; 600 calls passam no budget onde 400 antes falhava

testes | 43/43; npm pack --dry-run OK; git diff --check limpo

gaps deliberados | multi-host adapters continuam fora (Codex-first); dashboard manual; marketplace apenas quando houver URL real; proxy de compaction continua opcional/futuro
