# Identidade Vertto Tracking

O frontend usa os quatro campos oficiais de whitelabel:

```dotenv
BRAND_NAME=Vertto Tracking
BRAND_LOGO_URL=/brand/vertto-logo.svg
BRAND_FAVICON_URL=/brand/vertto-favicon.svg
BRAND_PRIMARY_COLOR=#FF3B19
```

Configure esses valores no serviço **web**, em build e runtime. Um novo build
aplica também os metadados das páginas estáticas. Credenciais continuam somente
na API; estes quatro campos são públicos.

`vertto-brand.css` é ativado apenas com `data-brand-name="Vertto Tracking"`.
Usa a paleta preto, branco e laranja, preserva as proporções do logo e ajusta
sidebar/login. Sem esse nome, a folha mantém o tema original. As variáveis RGB
das folhas originais têm fallback idêntico à cor anterior.

Os SVGs são cópias intactas dos arquivos da identidade visual da agência:
versão horizontal branca com “digital” (15) e horizontal branca sólida (24).
O logo principal tem 150 px de largura; o contexto compacto da sidebar recolhida
mantém uma marca menor. A adaptação compacta só vale acima de 900 px.

O rodapé permanece **Vertto Tracking · RastrackDash · powered by PalmUP**.
Não há mudança em autenticação, licença, dados, integração ou regras de negócio.

Para reverter a identidade, remova os quatro valores `BRAND_*` e publique o web
novamente. Para voltar também ao frontend original, selecione o commit anterior
no Coolify. Nunca remova os bancos ou altere os segredos da API para reverter a marca.
