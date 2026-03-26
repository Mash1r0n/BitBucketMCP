# BitBucket MCP — Streamable HTTP

MCP сервер для BitBucket Cloud з підтримкою **MCP Streamable HTTP транспорту** — сумісний з llama.cpp WebUI, Railway та будь-яким іншим MCP клієнтом.

Нуль зовнішніх залежностей — тільки вбудований Node.js `http` та `fetch`.

---

## Як це працює

llama.cpp WebUI підключається до сервера через стандартний протокол **JSON-RPC 2.0** по одному ендпоінту `/mcp`. Протокол:

```
llama.cpp → POST /mcp {"jsonrpc":"2.0","method":"initialize",...}
сервер    → {"jsonrpc":"2.0","result":{"protocolVersion":"2025-06-18",...}}

llama.cpp → POST /mcp {"jsonrpc":"2.0","method":"tools/list",...}
сервер    → {"jsonrpc":"2.0","result":{"tools":[...]}}

llama.cpp → POST /mcp {"jsonrpc":"2.0","method":"tools/call","params":{"name":"bb_list_repos",...}}
сервер    → {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"..."}]}}
```

---

## Встановлення

```bash
cd bitbucket-mcp-http
npm install   # залежностей немає, тільки генерує package-lock.json
```

---

## Запуск локально

**PowerShell:**
```powershell
$env:BITBUCKET_WORKSPACE="andriiChervak"
$env:BITBUCKET_USERNAME="твій_email@gmail.com"
$env:BITBUCKET_TOKEN="ATATT3xxx..."
node src/index.js
```

**cmd.exe:**
```cmd
set BITBUCKET_WORKSPACE=andriiChervak && set BITBUCKET_USERNAME=email@gmail.com && set BITBUCKET_TOKEN=ATATT3xxx && node src/index.js
```

Сервер запуститься на `http://localhost:3000/mcp`.

---

## Підключення до llama.cpp WebUI

1. Відкрий llama.cpp WebUI
2. Знайди розділ **MCP Servers** (або Tools → MCP)
3. Додай новий сервер:
   - URL: `http://localhost:3000/mcp` (локально) або `https://your-app.up.railway.app/mcp` (Railway)
4. Натисни **Connect** — llama.cpp автоматично виконає `initialize` і `tools/list`
5. Всі інструменти з'являться у списку доступних

> Якщо llama.cpp запущений локально і сервер теж локально — використовуй `http://127.0.0.1:3000/mcp`. Якщо llama.cpp на іншій машині — потрібен Railway або інший хостинг.

---

## Деплой на Railway

### 1. Завантаж на GitHub

### 2. New Project → Deploy from GitHub repo

### 3. Додай змінні у Railway → Variables:

| Змінна | Значення |
|---|---|
| `BITBUCKET_WORKSPACE` | `andriiChervak` |
| `BITBUCKET_USERNAME` | твій email на bitbucket.org |
| `BITBUCKET_TOKEN` | App Password з BitBucket |

### 4. Після деплою підключай у llama.cpp:

```
https://your-app.up.railway.app/mcp
```

---

## Змінні середовища

| Змінна | Обов'язкова | Опис |
|---|---|---|
| `BITBUCKET_WORKSPACE` | Так | Workspace slug, напр. `andriiChervak` |
| `BITBUCKET_USERNAME` | Так | Email або логін на bitbucket.org |
| `BITBUCKET_TOKEN` | Так | App Password (Repositories Read + Pull requests Read + Account Read) |
| `PORT` | Ні | Порт (Railway встановлює автоматично) |

---

## Ендпоінти

| Метод | Шлях | Призначення |
|---|---|---|
| `POST` | `/mcp` | Основний MCP ендпоінт (JSON-RPC 2.0) |
| `GET` | `/mcp` | Перевірка з'єднання (llama.cpp робить перед initialize) |
| `GET` | `/health` | Railway health check |

---

## Інструменти

| Інструмент | Обов'язкові параметри | Що робить |
|---|---|---|
| `bb_list_repos` | — | Список репозиторіїв workspace |
| `bb_list_prs` | `repo` | PR за станом та автором |
| `bb_get_pr` | `repo`, `pr_id` | Деталі PR |
| `bb_get_pr_comments` | `repo`, `pr_id` | Коментарі PR з кодом |
| `bb_search_pr_comments` | `repo`, `query` | Пошук по коментарях |
| `bb_search_inline_comments` | `repo`, `query` | Пошук тільки по inline з кодом |
| `bb_dump_all_inline_comments` | `repo` | Всі inline без фільтру |
| `bb_get_reviewer_patterns` | `repo`, `reviewer_slug` | Коментарі ревьюера з кодом |
| `bb_get_file_history` | `repo`, `file_path` | PR що торкались файлу |
| `bb_get_pr_diff` | `repo`, `pr_id` | Unified diff PR |
| `bb_get_branches` | `repo` | Гілки репо |
| `bb_get_file_content` | `repo`, `path` | Вміст файлу |

---

## Перевірка через curl

```bash
# Ініціалізація
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}'

# Список інструментів
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# Виклик інструменту
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"bb_list_repos","arguments":{}}}'
```

---

## Усунення проблем

**llama.cpp пише "Streamable HTTP error"**
Перевір що сервер запущений і доступний. Якщо llama.cpp і сервер на різних машинах — потрібен публічний URL (Railway).

**401 від BitBucket**
Перевір `BITBUCKET_USERNAME` — має бути email, не логін. Перегенеруй App Password з дозволами Account Read + Repositories Read + Pull requests Read.

**404 при зверненні до репо**
Використовуй slug репозиторію (частина URL на bitbucket.org), не display name.
