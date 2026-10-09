# Página → Google Sheets

Extensão do Chrome (Manifest V3) que lê campos configurados do DOM da página aberta e **adiciona** os registros a uma planilha
do Google Sheets já existente — nenhum arquivo Excel novo é criado. Os dados entram depois das linhas existentes via
[`spreadsheets.values.append`](https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.values/append),
preservando cabeçalhos, fórmulas e dados anteriores.

O modelo padrão de mapeamento corresponde à planilha **"CRM - Linkedin outreach"**
(`Company | Sector | Country | Website | Contact | Level | Linkedin profile | Status | Date`), mas qualquer planilha e
qualquer site podem ser configurados.

## Como funciona

1. Você abre manualmente uma página no Chrome (ex.: um perfil do LinkedIn).
2. No ícone da extensão, clica em **Extrair desta página**: os campos configurados são lidos do DOM e o registro vai para a
   **fila** local (prévia). Você pode visitar várias páginas e acumular registros.
3. A prévia mostra os dados em uma tabela editável (para completar campos manuais como *Sector* ou *Status*) e permite remover
   registros.
4. Clique em **Adicionar à planilha**: a extensão lê o cabeçalho e a coluna de identificador único da planilha e mostra quantas
   linhas serão adicionadas e quantas já existem. **Nada é enviado** até você clicar em **Confirmar envio**.
5. Após o envio, a extensão exibe quantas linhas foram efetivamente adicionadas (valor `updatedRows` retornado pela API) e o
   intervalo gravado.

### Garantias

| Requisito | Como é atendido |
| --- | --- |
| Adicionar após os dados existentes | `values.append` com `insertDataOption=INSERT_ROWS`: a API insere linhas novas, nunca sobrescreve células. |
| Preservar cabeçalho, fórmulas e dados | Nenhuma linha existente é escrita. Colunas sem mapeamento são enviadas como `null`, que a API ignora. |
| Mapear campos → colunas | Cada campo é associado a um **nome de coluna**; a posição é obtida lendo o cabeçalho da planilha no momento do envio. Se uma coluna mapeada não existir, o envio é bloqueado (evita dados desalinhados). |
| Evitar duplicações | A coluna de identificador único (padrão: *Linkedin profile*) é lida da planilha logo antes do append. Registros cujo identificador já existe são ignorados; repetidos na fila são mesclados. URLs são comparadas sem protocolo, `www.`, parâmetros e barra final, e células `=HYPERLINK("url"; ...)` também são reconhecidas. |
| Falhas de conexão/autenticação | A fila fica em `chrome.storage.local` e só é limpa após sucesso. Um 401 renova o token e repete uma vez. Leituras são repetidas em falhas transitórias; o **append nunca é repetido automaticamente** (evita linhas em dobro se o servidor tiver gravado). Ao tentar de novo, o identificador único detecta o que já foi gravado. |
| Texto da página não vira fórmula | Os valores vão com `USER_ENTERED` (para datas serem reconhecidas), mas textos iniciados com `=`, `+`, `-` ou `@` recebem um apóstrofo e são gravados como texto. |
| Envio só após confirmação | Fluxo em duas etapas: prévia/verificação (somente leitura) → confirmação explícita → append. |

## Instalação

1. Clone o repositório.
2. Abra `chrome://extensions`, ative o **Modo do desenvolvedor** e clique em **Carregar sem compactação**, selecionando a pasta
   do repositório.
3. A página de **Configurações** abre automaticamente.

O `manifest.json` tem uma chave pública (`key`), então o ID da extensão é sempre `dphpkiodclkeghjdhfaehfpekooibole`, em
qualquer computador, pasta ou navegador (Chrome ou Edge). Por isso o **URI de redirecionamento** também é sempre o mesmo:

```
https://dphpkiodclkeghjdhfaehfpekooibole.chromiumapp.org/
```

> A `key` é a parte **pública** do par de chaves; ela só fixa o ID e não dá acesso a nada. A chave privada não é necessária
> para carregar a extensão sem compactação e nunca deve ser versionada (`*.pem` está no `.gitignore`).

## Configurar o OAuth 2.0 no Google Cloud

