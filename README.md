# BitBucket Cloud API Server

REST API сервер для хостингу на Railway. Надає доступ до репозиторіїв, PR та коментарів BitBucket Cloud через прості HTTP запити — для використання з будь-якою LLM або сервісом.

---

## Ендпоінти

| Метод | Шлях | Що робить |
|---|---|---|
| `GET` | `/health` | Перевірка що сервер живий |
| `GET` | `/tools` | Список всіх інструментів з описом і параметрами |
| `POST` | `/tool` | Виклик інструменту |

---

## Деплой на Railway

### 1. Форкни або завантаж репозиторій на GitHub

### 2. Створи новий проєкт на Railway

- Зайди на [railway.app](https://railway.app)
- **New Project → Deploy from GitHub repo**
- Обери репозиторій

### 3. Додай змінні середовища

У Railway → твій проєкт → **Variables**:

| Змінна | Значення |
|---|---|
| `BITBUCKET_WORKSPACE` | `andriiChervak` (або твій workspace) |
| `BITBUCKET_USERNAME` | твій email на bitbucket.org |
| `BITBUCKET_TOKEN` | App Password з BitBucket |

### 4. Railway автоматично задеплоїть сервер

Після деплою отримаєш URL вигляду:
```
https://your-app.up.railway.app
```

### 5. Перевір що працює

```
https://your-app.up.railway.app/health
```

Повинно повернути:
```json
{ "status": "ok", "workspace": "andriiChervak" }
```

---

## Використання

### Отримати список інструментів

```
GET /tools
```

Повертає список всіх доступних інструментів з описом і параметрами.

### Викликати інструмент

```
POST /tool
Content-Type: application/json

{
  "name": "назва_інструменту",
  "args": { ...параметри }
}
```

Відповідь:
```json
{ "result": "текстовий результат" }
```

Помилка:
```json
{ "error": "опис помилки" }
```

---

## Інструменти

### bb_list_repos
Список репозиторіїв workspace.

```json
{ "name": "bb_list_repos", "args": {} }
{ "name": "bb_list_repos", "args": { "filter": "backend" } }
```

### bb_list_prs
PR репозиторію.

```json
{
  "name": "bb_list_prs",
  "args": { "repo": "my-backend", "state": "MERGED", "limit": 30 }
}
```

### bb_get_pr
Деталі конкретного PR.

```json
{
  "name": "bb_get_pr",
  "args": { "repo": "my-backend", "pr_id": 42 }
}
```

### bb_get_pr_comments
Всі коментарі PR з фрагментами коду.

```json
{
  "name": "bb_get_pr_comments",
  "args": { "repo": "my-backend", "pr_id": 42 }
}
```

```json
{
  "name": "bb_get_pr_comments",
  "args": { "repo": "my-backend", "pr_id": 42, "inline_only": true }
}
```

### bb_search_pr_comments
Пошук по коментарях всіх PR.

```json
{
  "name": "bb_search_pr_comments",
  "args": { "repo": "my-backend", "query": "error handling", "days": 365 }
}
```

### bb_search_inline_comments
Пошук тільки по inline-коментарях (з кодом). Найкращий для аналізу патернів команди.

```json
{
  "name": "bb_search_inline_comments",
  "args": { "repo": "my-backend", "query": "naming", "days": 365, "limit": 20 }
}
```

### bb_dump_all_inline_comments
Всі inline-коментарі всіх PR без фільтру. Повний дамп для аналізу.

```json
{
  "name": "bb_dump_all_inline_comments",
  "args": { "repo": "my-backend", "days": 365, "limit_prs": 100 }
}
```

### bb_get_reviewer_patterns
Всі коментарі конкретного ревьюера з кодом.

```json
{
  "name": "bb_get_reviewer_patterns",
  "args": { "repo": "my-backend", "reviewer_slug": "john.smith", "days": 180 }
}
```

### bb_get_file_history
PR що торкались файлу.

```json
{
  "name": "bb_get_file_history",
  "args": { "repo": "my-backend", "file_path": "src/services/auth.py" }
}
```

### bb_get_pr_diff
Unified diff PR.

```json
{
  "name": "bb_get_pr_diff",
  "args": { "repo": "my-backend", "pr_id": 42 }
}
```

### bb_get_branches
Гілки репозиторію.

```json
{
  "name": "bb_get_branches",
  "args": { "repo": "my-backend" }
}
```

### bb_get_file_content
Вміст файлу.

```json
{
  "name": "bb_get_file_content",
  "args": { "repo": "my-backend", "path": "src/services/auth.py", "ref": "main" }
}
```

---

## Приклади викликів з self-hosted LLM

### Python

```python
import requests

API_URL = "https://your-app.up.railway.app"

def call_tool(name, args={}):
    res = requests.post(f"{API_URL}/tool", json={"name": name, "args": args})
    return res.json()["result"]

# Отримати всі inline-коментарі по темі
patterns = call_tool("bb_search_inline_comments", {
    "repo": "my-backend",
    "query": "exception",
    "days": 365,
    "limit": 30,
})

# Передати в LLM для аналізу
prompt = f"""
Ось inline-коментарі ревьюерів до коду команди:

{patterns}

Сформулюй з них конкретні правила для .cursorrules файлу.
"""
```

### curl

```bash
curl -X POST https://your-app.up.railway.app/tool \
  -H "Content-Type: application/json" \
  -d '{"name": "bb_list_repos", "args": {}}'
```

---

## Формат відповіді для коментарів

```
▶ PR #42 «Refactor auth service»

📍 src/services/auth.py:87
┌─ код ──────────────────────────────────────
│     83    def authenticate(self, token):
│     84        try:
│     85            payload = jwt.decode(token)
│ >>> 87        except Exception as e:
│     88            raise e
└────────────────────────────────────────────
[John Smith, 15.03.2025]
Не перехоплюй без обробки — wrap у AuthError
```

---

## Локальний запуск

```bash
npm install

# PowerShell
$env:BITBUCKET_WORKSPACE="andriiChervak"
$env:BITBUCKET_USERNAME="твій_email@gmail.com"
$env:BITBUCKET_TOKEN="ATATT3xxx..."
npm start

# cmd.exe
set BITBUCKET_WORKSPACE=andriiChervak && set BITBUCKET_USERNAME=email@gmail.com && set BITBUCKET_TOKEN=ATATT3xxx && npm start
```

Сервер запуститься на `http://localhost:3000`.

---

## Різниця від MCP версії

| | MCP сервер | Цей сервер |
|---|---|---|
| Протокол | stdio (MCP) | HTTP REST |
| Використання | Тільки в Cursor | Будь-яка LLM, скрипт, сервіс |
| Хостинг | Локально на машині | Railway, Render, VPS |
| Аутентифікація | Не потрібна | Немає (Railway закриває) |
| Нові інструменти | `bb_get_pr_inline_comments` | `bb_dump_all_inline_comments` |
