# BitBucket Cloud MCP для Cursor

MCP сервер для **BitBucket Cloud** (bitbucket.org). Дає Cursor живий доступ до репозиторіїв, PR та коментарів ревью вашого workspace.

Ключова особливість: inline-коментарі показуються **разом із фрагментом коду** — Cursor бачить не просто зауваження ревьюера, а конкретний рядок що його спричинив (±4 рядки контексту).

---

## Вимоги

- [Node.js](https://nodejs.org/) 18 або новіший
- Акаунт на bitbucket.org
- [Cursor](https://cursor.sh/) з підтримкою MCP

---

## Встановлення

### 1. Встановити залежності

```bash
cd bitbucket-mcp
npm install
```

### 2. Створити App Password у BitBucket

1. Зайди на **bitbucket.org → твій аватар → Personal settings**
2. У лівому меню → **App passwords → Create app password**
3. Назва: `cursor-mcp` (або будь-яка)
4. Постав галочки:
   - **Repositories → Read**
   - **Pull requests → Read**
5. Натисни **Create** — скопіюй пароль одразу, він показується лише раз

### 3. Налаштувати Cursor

Відкрий або створи файл `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "bitbucket": {
      "command": "node",
      "args": ["C:/absolute/path/to/bitbucket-mcp/src/index.js"],
      "env": {
        "BITBUCKET_WORKSPACE": "andriiChervak",
        "BITBUCKET_USERNAME": "твій_логін_на_bitbucket.org",
        "BITBUCKET_TOKEN": "згенерований_app_password"
      }
    }
  }
}
```

> На Windows використовуй прямі слеші або подвійні зворотні: `C:/Users/...` або `C:\\Users\\...`

Після збереження **повністю перезапусти Cursor**. У лівій панелі з'явиться індикатор MCP із зеленим кружечком.

### 4. Перевірити що все працює

У чаті Cursor напиши:

```
@bitbucket bb_list_repos
```

Повинен з'явитись список твоїх репозиторіїв.

---

## Змінні середовища

| Змінна | Обов'язкова | Опис |
|---|---|---|
| `BITBUCKET_WORKSPACE` | Так | Твій workspace slug, наприклад `andriiChervak` |
| `BITBUCKET_USERNAME` | Так | Логін на bitbucket.org |
| `BITBUCKET_TOKEN` | Так | App Password згенерований у налаштуваннях |

> **Де знайти workspace slug:** це частина URL твоїх репозиторіїв — `bitbucket.org/{workspace}/{repo}`

---

## Інструменти

### Навігація

| Інструмент | Параметри | Що робить |
|---|---|---|
| `bb_list_repos` | `filter?` | Список репозиторіїв workspace |
| `bb_list_prs` | `repo`, `state?`, `author?`, `limit?` | PR за станом: OPEN / MERGED / DECLINED |
| `bb_get_pr` | `repo`, `pr_id` | Деталі PR: автор, ревьюери, гілки, URL |
| `bb_get_pr_diff` | `repo`, `pr_id`, `path_filter?` | Unified diff PR, з фільтром за файлом |
| `bb_get_branches` | `repo`, `filter?` | Гілки репозиторію |
| `bb_get_file_content` | `repo`, `path`, `ref?` | Вміст файлу на гілці або коміті |
| `bb_get_file_history` | `repo`, `file_path`, `limit?` | Які PR торкались файлу |

### Коментарі з прив'язкою до коду

| Інструмент | Параметри | Що робить |
|---|---|---|
| `bb_get_pr_comments` | `repo`, `pr_id`, `inline_only?`, `file_filter?` | Всі коментарі PR з фрагментами коду |
| `bb_get_pr_inline_comments` | `repo`, `pr_id`, `file_filter?` | Тільки inline (до рядків), з кодом |
| `bb_search_pr_comments` | `repo`, `query`, `days?`, `limit?`, `file_filter?` | Пошук по коментарях всіх PR |
| `bb_search_inline_comments` | `repo`, `query`, `days?`, `limit?`, `file_filter?` | Пошук тільки по inline-коментарях |
| `bb_get_reviewer_patterns` | `repo`, `reviewer_slug`, `days?` | Всі коментарі конкретного ревьюера з кодом |

---

## Формат відповіді для коментарів

```
▶ PR #42 «Refactor auth service»

📍 src/services/auth.py:87
┌─ код ──────────────────────────────────────
│     83    def authenticate(self, token):
│     84        try:
│     85            payload = jwt.decode(token)
│     86            return payload
│ >>> 87        except Exception as e:
│     88            raise e
│     89
└────────────────────────────────────────────
[John Smith, 15.03.2025]
Не перехоплюй і не перекидай без обробки.
Або логуй і re-raise, або wrap у AuthError.
```

Рядок із `>>>` — саме той рядок до якого залишено коментар.

---

## Приклади промптів у Cursor

### Дізнатись патерни команди

```
@bitbucket bb_search_inline_comments repo=my-backend
query="exception" days=365
Що команда вважає неправильним в обробці виключень?
Сформулюй як правила для .cursorrules
```

```
@bitbucket bb_get_reviewer_patterns repo=my-backend
reviewer_slug=john.smith days=180
Які зауваження він залишає найчастіше?
```

### Написати код у стилі команди

```
@bitbucket bb_search_inline_comments repo=my-backend
query="endpoint" days=365
Подивись які зауваження до ендпоінтів.
Напиши POST /api/v1/payments дотримуючись цих стандартів.
```

### Розібратись чому файл такий

```
@bitbucket bb_get_file_history repo=my-backend
file_path=src/services/auth.py
Для знайдених PR покажи inline-коментарі через
bb_get_pr_inline_comments. Чому клас побудований саме так?
```

### Перевірити свій код перед PR

```
@bitbucket bb_get_reviewer_patterns repo=my-backend
reviewer_slug=senior.dev days=365
Перевір мій файл src/services/payments.py
на відповідність його типовим зауваженням.
```

---

## Рекомендовані розширення для Cursor

Щоб ще краще тюнінгувати Cursor під кодову базу — додай ці MCP сервери поряд із BitBucket:

### Postgres / MySQL — схема бази даних

Cursor отримує живу схему і генерує запити без галюцинацій щодо назв таблиць.

```bash
npm install -g @modelcontextprotocol/server-postgres
```

```json
"postgres": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-postgres"],
  "env": {
    "POSTGRES_CONNECTION_STRING": "postgresql://user:pass@localhost:5432/mydb"
  }
}
```

> Підключай тільки до read-only репліки, не до production master.

### Filesystem — суміжні репозиторії та документація

Якщо є кілька репозиторіїв або внутрішня документація в markdown — Cursor зможе читати їх через `@filesystem`.

```json
"filesystem": {
  "command": "npx",
  "args": [
    "-y",
    "@modelcontextprotocol/server-filesystem",
    "C:/projects/shared-libs",
    "C:/projects/internal-docs"
  ]
}
```

### GitHub — якщо частина коду на GitHub

Офіційний MCP від GitHub з пошуком по issues, PR та коду.

```bash
npm install -g @modelcontextprotocol/server-github
```

```json
"github": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
  }
}
```

### Повний `mcp.json` з усіма серверами

```json
{
  "mcpServers": {
    "bitbucket": {
      "command": "node",
      "args": ["C:/path/to/bitbucket-mcp/src/index.js"],
      "env": {
        "BITBUCKET_WORKSPACE": "andriiChervak",
        "BITBUCKET_USERNAME": "твій_логін",
        "BITBUCKET_TOKEN": "app_password"
      }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {
        "POSTGRES_CONNECTION_STRING": "postgresql://user:pass@localhost:5432/mydb"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "C:/projects/shared-libs"
      ]
    }
  }
}
```

---

## Конфіденційність

Сервер працює як локальний Node.js процес на твоїй машині.

- Запити йдуть з твоєї машини напряму до `api.bitbucket.org`
- Тексти коментарів і фрагменти коду потрапляють у контекст Cursor
- Cursor передає контекст до LLM (Claude / GPT-4 залежно від налаштувань)
- При ввімкненому **Privacy Mode** (`Settings → Privacy`) ці дані не зберігаються на серверах Anthropic

Для повної ізоляції (якщо код конфіденційний) — використовуй self-hosted модель:

```json
"bitbucket": {
  ...
  "env": {
    ...
  }
}
```

А в Cursor `Settings → Models` вкажи `API Base URL` свого локального vLLM або Ollama сервера.

---

## Усунення проблем

**`fetch failed` при першому запуску**
Перевір що `BITBUCKET_WORKSPACE`, `BITBUCKET_USERNAME` і `BITBUCKET_TOKEN` всі задані у `mcp.json`. Переконайся що workspace slug написаний правильно (він є в URL твоїх репо на bitbucket.org).

**`401 Unauthorized`**
App Password введено неправильно або у нього недостатньо дозволів. Перегенеруй з дозволами `Repositories: Read` + `Pull requests: Read`.

**`404 Not Found` при зверненні до репо**
Перевір slug репозиторію — він є в URL: `bitbucket.org/{workspace}/{repo-slug}`. Використовуй саме `repo-slug`, не назву відображення.

**Сервер не з'являється в Cursor**
Переконайся що шлях у `args` абсолютний і використовує прямі слеші. Після зміни `mcp.json` — повний перезапуск Cursor обов'язковий.

**PowerShell блокує `npm install`**
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```
Або запускай через `cmd.exe` а не PowerShell.

---

## Розробка

```bash
# Запуск з авто-перезавантаженням
$env:BITBUCKET_WORKSPACE="andriiChervak"
$env:BITBUCKET_USERNAME="твій_логін"
$env:BITBUCKET_TOKEN="app_password"
npm run dev

# Додати новий інструмент:
# 1. Додати об'єкт у масив TOOLS з name, description, inputSchema
# 2. Додати case у switch в handleTool()
# 3. Для коментарів з кодом — використати resolveCloudAnchor() + fmtInlineComment()
```
#   B i t B u c k e t M C P  
 