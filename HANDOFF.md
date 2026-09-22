resultado | audit funcional contra save-token-jev-clean + fast-dev-compaction + Codex main d1092865 concluído; comportamento base útil preservado e regressões corrigidas

correção conceitual | PreCompact continua correto para capturar/selecionar evidência antes da compactação; Codex nativo compacta; PostCompact confirma; SessionStart(compact) restaura uma vez. Isso é retention-around-compaction, não replacement da request nativa.

mudanças 0.2 | default restore voltou para full capped 60k; developer/system preservados; KEEP>TRUNCATE>DROP conservador restaurado; object identity; key-file; PLUGIN_DATA; cleanup 48h; messages.json; per-result head/tail; per-tool dashboard/history; Windows hooks; skill docs; manifest válido; marketplace fake removido

testes | npm test: 32/32; npm pack --dry-run OK; plugin/hook manifests sanity-checked; reverse-loader smoke tested from 1B to 4KB chunks

gaps deliberados | adapters multi-host de save-token não copiados (Codex-first); dashboard não auto-starta; marketplace só quando existir URL real; keychain específico de plataforma não copiado

próxima ação opcional | se quiser reduzir a própria request de compaction do Codex, implementar proxy Responses opcional que detecta compaction_trigger; manter hook-mode intacto


revisão final | projeto renomeado integralmente para jev-compact; namespace de configuração JEV_COMPACT_*; dist versionado; sidecar pendente invalidado a cada PreCompact; mídia/opaque não julgável faz fail-open; reverse-loader evita cópia repetida de linha JSONL gigante; instalador Windows usa quoting próprio
