#!/usr/bin/env node
/**
 * BitBucket Cloud REST API — для Railway
 * Всі ті самі інструменти що й у MCP сервері, але через HTTP
 *
 * POST /tool          — викликати інструмент
 * GET  /tools         — список доступних інструментів
 * GET  /health        — перевірка що сервер живий
 */

import express from "express";
import cors from "cors";

// ─── Конфіг ──────────────────────────────────────────────────────────────────
const BB_API      = "https://api.bitbucket.org/2.0";
const WORKSPACE   = process.env.BITBUCKET_WORKSPACE?.trim();
const BB_TOKEN    = process.env.BITBUCKET_TOKEN?.trim();
const BB_USERNAME = process.env.BITBUCKET_USERNAME?.trim();
const PORT        = process.env.PORT || 3000;

if (!WORKSPACE || !BB_TOKEN || !BB_USERNAME) {
  console.error("ERROR: BITBUCKET_WORKSPACE, BITBUCKET_USERNAME і BITBUCKET_TOKEN обов'язкові");
  process.exit(1);
}

const AUTH = `Basic ${Buffer.from(`${BB_USERNAME}:${BB_TOKEN}`).toString("base64")}`;

// ─── HTTP хелпери ─────────────────────────────────────────────────────────────
async function bbFetch(path, params = {}) {
  const url = path.startsWith("http")
    ? new URL(path)
    : new URL(`${BB_API}${path}`);

  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  const res = await fetch(url.toString(), {
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BitBucket API ${res.status} → ${url.pathname}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function bbFetchAll(path, params = {}, maxItems = 200) {
  const items = [];
  let nextUrl = null;

  const first = await bbFetch(path, { ...params, pagelen: 50 });
  items.push(...(first.values ?? []));
  nextUrl = first.next ?? null;

  while (nextUrl && items.length < maxItems) {
    const page = await bbFetch(nextUrl);
    items.push(...(page.values ?? []));
    nextUrl = page.next ?? null;
  }

  return items.slice(0, maxItems);
}

// ─── Форматування ─────────────────────────────────────────────────────────────
function fmtPR(pr) {
  return [
    `PR #${pr.id}: ${pr.title}`,
    `  Автор:   ${pr.author?.display_name ?? "—"}`,
    `  Стан:    ${pr.state}  |  Створено: ${new Date(pr.created_on).toLocaleDateString("uk")}`,
    `  Гілки:   ${pr.source?.branch?.name ?? "?"} → ${pr.destination?.branch?.name ?? "?"}`,
    pr.description ? `  Опис:    ${pr.description.slice(0, 120)}` : "",
    `  URL:     ${pr.links?.html?.href ?? "—"}`,
  ].filter(Boolean).join("\n");
}

function fmtInlineComment(c, anchorInfo, depth = 0) {
  const pad  = "  ".repeat(depth);
  const who  = c.user?.display_name ?? "—";
  const when = c.created_on ? new Date(c.created_on).toLocaleDateString("uk") : "—";
  const text = c.content?.raw?.trim() ?? "";
  const lines = [];

  if (anchorInfo?.isInline && anchorInfo.filePath) {
    lines.push(`${pad}📍 ${anchorInfo.filePath}` +
      (anchorInfo.lineNumber ? `:${anchorInfo.lineNumber}` : ""));
    if (anchorInfo.snippet) {
      lines.push(`${pad}┌─ код ──────────────────────────────────────`);
      anchorInfo.snippet.split("\n").forEach(l => lines.push(`${pad}│ ${l}`));
      lines.push(`${pad}└────────────────────────────────────────────`);
    }
  } else if (anchorInfo?.filePath) {
    lines.push(`${pad}📄 Коментар до файлу: ${anchorInfo.filePath}`);
  } else {
    lines.push(`${pad}💬 Загальний коментар до PR`);
  }

  lines.push(`${pad}[${who}, ${when}]`);
  lines.push(`${pad}${text}`);
  return lines.join("\n");
}

async function resolveCloudAnchor(repo, prId, inline) {
  if (!inline?.path) return { filePath: null, lineNumber: null, snippet: null, isInline: false };

  const filePath   = inline.path;
  const lineNumber = inline.to ?? inline.from ?? null;
  if (!lineNumber) return { filePath, lineNumber: null, snippet: null, isInline: true };

  const snippet = await fetchCloudFileLine(repo, filePath, lineNumber);
  return { filePath, lineNumber, snippet, isInline: true };
}

async function fetchCloudFileLine(repo, filePath, lineNumber) {
  try {
    const res = await fetch(
      `${BB_API}/repositories/${WORKSPACE}/${repo}/src/HEAD/${filePath}`,
      { headers: { Authorization: AUTH } },
    );
    if (!res.ok) return null;

    const text     = await res.text();
    const allLines = text.split("\n");
    const start    = Math.max(0, lineNumber - 5);
    const end      = Math.min(allLines.length - 1, lineNumber + 3);

    return allLines
      .slice(start, end + 1)
      .map((l, i) => {
        const num    = start + i + 1;
        const marker = num === lineNumber ? ">>>" : "   ";
        return `${marker} ${String(num).padStart(4, " ")}   ${l}`;
      })
      .join("\n");
  } catch {
    return null;
  }
}

// ─── Визначення інструментів ──────────────────────────────────────────────────
const TOOLS_SCHEMA = [
  {
    name: "bb_list_repos",
    description: "Список репозиторіїв workspace.",
    params: { filter: "string?" },
  },
  {
    name: "bb_list_prs",
    description: "PR репозиторію за станом та автором.",
    params: { repo: "string", state: "OPEN|MERGED|DECLINED (default: MERGED)", author: "string?", limit: "number?" },
  },
  {
    name: "bb_get_pr",
    description: "Деталі PR: автор, ревьюери, гілки, URL.",
    params: { repo: "string", pr_id: "number" },
  },
  {
    name: "bb_get_pr_comments",
    description: "Всі коментарі PR. Inline-коментарі з фрагментом коду.",
    params: { repo: "string", pr_id: "number", inline_only: "boolean?", file_filter: "string?" },
  },
  {
    name: "bb_search_pr_comments",
    description: "Пошук по коментарях всіх PR за ключовими словами.",
    params: { repo: "string", query: "string", days: "number?", limit: "number?", file_filter: "string?" },
  },
  {
    name: "bb_search_inline_comments",
    description: "Пошук тільки по inline-коментарях з кодом. Найкращий для аналізу патернів команди.",
    params: { repo: "string", query: "string", days: "number?", limit: "number?", file_filter: "string?" },
  },
  {
    name: "bb_get_reviewer_patterns",
    description: "Всі коментарі конкретного ревьюера з кодом.",
    params: { repo: "string", reviewer_slug: "string", days: "number?" },
  },
  {
    name: "bb_dump_all_inline_comments",
    description: "Всі inline-коментарі всіх PR репозиторію. Без фільтру — повний дамп для аналізу.",
    params: { repo: "string", days: "number?", limit_prs: "number?" },
  },
  {
    name: "bb_get_file_history",
    description: "PR що торкались конкретного файлу.",
    params: { repo: "string", file_path: "string", limit: "number?" },
  },
  {
    name: "bb_get_pr_diff",
    description: "Unified diff PR.",
    params: { repo: "string", pr_id: "number", path_filter: "string?" },
  },
  {
    name: "bb_get_branches",
    description: "Гілки репозиторію.",
    params: { repo: "string", filter: "string?" },
  },
  {
    name: "bb_get_file_content",
    description: "Вміст файлу з репо на гілці або коміті.",
    params: { repo: "string", path: "string", ref: "string?" },
  },
];

// ─── Обробники інструментів ───────────────────────────────────────────────────
async function handleTool(name, args = {}) {
  switch (name) {

    case "bb_list_repos": {
      const repos = await bbFetchAll(`/repositories/${WORKSPACE}`, {
        sort: "-updated_on",
        fields: "values.slug,values.name,values.language,values.updated_on,next",
      });
      const filtered = args.filter
        ? repos.filter(r => r.slug?.includes(args.filter) || r.name?.includes(args.filter))
        : repos;
      return filtered
        .map(r => `${r.slug}  [${r.language ?? "—"}]  оновлено: ${new Date(r.updated_on).toLocaleDateString("uk")}`)
        .join("\n") || "Репозиторіїв не знайдено.";
    }

    case "bb_list_prs": {
      const params = {
        state: args.state ?? "MERGED",
        fields: "values.id,values.title,values.state,values.author,values.source,values.destination,values.created_on,values.links,values.description,next",
      };
      if (args.author) params.q = `author.username="${args.author}"`;
      const prs = await bbFetchAll(
        `/repositories/${WORKSPACE}/${args.repo}/pullrequests`,
        params,
        args.limit ?? 30,
      );
      return prs.map(fmtPR).join("\n\n─────\n\n") || "PR не знайдено.";
    }

    case "bb_get_pr": {
      const pr = await bbFetch(
        `/repositories/${WORKSPACE}/${args.repo}/pullrequests/${args.pr_id}`,
      );
      const reviewers = (pr.reviewers ?? [])
        .map(r => `${r.display_name} (${r.approved ? "approved" : "pending"})`)
        .join(", ");
      return fmtPR(pr) + `\n  Ревьюери: ${reviewers || "—"}`;
    }

    case "bb_get_pr_comments": {
      const inlineOnly = args.inline_only ?? false;
      const comments   = await bbFetchAll(
        `/repositories/${WORKSPACE}/${args.repo}/pullrequests/${args.pr_id}/comments`,
        { fields: "values.id,values.content,values.user,values.created_on,values.inline,next" },
      );
      const filtered = comments.filter(c => {
        if (inlineOnly && !c.inline) return false;
        if (args.file_filter && c.inline?.path && !c.inline.path.includes(args.file_filter)) return false;
        return true;
      });
      if (!filtered.length) return "Коментарів не знайдено.";

      const inlineCount  = filtered.filter(c => c.inline).length;
      const generalCount = filtered.length - inlineCount;
      const header = `PR #${args.pr_id} — ${filtered.length} коментарів (${inlineCount} inline, ${generalCount} загальних)\n\n`;

      const parts = [];
      for (const c of filtered) {
        const info = c.inline
          ? await resolveCloudAnchor(args.repo, args.pr_id, c.inline)
          : { filePath: null, lineNumber: null, snippet: null, isInline: false };
        parts.push(fmtInlineComment(c, info));
      }
      return header + parts.join("\n\n" + "═".repeat(50) + "\n\n");
    }

    case "bb_search_pr_comments":
    case "bb_search_inline_comments": {
      const inlineOnly = name === "bb_search_inline_comments";
      const since      = Date.now() - (args.days ?? 180) * 86400_000;
      const queryLow   = args.query.toLowerCase();

      const prs = await bbFetchAll(
        `/repositories/${WORKSPACE}/${args.repo}/pullrequests`,
        { state: "MERGED", fields: "values.id,values.title,values.created_on,next" },
        200,
      );

      const results = [];
      for (const pr of prs.filter(p => new Date(p.created_on).getTime() >= since)) {
        if (results.length >= (args.limit ?? 30)) break;

        const comments = await bbFetchAll(
          `/repositories/${WORKSPACE}/${args.repo}/pullrequests/${pr.id}/comments`,
          { fields: "values.id,values.content,values.user,values.created_on,values.inline,next" },
        ).catch(() => []);

        for (const c of comments) {
          if (inlineOnly && !c.inline) continue;
          if (args.file_filter && c.inline?.path && !c.inline.path.includes(args.file_filter)) continue;
          const text = c.content?.raw ?? "";
          if (!text.toLowerCase().includes(queryLow)) continue;

          const info = c.inline
            ? await resolveCloudAnchor(args.repo, pr.id, c.inline)
            : { filePath: null, lineNumber: null, snippet: null, isInline: false };

          results.push(`▶ PR #${pr.id} «${pr.title}»\n` + fmtInlineComment(c, info));
          if (results.length >= (args.limit ?? 30)) break;
        }
      }

      return results.length
        ? `Знайдено ${results.length} коментарів за запитом «${args.query}»:\n\n` +
          results.join("\n\n" + "═".repeat(50) + "\n\n")
        : `Нічого не знайдено за запитом «${args.query}».`;
    }

    case "bb_dump_all_inline_comments": {
      const since    = Date.now() - (args.days ?? 365) * 86400_000;
      const limitPrs = args.limit_prs ?? 100;

      const prs = await bbFetchAll(
        `/repositories/${WORKSPACE}/${args.repo}/pullrequests`,
        { state: "MERGED", fields: "values.id,values.title,values.created_on,next" },
        limitPrs,
      );

      const results = [];
      for (const pr of prs.filter(p => new Date(p.created_on).getTime() >= since)) {
        const comments = await bbFetchAll(
          `/repositories/${WORKSPACE}/${args.repo}/pullrequests/${pr.id}/comments`,
          { fields: "values.id,values.content,values.user,values.created_on,values.inline,next" },
        ).catch(() => []);

        const inlineComments = comments.filter(c => c.inline);
        if (!inlineComments.length) continue;

        const parts = [];
        for (const c of inlineComments) {
          const info = await resolveCloudAnchor(args.repo, pr.id, c.inline);
          parts.push(fmtInlineComment(c, info));
        }

        results.push(
          `${"▶".repeat(3)} PR #${pr.id} «${pr.title}» (${inlineComments.length} inline коментарів)\n\n` +
          parts.join("\n\n" + "─".repeat(40) + "\n\n"),
        );
      }

      if (!results.length) return "Inline-коментарів не знайдено.";

      return (
        `Всього PR з inline-коментарями: ${results.length}\n\n` +
        results.join("\n\n" + "═".repeat(60) + "\n\n")
      );
    }

    case "bb_get_reviewer_patterns": {
      const since = Date.now() - (args.days ?? 365) * 86400_000;
      const prs   = await bbFetchAll(
        `/repositories/${WORKSPACE}/${args.repo}/pullrequests`,
        { state: "MERGED", fields: "values.id,values.title,values.created_on,next" },
        300,
      );

      const parts = [];
      for (const pr of prs.filter(p => new Date(p.created_on).getTime() >= since)) {
        const comments = await bbFetchAll(
          `/repositories/${WORKSPACE}/${args.repo}/pullrequests/${pr.id}/comments`,
          { fields: "values.id,values.content,values.user,values.created_on,values.inline,next" },
        ).catch(() => []);

        for (const c of comments) {
          if (c.user?.nickname !== args.reviewer_slug &&
              c.user?.account_id !== args.reviewer_slug) continue;
          const text = c.content?.raw?.trim() ?? "";
          if (!text || text.length < 15) continue;

          const info = c.inline
            ? await resolveCloudAnchor(args.repo, pr.id, c.inline)
            : { filePath: null, lineNumber: null, snippet: null, isInline: false };

          parts.push(`▶ PR #${pr.id} «${pr.title}»\n` + fmtInlineComment(c, info));
        }
      }

      return parts.length
        ? `Коментарі «${args.reviewer_slug}» (${parts.length} шт.):\n\n` +
          parts.join("\n\n" + "═".repeat(50) + "\n\n")
        : `Коментарів від «${args.reviewer_slug}» не знайдено.`;
    }

    case "bb_get_file_history": {
      const prs = await bbFetchAll(
        `/repositories/${WORKSPACE}/${args.repo}/pullrequests`,
        { state: "MERGED", fields: "values.id,values.title,values.state,values.author,values.source,values.destination,values.created_on,values.links,values.description,next" },
        200,
      );
      const matched = [];
      for (const pr of prs) {
        const diffstat = await bbFetch(
          `/repositories/${WORKSPACE}/${args.repo}/pullrequests/${pr.id}/diffstat`,
        ).catch(() => ({ values: [] }));
        const hasFile = (diffstat.values ?? []).some(
          f => (f.new?.path ?? f.old?.path ?? "").includes(args.file_path),
        );
        if (hasFile) {
          matched.push(fmtPR(pr));
          if (matched.length >= (args.limit ?? 20)) break;
        }
      }
      return matched.length
        ? `PR що торкались «${args.file_path}»:\n\n` + matched.join("\n\n─────\n\n")
        : `Жодного PR не знайдено для файлу «${args.file_path}».`;
    }

    case "bb_get_pr_diff": {
      const res = await fetch(
        `${BB_API}/repositories/${WORKSPACE}/${args.repo}/pullrequests/${args.pr_id}/diff`,
        { headers: { Authorization: AUTH } },
      );
      if (!res.ok) throw new Error(`diff API: ${res.status}`);
      const text = await res.text();
      if (!args.path_filter) return text.slice(0, 12000);
      const sections = text.split(/^(?=diff --git)/m);
      const filtered = sections.filter(s => s.includes(args.path_filter));
      return filtered.join("").slice(0, 12000) || "Файлів за фільтром не знайдено.";
    }

    case "bb_get_branches": {
      const branches = await bbFetchAll(
        `/repositories/${WORKSPACE}/${args.repo}/refs/branches`,
        args.filter ? { q: `name ~ "${args.filter}"` } : {},
      );
      return branches
        .map(b => `${b.name}  [${b.target?.hash?.slice(0, 7) ?? "—"}]`)
        .join("\n") || "Гілок не знайдено.";
    }

    case "bb_get_file_content": {
      const ref = args.ref ?? "HEAD";
      const res = await fetch(
        `${BB_API}/repositories/${WORKSPACE}/${args.repo}/src/${ref}/${args.path}`,
        { headers: { Authorization: AUTH } },
      );
      if (!res.ok) throw new Error(`Файл не знайдено: ${res.status}`);
      const text = await res.text();
      return text.slice(0, 8000);
    }

    default:
      throw new Error(`Невідомий інструмент: ${name}`);
  }
}

// ─── Express додаток ──────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// GET /health — перевірка що сервер живий
app.get("/health", (req, res) => {
  res.json({ status: "ok", workspace: WORKSPACE });
});

// GET /tools — список доступних інструментів з описом і параметрами
app.get("/tools", (req, res) => {
  res.json({ tools: TOOLS_SCHEMA });
});

// POST /tool — виклик інструменту
// Body: { "name": "bb_list_repos", "args": { "filter": "backend" } }
app.post("/tool", async (req, res) => {
  const { name, args } = req.body ?? {};

  if (!name) {
    return res.status(400).json({ error: 'Поле "name" обов\'язкове' });
  }

  const known = TOOLS_SCHEMA.find(t => t.name === name);
  if (!known) {
    return res.status(404).json({
      error: `Невідомий інструмент: ${name}`,
      available: TOOLS_SCHEMA.map(t => t.name),
    });
  }

  try {
    const result = await handleTool(name, args ?? {});
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`BitBucket API сервер запущено на порту ${PORT}`);
  console.log(`Workspace: ${WORKSPACE}`);
  console.log(`Доступні ендпоінти:`);
  console.log(`  GET  /health`);
  console.log(`  GET  /tools`);
  console.log(`  POST /tool`);
});
