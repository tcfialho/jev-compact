resultado | jev-compact 0.5.0; exact post-compaction dedupe + observe mode implementados sobre o lifecycle Codex

arquitetura | PreCompact registra transcript bytes + Jev seleciona -> Codex compacta nativamente -> PostCompact confirma -> SessionStart lê checkpoint novo -> remove apenas duplicatas verbatim comprovadas -> active injeta uma vez / observe só mede; UserPromptSubmit segue fallback one-shot

dedupe | mensagem exige role+texto inteiro exatos; tool pair exige call canônica + result exato sob mesmo call_id; result usa SHA-256 completo; prefixo parecido não basta; checkpoint stale/ausente/diferente => restore conservador antigo

observe | config mode observe; Jev e membership rodam de verdade, inclusive quando active teria skip por min-reduction; não retorna additionalContext; registra wouldInject*, nativePresentChars, restoreCandidateChars, membershipStatus

dashboard | mostrar actual restored separado de observed; exact evidence already present após native compaction; hypothetical observe payload; continua sem chars/4 como billing

compat | estado antigo sem operationMode continua active; dedupe é otimização fail-open e não altera retained archive; checkpoint precisa ser posterior ao byte offset capturado em PreCompact

testes | membership exato, prefix collision, stale checkpoint, observe one-shot e observe end-to-end adicionados; rodar suite final após merge/sync de dashboard remoto

integração git | checkout local não conseguiu fetch/pull de github.com por DNS do sandbox; a main remota foi verificada em a4639c7. O core remoto não mudou desde v0.4; as mudanças remotas eram CLI/dashboard. O comportamento de dashboard destacado + restart/health foi preservado nesta árvore. Antes de publicar, rebase/cherry-pick este feature commit sobre a main remota atual se ela tiver avançado.
