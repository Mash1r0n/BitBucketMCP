#!/usr/bin/env node
/**
 * BitBucket Cloud MCP — Streamable HTTP transport
 * Сумісний з llama.cpp WebUI (і будь-яким іншим MCP клієнтом)
 *
 * Протокол: JSON-RPC 2.0 через POST /mcp
 * Документація: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 *
 * Змінні середовища:
 *   BITBUCKET_WORKSPACE  — наприклад: andriiChervak
 *   BITBUCKET_USERNAME   — email або логін на bitbucket.org
 *   BITBUCKET_TOKEN      — App Password
 *   PORT                 — порт (за замовчуванням 3000)
 */

import http from "http";

// ─── Конфіг ──────────────────────────────────────────────────────────────────
const BB_API      = "https://api.bitbucket.org/2.0";
const WORKSPACE   = process.env.BITBUCKET_WORKSPACE?.trim();
const BB_USERNAME = process.env.BITBUCKET_USERNAME?.trim();
const BB_TOKEN    = process.env.BITBUCKET_TOKEN?.trim();
const PORT        = parseInt(process.env.PORT || "3000", 10);

if (!WORKSPACE || !BB_USERNAME || !BB_TOKEN) {
  process.stderr.write(
    "ERROR: потрібні змінні BITBUCKET_WORKSPACE, BITBUCKET_USERNAME, BITBUCKET_TOKEN\n",
  );
  process.exit(1);
}

const AUTH = `Basic ${Buffer.from(`${BB_USERNAME}:${BB_TOKEN}`).toString("base64")}`;

// ─── BitBucket API хелпери ────────────────────────────────────────────────────
async function bbFetch(path, params = {}) {
  const url = path.startsWith("http") ? new URL(path) : new URL(`${BB_API}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  const res = await fetch(url.toString(), {
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BitBucket ${res.status}: ${text.slice(0, 200)}`);
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
    `  Автор:  ${pr.author?.display_name ?? "—"}`,
    `  Стан:   ${pr.state}  |  ${new Date(pr.created_on).toLocaleDateString("uk")}`,
    `  Гілки:  ${pr.source?.branch?.name ?? "?"} → ${pr.destination?.branch?.name ?? "?"}`,
    pr.description ? `  Опис:   ${pr.description.slice(0, 120)}` : "",
    `  URL:    ${pr.links?.html?.href ?? "—"}`,
  ].filter(Boolean).join("\n");
}

function fmtComment(c, anchorInfo) {
  const who  = c.user?.display_name ?? "—";
  const when = c.created_on ? new Date(c.created_on).toLocaleDateString("uk") : "—";
  const text = c.content?.raw?.trim() ?? "";
  const lines = [];

  if (anchorInfo?.isInline && anchorInfo.filePath) {
    lines.push(`📍 ${anchorInfo.filePath}${anchorInfo.lineNumber ? `:${anchorInfo.lineNumber}` : ""}`);
    if (anchorInfo.snippet) {
      lines.push("┌─ код ──────────────────────────────────────");
      anchorInfo.snippet.split("\n").forEach(l => lines.push(`│ ${l}`));
      lines.push("└────────────────────────────────────────────");
    }
  } else if (anchorInfo?.filePath) {
    lines.push(`📄 Коментар до файлу: ${anchorInfo.filePath}`);
  } else {
    lines.push("💬 Загальний коментар до PR");
  }

  lines.push(`[${who}, ${when}]`);
  lines.push(text);
  return lines.join("\n");
}

async function resolveAnchor(repo, prId, inline) {
  if (!inline?.path) return { filePath: null, lineNumber: null, snippet: null, isInline: false };
  const filePath   = inline.path;
  const lineNumber = inline.to ?? inline.from ?? null;
  if (!lineNumber) return { filePath, lineNumber: null, snippet: null, isInline: true };

  try {
    const res = await fetch(
      `${BB_API}/repositories/${WORKSPACE}/${repo}/src/HEAD/${filePath}`,
      { headers: { Authorization: AUTH } },
    );
    if (!res.ok) return { filePath, lineNumber, snippet: null, isInline: true };
    const text  = await res.text();
    const lines = text.split("\n");
    const start = Math.max(0, lineNumber - 5);
    const end   = Math.min(lines.length - 1, lineNumber + 3);
    const snippet = lines.slice(start, end + 1)
      .map((l, i) => {
        const n = start + i + 1;
        return `${n === lineNumber ? ">>>" : "   "} ${String(n).padStart(4)}   ${l}`;
      })
      .join("\n");
    return { filePath, lineNumber, snippet, isInline: true };
  } catch {
    return { filePath, lineNumber, snippet: null, isInline: true };
  }
}