1. Em [console.cloud.google.com](https://console.cloud.google.com/), crie (ou escolha) um projeto.
2. **APIs e serviços → Biblioteca**: ative a **Google Sheets API**.
3. **APIs e serviços → Tela de consentimento OAuth**: tipo *Externo*, adicione o escopo
   `https://www.googleapis.com/auth/spreadsheets` e inclua sua conta Google como **usuário de teste** (para uso pessoal o app
   pode permanecer em modo de teste).
4. **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**, tipo **Aplicativo da Web**. Em
   *URIs de redirecionamento autorizados*, cole `https://dphpkiodclkeghjdhfaehfpekooibole.chromiumapp.org/` (o mesmo
   exibido nas configurações da extensão).
5. Copie o **Client ID** (`…apps.googleusercontent.com`) para o campo *OAuth Client ID* nas configurações da extensão.

## Compartilhar com outra pessoa

1. Ela instala a extensão a partir do repositório (passos de **Instalação**). O ID e o URI de redirecionamento são os mesmos,
   então **não é preciso mudar nada no Google Cloud** por causa da instalação dela.
2. Com o app OAuth em modo de teste, adicione o e-mail Google dela em **Tela de consentimento OAuth → Usuários de teste**
   (até 100 pessoas). Sem isso o Google bloqueia o login dela.
3. Em **Configurações → Compartilhar configurações**, clique em **Exportar configurações** e envie o arquivo `.json`. Ela usa
   **Importar configurações** e recebe Client ID, planilha, aba e todo o mapeamento com os seletores. O arquivo não contém
   tokens nem senhas.
4. Se ela for usar a mesma planilha, compartilhe-a com a conta Google dela como **Editor**. Se for usar outra, basta trocar a
   URL da planilha depois de importar.

## Configurar a planilha

1. Cole a **URL** (ou o ID) da planilha e informe o **nome da aba** (ex.: `Sheet1`) e a **linha do cabeçalho** (normalmente `1`).
2. Clique em **Carregar colunas da planilha**: o Google pede autorização na primeira vez; em seguida a extensão cria um campo
   para cada coluna do cabeçalho, mantendo mapeamentos já existentes.
3. Para cada coluna, escolha a **origem**:
   - **Seletor CSS** — um seletor por linha; o primeiro que retornar texto é usado. O campo *Atributo* lê um atributo em vez do
     texto (ex.: `href`, `content` para `meta[property="og:title"]`).
   - **URL da página** — origem + caminho, sem parâmetros (bom identificador único).
   - **Título da página**, **Data de hoje** (`AAAA-MM-DD`) ou **Valor fixo / manual** (valor padrão, editável na prévia).
4. Escolha a coluna de **identificador único** (ou nenhuma) e clique em **Salvar**.

### Capturar seletores da página (sem abrir o DevTools)

1. Abra uma página de exemplo (ex.: um perfil do LinkedIn), clique no ícone da extensão e em **Capturar seletores**. A extensão
   lista todos os textos visíveis da página e gera um seletor CSS para cada um.
2. Em **Configurações**, clique no botão **🔍** ao lado do valor de um campo. Uma janela mostra a tabela capturada (seção, texto
   encontrado, seletor e quantos elementos ele encontra); filtre pelo texto que você quer (ex.: `Red Marketing`).
3. **Usar** substitui o seletor do campo; **+ Alternativa** adiciona o seletor como linha extra (usada se as anteriores não
   acharem nada). Clique em **Salvar**.

Os seletores gerados ignoram classes geradas automaticamente (como `fmbkzy`) e se apoiam em âncoras estáveis: a parte fixa de
`id`/`componentkey` (ex.: `[id$="Topcard"] h2`), `aria-label`, o padrão do link (`a[href*="/company/"]`) e tags como `main`.
Cada seletor é validado na página capturada: o primeiro elemento que ele encontra é exatamente o texto mostrado. Prefira os
seletores sem `:nth-of-type`, que resistem melhor a mudanças de layout, e confira em outro perfil antes de usar em lote.

O botão **Aplicar modelo LinkedIn** preenche seletores de partida para perfis do LinkedIn. O LinkedIn altera o HTML com
frequência; se um campo vier vazio, a extensão avisa quais campos não foram encontrados e você pode ajustar o seletor (botão
direito → *Inspecionar* no elemento desejado).

## Autenticação e segurança

- **OAuth 2.0** via `chrome.identity.launchWebAuthFlow`, com um único escopo: `spreadsheets`. Ele é o mínimo que permite ler o
  cabeçalho/identificadores e adicionar linhas em uma planilha escolhida pelo usuário (`drive.file` só daria acesso a arquivos
  criados pela própria extensão ou abertos por um seletor de arquivos).
- **Nenhuma credencial no código-fonte.** O Client ID (identificador público do app, não um segredo) é informado pelo usuário
  e salvo em `chrome.storage.sync`. Nenhum *client secret* é usado.
- O **access token** fica somente em `chrome.storage.session` (memória, apagado ao fechar o navegador) e expira em ~1 hora.
  **Sair da conta Google** revoga o token no Google.
- O `.gitignore` bloqueia arquivos típicos de credenciais (`client_secret*.json`, `.env`, `*.pem`, `token*.json`).
- Permissões da extensão: `activeTab` + `scripting` (ler somente a aba em que você clicou no ícone), `storage`, `identity` e
  acesso de rede apenas a `sheets.googleapis.com` e `oauth2.googleapis.com`.

## Solução de problemas

| Mensagem | Causa e correção |
| --- | --- |
| *A Google Sheets API não está ativada…* | No projeto do Google Cloud que contém o Client ID: **APIs e serviços → Biblioteca → Google Sheets API → Ativar**. Pode levar alguns minutos para valer. |
| *A conta Google escolhida no login não tem acesso de edição…* | O login foi feito com outra conta. Em Configurações, clique em **Sair da conta Google** e tente de novo escolhendo a conta dona da planilha, ou compartilhe a planilha como **Editor** com a conta usada. Em modo de teste, a conta também precisa estar em *Usuários de teste* na tela de consentimento OAuth. |
| *A permissão de acesso às planilhas não foi concedida…* | Na tela de consentimento do Google, a caixa de permissão de planilhas ficou desmarcada. Tente de novo e marque-a. |
| *O arquivo é um Excel (.xlsx)…* | A API não edita .xlsx guardados no Drive. Use **Arquivo → Salvar como Planilhas Google** e configure o ID da nova planilha. |

## Critérios de aceitação — roteiro de verificação

1. Abra manualmente um perfil (ex.: `https://www.linkedin.com/in/...`) no Chrome.
2. Clique no ícone da extensão → **Extrair desta página**: os campos configurados são lidos do DOM.
3. Confira os dados na **Prévia** (edite *Sector*/*Status* se quiser).
4. **Adicionar à planilha** → **Confirmar envio**: a mensagem informa *"N linhas adicionadas à aba ..."* e o intervalo gravado.
5. Abra a planilha: as linhas anteriores, o cabeçalho e as fórmulas continuam intactos; os novos registros estão no final.
6. Extraia o mesmo perfil novamente e envie: a prévia marca o registro como **Já na planilha** e nenhuma linha é adicionada.

## Desenvolvimento

Sem dependências nem etapa de build. Os testes usam o *test runner* nativo do Node (≥ 20):

```bash
npm test
```

```
manifest.json
src/
  background.js        service worker: liga o serviço às APIs do Chrome e atende mensagens
  lib/
    auth.js            OAuth 2.0 (launchWebAuthFlow), token em chrome.storage.session
    config.js          configuração, modelo LinkedIn e validação
    extractor.js       função injetada na página para ler o DOM
    scanner.js         função injetada na página para capturar seletores candidatos
    mapping.js         funções puras: mapeamento de colunas, deduplicação, sanitização
    service.js         fila, prévia/verificação e envio
    sheets.js          cliente da Sheets API (values.get / values.append) e tratamento de erros
  popup/               prévia, botão "Adicionar à planilha" e confirmação
  options/             configurações (OAuth, planilha, aba, mapeamento)
test/                  testes unitários e do fluxo completo com planilha simulada
```

### Limitações conhecidas

- O cabeçalho deve começar na coluna **A** da aba configurada.
- A verificação de duplicados depende de o identificador único ser extraído; registros sem identificador são sempre enviados
  (aparecem como *Sem identificador* na prévia).
- Novas linhas inseridas por `INSERT_ROWS` não herdam fórmulas por linha de linhas vizinhas; prefira `ARRAYFORMULA` no
  cabeçalho para colunas calculadas.
