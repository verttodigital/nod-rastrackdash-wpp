# Conversões a partir de relatórios publicados

Integração opcional, desativada por padrão, para uma origem de publicação, um workspace e exatamente duas conexões Uazapi BYO. Não importa leads: exige telefone, anúncio, clique e conexão compatíveis com um lead já atribuído no NOD.

| Etapa | Etiqueta | Evento | Valor |
|---|---|---|---|
| N1 | N1 | ViewContent | Sem valor |
| N2 | N2 | QualifiedLead | Sem valor |
| Agendamento | Agendamento | InitiateCheckout | 10000 centavos / BRL |

O valor do agendamento é uma referência configurada, não uma venda ou pagamento. O `LeadSubmitted` automático permanece no fluxo de entrada existente.

## Configuração

Configure apenas no ambiente de execução do servidor:

- `REPORT_SYNC_BEARER_TOKEN`: segredo aleatório dedicado, com pelo menos 32 caracteres. O publicador recebe esse segredo, não os tokens Uazapi.
- `REPORT_SYNC_CONFIG_JSON`: configuração abaixo, substituindo todos os identificadores de exemplo pelos recursos autorizados.

```json
{
  "schemaVersion": 1,
  "sourceId": "report-source",
  "tenantId": "tenant-id",
  "tenantSlug": "tenant-slug",
  "workspaceId": "workspace-id",
  "mode": "observation",
  "bindings": [
    { "instanceName": "first-instance", "whatsappInstanceId": "connection-one-id" },
    { "instanceName": "second-instance", "whatsappInstanceId": "connection-two-id" }
  ]
}
```

Em produção, acrescente `cutoverAt` com o instante ISO do corte e use `mode: "production"`. A base das etapas já alcançadas deve ter sido recebida e fechada antes. `paused` conserva os registros e interrompe novos efeitos; não habilita a rota anterior. Intenções recebidas como `observation` nunca são promovidas.

As duas conexões devem ter configuração individual cifrada. O catálogo e as operações de etiqueta utilizam a URL e o token da conexão selecionada, sem depender da configuração global legada.

## Preparação explícita das seis regras

Com o código compilado e as migrations aplicadas, execute no ambiente da API:

```sh
node dist/src/scripts/provision-report-sync.js
node dist/src/scripts/provision-report-sync.js --apply --expected-rules 6
```

O primeiro comando é uma simulação. O segundo cria ou reutiliza o catálogo nas duas instâncias e persiste três regras em observação por conexão. Ele exige modo `observation` ou `paused` e não inicia consumidores de outras filas. Os segredos são lidos do ambiente, nunca de argumentos.

Essas regras exigem contexto de publicação persistido. Adicionar uma etiqueta manualmente, sem contexto válido, não dispara suas conversões. Na Uazapi, adicione `chat_labels` somente aos callbacks destinados ao NOD, preservando seus outros eventos, filtros e todos os demais callbacks. `labels` é o evento do catálogo, não da associação ao chat.

## Contrato HTTP

Todas as rotas exigem `Authorization: Bearer ...`, além da licença válida para operações de escrita:

- `POST /integrations/report-sync/intents`: uma intenção por publicação e lead, contendo `schemaVersion`, `mode`, `sourceId`, `tenantId`, `publication`, `lead`, `origin`, `finalStage` e até três `transitions` datadas. O cabeçalho `Idempotency-Key` é SHA-256 do JSON da tupla `[sourceId, tenantId, publication.id, lead.id]`.
- `GET /integrations/report-sync/intents/:syncId`: estado persistido, etapas, data original, motivo e confirmação da Meta. Não retorna tokens ou telefone.
- `POST /integrations/report-sync/baseline`: partes de até 500 registros, com manifesto de quantidade e SHA-256, permitido apenas antes de produção. A base registra etapas consumidas sem criar leads, etiquetas ou conversões.

Consulte os schemas executáveis em `apps/api/src/report-sync/report-sync.contract.ts`. A repetição idêntica retorna o mesmo identificador. Um corpo diferente para a mesma intenção é recusado com 409. A identidade semântica da etapa é independente da publicação: `[sourceId, tenantId, lead.id, stage]`.

## Entrega e recuperação

A publicação deve congelar candidatos e horários completos na mesma transação de sua fila de saída. O NOD persiste o contexto antes de alterar etiquetas, processa saltos cronologicamente e verifica a leitura real da Uazapi. Preserva etiquetas externas e termina somente com a etiqueta do estágio atual entre as três gerenciadas. Correções descendentes não geram outra conversão.

Ausência de timestamp, origem ambígua, LID sem vínculo comprovado ou atribuição incompleta ficam explícitas como pendência/inelegibilidade. Eventos vencidos não recebem uma data nova. Etiqueta já aplicada e webhook perdido são reconciliados sem retirar e recolocar a etiqueta artificialmente.

HTTP 202, fila aceita ou Uazapi 200 não são confirmação de conversão. A entrega exige resposta da Meta com `events_received >= 1`, preservando o mesmo `event_id` e a data original nas retentativas. A fila periódica recupera os registros persistidos após reinício.

## Corte e reversão

1. Homologue em observação nas duas origens, com provas nominais privadas.
2. Pause o despacho antigo somente do tenant escolhido e aguarde os envios em trânsito.
3. Grave base e corte em transação consistente, transfira o manifesto e confirme seu fechamento.
4. Confira a configuração das seis regras, fontes, canais e flags. Antes de habilitar uma flag global, prove que ela não liberará regras de outro cliente.
5. Ative o piloto e acompanhe uma publicação posterior ao corte até a etiqueta no chat correto, a decisão e a confirmação da Meta. Sem evento novo elegível, o aceite continua pendente.

Para reverter, pause primeiro e concilie eventos em trânsito e já aceitos antes de reativar o caminho antigo. Não há fallback automático entre os dois emissores.

Documentação oficial Uazapi: [OpenAPI](https://docs.uazapi.com/openapi-bundled.json) e [evento chat_labels](https://docs.uazapi.com/webhook/chat_labels).