// ─── Логіка інструментів ──────────────────────────────────────────────────────
async function runTool(name, args = {}) {
  switch (name) {

    case "bb_list_repos": {
      const repos = await bbFetchAll(`/repositories/${WORKSPACE}`, {
        sort: "-updated_on",
        fields: "values.slug,values.name,values.language,values.updated_on,next",
      });
      const list = args.filter
        ? repos.filter(r => r.slug?.includes(args.filter) || r.name?.includes(args.filter))
        : repos;
      return list.map(r =>
        `${r.slug}  [${r.language ?? "—"}]  ${new Date(r.updated_on).toLocaleDateString("uk")}`,
      ).join("\n") || "Репозиторіїв не знайдено.";
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
        .map(r => `${r.display_name} (${r.approved ? "✓" : "pending"})`)
        .join(", ");
      return fmtPR(pr) + `\n  Ревьюери: ${reviewers || "—"}`;
    }

    case "bb_get_pr_comments": {
      const inlineOnly = args.inline_only ?? false;
      const comments = await bbFetchAll(
        `/repositories/${WORKSPACE}/${args.repo}/pullrequests/${args.pr_id}/comments`,
        { fields: "values.id,values.content,values.user,values.created_on,values.inline,next" },
      );
      const filtered = comments.filter(c => {
        if (inlineOnly && !c.inline) return false;
        if (args.file_filter && c.inline?.path && !c.inline.path.includes(args.file_filter)) return false;
        return true;
      });
      if (!filtered.length) return "Коментарів не знайдено.";

      const parts = [];
      for (const c of filtered) {
        const info = c.inline
          ? await resolveAnchor(args.repo, args.pr_id, c.inline)
          : { filePath: null, lineNumber: null, snippet: null, isInline: false };
        parts.push(fmtComment(c, info));
      }
      const ic = filtered.filter(c => c.inline).length;
      return `PR #${args.pr_id}: ${filtered.length} коментарів (${ic} inline, ${filtered.length - ic} загальних)\n\n` +
        parts.join("\n\n" + "═".repeat(50) + "\n\n");
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
          if (!(c.content?.raw ?? "").toLowerCase().includes(queryLow)) continue;
          const info = c.inline
            ? await resolveAnchor(args.repo, pr.id, c.inline)
            : { filePath: null, lineNumber: null, snippet: null, isInline: false };
          results.push(`▶ PR #${pr.id} «${pr.title}»\n` + fmtComment(c, info));
          if (results.length >= (args.limit ?? 30)) break;
        }
      }
      return results.length
        ? `Знайдено ${results.length} за «${args.query}»:\n\n` +
          results.join("\n\n" + "═".repeat(50) + "\n\n")
        : `Нічого не знайдено за «${args.query}».`;
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
        const inline = comments.filter(c => c.inline);
        if (!inline.length) continue;
        const parts = [];
        for (const c of inline) {
          const info = await resolveAnchor(args.repo, pr.id, c.inline);
          parts.push(fmtComment(c, info));
        }
        results.push(
          `▶▶▶ PR #${pr.id} «${pr.title}» (${inline.length} inline)\n\n` +
          parts.join("\n\n" + "─".repeat(40) + "\n\n"),
        );
      }
      return results.length
        ? `PR з inline-коментарями: ${results.length}\n\n` +
          results.join("\n\n" + "═".repeat(60) + "\n\n")
        : "Inline-коментарів не знайдено.";
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
          if (c.user?.nickname !== args.reviewer_slug) continue;
          const text = c.content?.raw?.trim() ?? "";
          if (text.length < 15) continue;
          const info = c.inline
            ? await resolveAnchor(args.repo, pr.id, c.inline)
            : { filePath: null, lineNumber: null, snippet: null, isInline: false };
          parts.push(`▶ PR #${pr.id} «${pr.title}»\n` + fmtComment(c, info));
        }
      }
      return parts.length
        ? `Коментарі «${args.reviewer_slug}» (${parts.length}):\n\n` +
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
        if ((diffstat.values ?? []).some(f => (f.new?.path ?? f.old?.path ?? "").includes(args.file_path))) {
          matched.push(fmtPR(pr));
          if (matched.length >= (args.limit ?? 20)) break;
        }
      }
      return matched.length
        ? `PR що торкались «${args.file_path}»:\n\n` + matched.join("\n\n─────\n\n")
        : `Жодного PR для «${args.file_path}».`;
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
      return sections.filter(s => s.includes(args.path_filter)).join("").slice(0, 12000)
        || "Файлів за фільтром не знайдено.";
    }

    case "bb_get_branches": {
      const branches = await bbFetchAll(
        `/repositories/${WORKSPACE}/${args.repo}/refs/branches`,
        args.filter ? { q: `name ~ "${args.filter}"` } : {},
      );
      return branches.map(b => `${b.name}  [${b.target?.hash?.slice(0, 7) ?? "—"}]`).join("\n")
        || "Гілок не знайдено.";
    }

    case "bb_get_file_content": {
      const ref = args.ref ?? "HEAD";
      const res = await fetch(
        `${BB_API}/repositories/${WORKSPACE}/${args.repo}/src/${ref}/${args.path}`,
        { headers: { Authorization: AUTH } },
      );
      if (!res.ok) throw new Error(`Файл не знайдено: ${res.status}`);
      return (await res.text()).slice(0, 8000);
    }

    default:
      throw new Error(`Невідомий інструмент: ${name}`);
  }
}

