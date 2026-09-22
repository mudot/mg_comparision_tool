# MonstersGame — Comparador de Highscore

[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-Userscript-blue?logo=tampermonkey)](https://www.tampermonkey.net/)
[![Version](https://img.shields.io/badge/version-4.2.5-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()
[![Platform](https://img.shields.io/badge/platform-Browser%20RPG-orange)]()

Userscript avançado para o jogo de browser **MonstersGame** (moonid.net) que transforma a página de Highscore em um sistema completo de monitoramento, comparação e histórico de mudanças.

---

## 📌 Sobre o Projeto

O **Comparador de Highscore** detecta automaticamente alterações nas estatísticas dos jogadores sempre que a página de ranking é acessada. Ele compara o estado atual com o último snapshot válido (respeitando um intervalo mínimo de ~55 minutos), gera um painel visual com as mudanças, salva o histórico localmente via IndexedDB e produz snapshots de alta resolução enviados automaticamente para o ImgBB.

Ideal para jogadores e guildas que desejam acompanhar a evolução do ranking de forma precisa e visual.

---

## ✨ Funcionalidades

### 📊 Comparação em Tempo Real
- Detecta mudanças em **Preciosidades**, **Ouro**, **Ancestrais**, **Vitórias** e **Derrotas**
- Calcula variação de posição (subiu / caiu / estável)
- Destaca jogadores novos na faixa
- Ordenação inteligente por relevância das mudanças

### 📋 Painel de Dados
- Exibe as 20 principais alterações da faixa atual
- Tooltips com descrição completa de cada indicador
- Contadores agregados (subiram, caíram, novos, totais de stats)
- Clique em qualquer jogador para rolar até ele na tabela original
- Botão flutuante de retorno ao painel

### 🗄️ Histórico Persistente (IndexedDB)
- Armazenamento local por servidor + faixa de posições
- Até 60 snapshots por faixa
- Intervalo mínimo de 55 minutos entre comparações
- Dados permanecem entre sessões e recarregamentos

### 🖼️ Snapshots de Alta Resolução
- Geração de imagens em **3× escala** (até 8400×3300 px)
- Dois tipos de snapshot:
  - **Comparativo** — tabela detalhada com todas as variações
  - **Painel** — visão resumida com totais e principais movimentações
- Upload automático via Cloudflare Worker → ImgBB
- URLs de alta qualidade, medium e thumbnail

### 🗂️ Álbum / Galeria
- Visualização de todos os snapshots salvos
- Abas: Comparativos · Painéis · Dados
- Renomear e apagar snapshots
- Preview em qualidade medium + abertura da imagem original em tamanho real

### 🎛️ Barra de Ferramentas
- Posicionamento com botões **🔼 / 🔽** (acima da tabela ou acima do painel)
- Estado persistido em `localStorage`
- Botões de acesso rápido: Álbum, Painel, Regenerar Imagens
- Status de upload em tempo real

### 📱 Interface & UX
- Tema escuro alinhado à estética do MonstersGame
- Minimização do painel
- Totalmente responsivo (desktop, tablet e mobile)
- Sem barra de rolagem lateral indesejada
- Compatível com mouse e touchscreen

---

## 🛠️ Tecnologias

| Tecnologia       | Uso                                      |
|------------------|------------------------------------------|
| Tampermonkey     | Execução do userscript                   |
| IndexedDB        | Persistência de histórico                |
| SVG + Canvas     | Geração de imagens em alta resolução     |
| Cloudflare Worker| Proxy de upload para ImgBB               |
| ImgBB API        | Hospedagem das imagens                   |
| CSS Grid / Flex  | Layout responsivo                        |
| Pointer Events   | Interações de UI                         |

---

## 📥 Instalação

1. Instale a extensão **[Tampermonkey](https://www.tampermonkey.net/)** no seu navegador
2. Crie um novo script
3. Cole o conteúdo completo do arquivo `monstersgame-highscore-comparision.js`
4. Salve e ative o script
5. Acesse qualquer página de Highscore do MonstersGame

O script é executado automaticamente (`@run-at document-end`).

---

## 🚀 Como Usar

1. Entre na página de **Highscore** do servidor desejado
2. O painel de comparação e a barra de ferramentas aparecem automaticamente
3. Aguarde pelo menos **1 hora** entre visitas à mesma faixa para gerar comparações
4. Use a barra de ferramentas para:
   - Mover a barra de posição
   - Abrir o álbum de snapshots
   - Regenerar as imagens
5. Clique em um jogador no painel para ir até ele na tabela
6. No álbum, clique na imagem para abrir a versão em alta resolução

---

## 📁 Estrutura de Dados

Cada snapshot armazenado contém:

```json
{
  "id": "servidor|faixa|timestamp",
  "server": "hostname",
  "range": "1-50",
  "ts": 1790116650154,
  "title": "Comparativo 22/09/2026 19:30",
  "records": [ /* dados dos jogadores */ ],
  "baselineTs": 1790110000000,
  "images": {
    "comparison": { "url": "...", "medium": "...", "thumbnail": "..." },
    "panel": { "url": "...", "medium": "...", "thumbnail": "..." }
  },
  "upload": {
    "comparison": "ok",
    "panel": "ok"
  }
}
