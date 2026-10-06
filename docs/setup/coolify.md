# Coolify: versão instalada e checklist

Este complemento mantém o fluxo de instalação do [guia do aluno](../GUIA-ALUNO.md).
Licença, autenticação, dados e receivers continuam usando os mecanismos originais.

## Identificar o código instalado

O Coolify 4.3.23 remove `.git` antes do build. O Dockerfile aceita o
`SOURCE_COMMIT` gerado pelo Coolify como alternativa quando `GIT_SHA` não foi
informado. O resolver original continua priorizando Git quando os metadados
existem e recusando identificadores inválidos.

No serviço da API:

1. Em **Configuration → Advanced**, habilite **Include Source Commit in Build**.
2. Mantenha **Inject Build Args to Dockerfile** desabilitado: os argumentos
   necessários já estão declarados no Dockerfile.
3. Não crie uma variável `SOURCE_COMMIT` nem copie um SHA da `main` para `GIT_SHA`.
   O Coolify deve fornecer o commit que efetivamente clonou.
4. Faça um novo build e confira a linha `build identity:` e o SHA no backoffice.

Para imagens de um fork com correções próprias, a versão instalada deve mostrar
o commit do fork. A comparação com a `main` pública pode continuar **desconhecida**,
conforme o [guia de atualização](update.md#fork-ou-branch-própria). Isso não deve
ser substituído artificialmente por “em dia”.

Antes do redeploy, confirme um backup recente. Não recrie bancos, credenciais ou
o administrador. O build precisa terminar antes da substituição da API em uso.

## Checklist do administrador

Em **Clientes**, use **Entrar no workspace** para selecionar o cliente que será
verificado. O checklist considera esse contexto de suporte autenticado, mesmo
quando o administrador não tem um vínculo de membro com o cliente.

O indicador Meta considera uma conexão manual ativa com credencial ativa e não
expirada no mesmo workspace, além da conexão legada. Um token apenas salvo ou
uma conexão pendente não concluem esse item. A ausência de workspace selecionado
ou de integração válida continua sendo apresentada como pendente.

Essa conferência é somente leitura: não cria vínculos, não amplia permissões e
não altera o envio de eventos à Meta.