// ─── Схема інструментів (MCP tools/list формат) ───────────────────────────────
const TOOLS = [
  {
    name: "bb_list_repos",
    description: "Список репозиторіїв BitBucket workspace.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Фільтр за назвою (опціонально)" },
      },
    },
  },
  {
    name: "bb_list_prs",
    description: "PR репозиторію за станом (OPEN/MERGED/DECLINED) та автором.",
    inputSchema: {
      type: "object",
      properties: {
        repo:   { type: "string" },
        state:  { type: "string", enum: ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"], default: "MERGED" },
        author: { type: "string" },
        limit:  { type: "number" },
      },
      required: ["repo"],
    },
  },
  {
    name: "bb_get_pr",
    description: "Деталі PR: автор, ревьюери, гілки, URL.",
    inputSchema: {
      type: "object",
      properties: {
        repo:  { type: "string" },
        pr_id: { type: "number" },
      },
      required: ["repo", "pr_id"],
    },
  },
  {
    name: "bb_get_pr_comments",
    description: "Всі коментарі PR. Inline-коментарі з фрагментом коду (файл + рядок ±4 рядки).",
    inputSchema: {
      type: "object",
      properties: {
        repo:        { type: "string" },
        pr_id:       { type: "number" },
        inline_only: { type: "boolean", default: false },
        file_filter: { type: "string" },
      },
      required: ["repo", "pr_id"],
    },
  },
  {
    name: "bb_search_pr_comments",
    description: "Пошук по коментарях всіх PR за ключовими словами. Результати з кодом.",
    inputSchema: {
      type: "object",
      properties: {
        repo:        { type: "string" },
        query:       { type: "string" },
        days:        { type: "number", default: 180 },
        limit:       { type: "number", default: 30 },
        file_filter: { type: "string" },
      },
      required: ["repo", "query"],
    },
  },
  {
    name: "bb_search_inline_comments",
    description: "Пошук тільки по inline-коментарях з кодом. Найкращий для аналізу патернів команди.",
    inputSchema: {
      type: "object",
      properties: {
        repo:        { type: "string" },
        query:       { type: "string" },
        days:        { type: "number", default: 180 },
        limit:       { type: "number", default: 20 },
        file_filter: { type: "string" },
      },
      required: ["repo", "query"],
    },
  },
  {
    name: "bb_dump_all_inline_comments",
    description: "Всі inline-коментарі всіх PR без фільтру. Повний дамп для аналізу патернів команди.",
    inputSchema: {
      type: "object",
      properties: {
        repo:      { type: "string" },
        days:      { type: "number", default: 365 },
        limit_prs: { type: "number", default: 100 },
      },
      required: ["repo"],
    },
  },
  {
    name: "bb_get_reviewer_patterns",
    description: "Всі коментарі конкретного ревьюера з кодом що їх спричинив.",
    inputSchema: {
      type: "object",
      properties: {
        repo:          { type: "string" },
        reviewer_slug: { type: "string" },
        days:          { type: "number", default: 365 },
      },
      required: ["repo", "reviewer_slug"],
    },
  },
  {
    name: "bb_get_file_history",
    description: "PR що торкались конкретного файлу.",
    inputSchema: {
      type: "object",
      properties: {
        repo:      { type: "string" },
        file_path: { type: "string" },
        limit:     { type: "number", default: 20 },
      },
      required: ["repo", "file_path"],
    },
  },
  {
    name: "bb_get_pr_diff",
    description: "Unified diff PR.",
    inputSchema: {
      type: "object",
      properties: {
        repo:        { type: "string" },
        pr_id:       { type: "number" },
        path_filter: { type: "string" },
      },
      required: ["repo", "pr_id"],
    },
  },
  {
    name: "bb_get_branches",
    description: "Гілки репозиторію.",
    inputSchema: {
      type: "object",
      properties: {
        repo:   { type: "string" },
        filter: { type: "string" },
      },
      required: ["repo"],
    },
  },
  {
    name: "bb_get_file_content",
    description: "Вміст файлу на гілці або коміті.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        path: { type: "string" },
        ref:  { type: "string", default: "HEAD" },
      },
      required: ["repo", "path"],
    },
  },
];

// ─── JSON-RPC 2.0 обробник ────────────────────────────────────────────────────
async function handleJsonRpc(message) {
  const { jsonrpc, id, method, params } = message;

  // Notification (без id) — не потребує відповіді
  if (id === undefined || id === null) return null;

  const ok  = result      => ({ jsonrpc: "2.0", id, result });
  const err = (code, msg) => ({ jsonrpc: "2.0", id, error: { code, message: msg } });

  try {
    switch (method) {

      case "initialize":
        return ok({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "bitbucket-mcp", version: "1.0.0" },
          instructions: `BitBucket Cloud MCP для workspace "${WORKSPACE}". Всі інструменти починаються з bb_.`,
        });

      case "tools/list":
        return ok({ tools: TOOLS });

      case "tools/call": {
        const toolName = params?.name;
        const toolArgs = params?.arguments ?? {};
        if (!toolName) return err(-32602, "name обов'язковий");
        if (!TOOLS.find(t => t.name === toolName)) {
          return err(-32602, `Невідомий інструмент: ${toolName}`);
        }
        const result = await runTool(toolName, toolArgs);
        return ok({ content: [{ type: "text", text: result }] });
      }

      case "ping":
        return ok({});

      default:
        return err(-32601, `Невідомий метод: ${method}`);
    }
  } catch (e) {
    return err(-32603, e.message);
  }
}

// ─── HTTP сервер ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS — потрібен для llama.cpp WebUI (браузер)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const path = new URL(req.url, `http://localhost`).pathname;

  // GET /mcp — llama.cpp перевіряє що сервер живий
  if (req.method === "GET" && path === "/mcp") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: "bitbucket-mcp", version: "1.0.0", workspace: WORKSPACE }));
    return;
  }

  // GET /health — Railway health check
  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", workspace: WORKSPACE }));
    return;
  }

  // POST /mcp — основний MCP ендпоінт (JSON-RPC 2.0)
  if (req.method === "POST" && path === "/mcp") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0", id: null,
          error: { code: -32700, message: "Parse error" },
        }));
        return;
      }

      // Підтримка batch запитів
      const isBatch  = Array.isArray(message);
      const messages = isBatch ? message : [message];
      const responses = (await Promise.all(messages.map(handleJsonRpc))).filter(Boolean);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(isBatch ? responses : responses[0]));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found. MCP endpoint: POST /mcp" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`BitBucket MCP (Streamable HTTP) запущено`);
  console.log(`Workspace:    ${WORKSPACE}`);
  console.log(`MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  console.log(`Health:       http://0.0.0.0:${PORT}/health`);
});
