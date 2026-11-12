"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { Answer, ContextFragment, Settings, Source } from "@/lib/types";
type Doc = {
  id: string;
  name: string;
  versions: { id: string; checksum: string; _count: { chunks: number } }[];
};
type Article = { articleId: string; title: string; content: string };
type ChatSessionSummary = { id: string; preview: string; createdAt: string };
type SavedChatMessage = { role: string; text: string; result?: Answer | null };
type Result = {
  id: string;
  caseId: string;
  mode: string;
  status: string;
  manualScore: number | null;
  result: Partial<Answer> & {
    error?: string;
    question?: string;
    retrievalHit?: boolean | null;
    correctRefusal?: boolean | null;
    citationHit?: boolean | null;
  };
};
type Run = {
  id: string;
  status: string;
  kind: string;
  split: string;
  completed: number;
  total: number;
  createdAt: string;
  results?: Result[];
  indexHash?: string;
  datasetHash?: string;
  references?: { id: string; reference: string; sourceId: string }[];
};
async function api<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch("/api/" + path, {
    method: method || (body ? "POST" : "GET"),
    headers:
      body instanceof FormData || body instanceof Blob
        ? {}
        : body
          ? { "Content-Type": "application/json" }
          : {},
    body:
      body instanceof FormData || body instanceof Blob
        ? body
        : body
          ? JSON.stringify(body)
          : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Операция не выполнена");
  return data;
}
const money = (value: number | null | undefined, currency = "RUB") =>
  value == null ? "не рассчитано" : `${value.toFixed(5)} ${currency} (оценка)`;
function Sources({
  sources,
  idPrefix = "src",
}: {
  sources: (Source | ContextFragment)[];
  idPrefix?: string;
}) {
  return (
    <>
      {sources.map((s) => (
        <details
          className="source"
          key={s.id}
          id={`${idPrefix}-source-${s.id}`}
        >
          <summary>
            <strong>{s.articleId}</strong> · позиция {s.position ?? "—"}
            {"vectorScore" in s &&
              s.vectorScore != null &&
              ` · similarity ${s.vectorScore.toFixed(3)}`}
            {"bm25Score" in s &&
              s.bm25Score != null &&
              ` · BM25 ${s.bm25Score.toFixed(3)}`}
            <br />
            {s.title}
          </summary>
          <p>{s.content}</p>
          <small>
            {"filename" in s
              ? `${s.filename} · версия ${s.version.slice(0, 12)} · чанк ${s.index}`
              : `Раздел: ${s.section} · ID фрагмента: ${s.id}`}
          </small>
        </details>
      ))}
    </>
  );
}
function Markdown({
  text,
  sources,
  idPrefix,
  onSource,
}: {
  text: string;
  sources: Source[];
  idPrefix: string;
  onSource: (source: Source) => void;
}) {
  const allowed = new Set(sources.map((s) => s.articleId));
  const inline = (line: string, key: string) => {
    const parts = line.split(
      /(\*\*[^*]+\*\*|(?:AD-KB-\d{2}\.\d{2}|DOC-[a-f0-9]{12}))/g,
    );
    return parts.map((part, i) => {
      if (/^\*\*[^*]+\*\*$/.test(part))
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      if (allowed.has(part)) {
        const source = sources.find((s) => s.articleId === part)!;
        return (
          <a
            key={i}
            href="#knowledge-source"
            onClick={(event) => {
              event.preventDefault();
              onSource(source);
            }}
          >
            {part}
          </a>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };
  const lines = text.split("\n");
  return (
    <div className="markdown">
      {lines.map((line, i) => {
        const heading = /^(#{1,3})\s+(.*)$/.exec(line);
        if (heading)
          return heading[1].length === 1 ? (
            <h3 key={i}>{inline(heading[2], `${i}`)}</h3>
          ) : (
            <h4 key={i}>{inline(heading[2], `${i}`)}</h4>
          );
        if (/^\s*[-*]\s+/.test(line))
          return (
            <div key={i}>
              • {inline(line.replace(/^\s*[-*]\s+/, ""), `${i}`)}
            </div>
          );
        if (/^\s*\d+[.)]\s+/.test(line))
          return <div key={i}>{inline(line.trim(), `${i}`)}</div>;
        return line ? <p key={i}>{inline(line, `${i}`)}</p> : <br key={i} />;
      })}
    </div>
  );
}
export default function Lab() {
  const [auth, setAuth] = useState<boolean | null>(null),
    [password, setPassword] = useState(""),
    [tab, setTab] = useState("chat"),
    [mobile, setMobile] = useState("chat");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [config, setConfig] = useState<Settings | null>(null),
    [keyConfigured, setKeyConfigured] = useState(false),
    [database, setDatabase] = useState(false);
  const [docs, setDocs] = useState<Doc[]>([]),
    [articles, setArticles] = useState<Article[]>([]),
    [selected, setSelected] = useState<Article | null>(null),
    [activeSource, setActiveSource] = useState<Source | null>(null),
    [query, setQuery] = useState("");
  const [role, setRole] = useState<"baseline" | "strong">("baseline"),
    [rag, setRag] = useState(true),
    [offline, setOffline] = useState(true),
    [question, setQuestion] = useState(""),
    [sources, setSources] = useState<Source[]>([]),
    [diagnostic, setDiagnostic] = useState<Answer | null>(null),
    [sessionId, setSessionId] = useState<string | undefined>();
  const [messages, setMessages] = useState<
      { role: string; text: string; result?: Answer }[]
    >([]),
    [models, setModels] = useState<string[]>([]);
  const [chatSessions, setChatSessions] = useState<ChatSessionSummary[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [ragDiagnosticTab, setRagDiagnosticTab] = useState<
    "vector" | "bm25" | "context"
  >("context");
  const [runs, setRuns] = useState<Run[]>([]),
    [run, setRun] = useState<Run | null>(null),
    [split, setSplit] = useState("dev"),
    [kind, setKind] = useState("retrieval"),
    [paid, setPaid] = useState(false),
    [maxRequests, setMaxRequests] = useState(192),
    [filter, setFilter] = useState("all");
  const [cases, setCases] = useState<
    { id: string; question: string; category: string }[]
  >([]);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  async function load() {
    const c = await api<{
      settings: Settings;
      keyConfigured: boolean;
      databaseConfigured: boolean;
    }>("settings");
    setConfig(c.settings);
    setKeyConfigured(c.keyConfigured);
    setDatabase(c.databaseConfigured);
    const a = await api<{ articles: Article[] }>("articles");
    setArticles(a.articles);
    setSelected(a.articles[0]);
    const t = await api<{ cases: typeof cases }>("evaluation/cases");
    setCases(t.cases);
    if (c.databaseConfigured) {
      try {
        setDocs((await api<{ documents: Doc[] }>("documents")).documents);
        setRuns((await api<{ runs: Run[] }>("evaluation/runs")).runs);
        await refreshChatSessions();
      } catch (e) {
        setError((e as Error).message);
      }
    }
  }
  async function refreshChatSessions() {
    const data = await api<{ sessions: ChatSessionSummary[] }>("chat/sessions");
    setChatSessions(data.sessions);
  }
  async function openChatSession(id: string) {
    const saved = await api<{ id: string; messages: SavedChatMessage[] }>(
      `chat/sessions/${id}`,
    );
    const restored = saved.messages.map((message) => ({
      role: message.role,
      text: message.text,
      ...(message.result && message.result.retrieval
        ? { result: message.result }
        : {}),
    }));
    setSessionId(saved.id);
    setMessages(restored);
    const latestAnswer = [...restored]
      .reverse()
      .find((message) => message.result);
    setDiagnostic(latestAnswer?.result || null);
    setSources(latestAnswer?.result?.sources || []);
    setActiveSource(null);
    setRagDiagnosticTab("vector");
    if (latestAnswer?.result?.mode.startsWith("strong-")) setRole("strong");
    else if (latestAnswer?.result?.mode.startsWith("baseline-"))
      setRole("baseline");
    if (latestAnswer?.result?.mode.endsWith("-rag")) setRag(true);
    else if (latestAnswer?.result?.mode.endsWith("-plain")) setRag(false);
    setMobile("chat");
    setTab("chat");
  }
  useEffect(() => {
    api<{ authenticated: boolean }>("auth/status")
      .then((r) => setAuth(r.authenticated))
      .catch(() => setAuth(false));
  }, []);
  useEffect(() => {
    if (auth) void perform(load);
  }, [auth]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!run || !["queued", "running"].includes(run.status)) return;
    const timer = setInterval(() => {
      api<Run>("evaluation/runs/" + run.id)
        .then(setRun)
        .catch((e) => setError(e.message));
    }, 1800);
    return () => clearInterval(timer);
  }, [run?.id, run?.status]);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      block: "end",
      behavior: "smooth",
    });
  }, [messages.length]);
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    const q = question;
    await perform(async () => {
      const result = await api<Answer & { sessionId: string }>("chat", {
        question: q,
        role,
        rag,
        sessionId,
      });
      setRagDiagnosticTab("vector");
      setSessionId(result.sessionId);
      setMessages((m) => [
        ...m,
        { role: "user", text: q },
        { role: "assistant", text: result.answer, result },
      ]);
      setSources(result.sources);
      setDiagnostic(result);
      setQuestion("");
      await refreshChatSessions();
    });
  }
  async function search() {
    await perform(async () => {
      const result = await api<{ sources: Source[] }>("search", {
        question,
        offline,
      });
      setSources(result.sources);
      setMobile("diagnostics");
    });
  }
  async function refreshDocs() {
    setDocs((await api<{ documents: Doc[] }>("documents")).documents);
  }
  async function start(retryId?: string) {
    await perform(async () => {
      const r = await api<Run>("evaluation/runs", {
        split,
        kind,
        confirmPaid: paid,
        maxRequests,
        retryId,
      });
      setRun({ ...r, results: [] });
      setRuns((await api<{ runs: Run[] }>("evaluation/runs")).runs);
    });
  }
  if (auth === null)
    return (
      <main className="login panel">
        <p>Загрузка лаборатории…</p>
      </main>
    );
  if (!auth)
    return (
      <main className="login panel">
        <div className="logo" style={{ width: 48 }}>
          A.
        </div>
        <h1>AgentDesk Lab</h1>
        <p className="muted">
          Закрытая лаборатория AI-поддержки. Введите пароль демонстрации.
        </p>
        {error && <div className="error">{error}</div>}
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              await api("auth/login", { password });
              setPassword("");
              setAuth(true);
            });
          }}
        >
          <label className="field">
            Пароль
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button className="primary" disabled={busy}>
            Войти в лабораторию →
          </button>
        </form>
      </main>
    );
  const field = (key: keyof Settings, label: string, type = "text") => (
    <label className="field" key={key}>
      {label}
      <input
        type={type}
        value={config?.[key] ?? ""}
        step={type === "number" ? "any" : undefined}
        onChange={(e) =>
          setConfig((c) =>
            c
              ? {
                  ...c,
                  [key]:
                    type === "number"
                      ? e.target.value === ""
                        ? null
                        : Number(e.target.value)
                      : e.target.value,
                }
              : c,
          )
        }
      />
    </label>
  );
  const results = run?.results || [],
    groups = [
      "baseline-plain",
      "baseline-rag",
      "strong-plain",
      "strong-rag",
    ].map((mode) => {
      const rows = results.filter((r) => r.mode === mode && r.status === "ok"),
        reviewed = rows.filter((r) => r.manualScore !== null),
        hits = rows.filter(
          (r) =>
            r.result.retrievalHit !== null &&
            r.result.retrievalHit !== undefined,
        ),
        times = rows.map((r) => r.result.latencyMs || 0).sort((a, b) => a - b);
      return {
        name: mode
          .replace("baseline", "Экон.")
          .replace("strong", "Сильная")
          .replace("plain", "без RAG"),
        quality: reviewed.length
          ? (100 * reviewed.reduce((s, r) => s + r.manualScore!, 0)) /
            reviewed.length
          : null,
        reviewed: reviewed.length,
        hitAtK: hits.length
          ? (100 * hits.filter((r) => r.result.retrievalHit).length) /
            hits.length
          : null,
        time: times.length
          ? Math.round(times.reduce((s, n) => s + n, 0) / times.length)
          : null,
        p95: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null,
        cost:
          rows.length && rows.every((r) => r.result.cost != null)
            ? rows.reduce((s, r) => s + r.result.cost!, 0)
            : null,
      };
    });
  return (
    <div className="shell">
      <header className="brandbar">
        <div className="logo">A.</div>
        <div>
          <div className="brand">
            AgentDesk <span style={{ fontWeight: 400 }}>Support Lab</span>
          </div>
          <div className="tag">Knowledge into answers</div>
        </div>
        <div className="grow" />
        <span className={"badge " + (!keyConfigured ? "amber" : "")}>
          {keyConfigured ? "● RouterAI настроен" : "○ Автономный режим"}
        </span>
        <button
          onClick={() =>
            void perform(async () => {
              await api("auth/logout", {});
              setAuth(false);
              setMessages([]);
              setSessionId(undefined);
            })
          }
        >
          Выйти
        </button>
      </header>
      <section className="hero">
        <div>
          <div className="tag" style={{ marginBottom: 10 }}>
            Экспериментальная среда / v0.1
          </div>
          <h1>Точные ответы начинаются со знаний.</h1>
          <p>
            Задавайте вопросы по AgentDesk, изучайте источники и сравнивайте
            модели на одной базе знаний.
          </p>
        </div>
        <span className="badge">↗ 4 режима · 60 тестовых вопросов</span>
      </section>
      <nav className="tabs" aria-label="Разделы">
        {[
          ["chat", "Диалог и поиск"],
          ["knowledge", "База знаний"],
          ["evaluation", "Сравнение моделей"],
          ["settings", "Настройки"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <div role="alert" className="error">
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="Закрыть ошибку">
            ×
          </button>
        </div>
      )}
      {!database && (
        <div className="notice" style={{ marginBottom: 18 }}>
          База данных не подключена. Доступны встроенные статьи и автономный
          LSA-поиск. Чат, импорт и сохранение экспериментов требуют PostgreSQL с
          pgvector.
        </div>
      )}
      {tab === "chat" && (
        <>
          <div className="mobiletabs">
            {[
              ["docs", "Документы"],
              ["chat", "Чат"],
              ["diagnostics", "Источники"],
            ].map(([id, label]) => (
              <button
                key={id}
                className={mobile === id ? "primary" : ""}
                onClick={() => setMobile(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="grid">
            <aside
              className={"panel " + (mobile !== "docs" ? "mobilehidden" : "")}
            >
              <div className="panelhead">
                <h2>Документы и индекс</h2>
                <span className="badge">{docs.length || "—"}</span>
              </div>
              <div className="padded stack">
                <p className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
                  Одна база знаний. Прозрачные источники. Markdown индексируется
                  без дублирования PDF.
                </p>
                {docs.map((d) => (
                  <div className="docitem" key={d.id}>
                    <strong>{d.name}</strong>
                    <p
                      className="muted"
                      style={{ margin: "8px 0", fontSize: 11 }}
                    >
                      {d.versions[0]
                        ? d.versions[0]._count.chunks +
                          " чанков · " +
                          d.versions[0].checksum.slice(0, 8)
                        : "нет активной версии"}
                    </p>
                    <div className="row">
                      <button
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            await api("documents/" + d.id + "/reindex", {});
                            await refreshDocs();
                          })
                        }
                      >
                        ↻ Переиндексировать
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm("Удалить документ и все его версии?")
                          )
                            void perform(async () => {
                              await api(
                                "documents/" + d.id,
                                undefined,
                                "DELETE",
                              );
                              await refreshDocs();
                            });
                        }}
                      >
                        Удалить
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  disabled={!database || busy}
                  className="primary"
                  onClick={() =>
                    void perform(async () => {
                      await api("documents/import", {});
                      await refreshDocs();
                    })
                  }
                >
                  ＋ Импортировать AgentDesk KB
                </button>
                <label className="field">
                  Загрузить документ
                  <input
                    type="file"
                    accept=".md,.txt,.pdf,.docx"
                    disabled={!database || busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file)
                        void perform(async () => {
                          if (file.size > 20 * 1024 * 1024 || !file.size)
                            throw new Error(
                              "Размер файла должен быть от 1 байта до 20 МБ.",
                            );
                          const upload = await api<{ id: string }>(
                            "documents/uploads",
                            { name: file.name, size: file.size },
                          );
                          const partSize = 3 * 1024 * 1024;
                          for (
                            let offset = 0, index = 0;
                            offset < file.size;
                            offset += partSize, index++
                          )
                            await api(
                              `documents/uploads/${upload.id}/${index}`,
                              file.slice(offset, offset + partSize),
                              "PUT",
                            );
                          await api(
                            `documents/uploads/${upload.id}/complete`,
                            {},
                          );
                          await refreshDocs();
                        });
                      e.target.value = "";
                    }}
                  />
                  <small>MD, TXT, PDF с текстом, DOCX · до 20 МБ</small>
                </label>
                <div className="notice">
                  Не загружайте API-ключи, пароли и персональные данные.
                </div>
              </div>
            </aside>
            <section
              className={"panel " + (mobile !== "chat" ? "mobilehidden" : "")}
            >
              <div className="panelhead">
                <div>
                  <h2>AI-техподдержка</h2>
                  <small>Учебный продукт AgentDesk</small>
                </div>
                <button
                  onClick={() => {
                    setMessages([]);
                    setSessionId(undefined);
                    setDiagnostic(null);
                    setSources([]);
                    setActiveSource(null);
                    setRagDiagnosticTab("vector");
                  }}
                >
                  Новая сессия
                </button>
                <select
                  aria-label="История чатов"
                  style={{ maxWidth: 220 }}
                  value={sessionId || ""}
                  onChange={(event) => {
                    const id = event.target.value;
                    if (id) void perform(() => openChatSession(id));
                  }}
                >
                  <option value="">История чатов</option>
                  {chatSessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.preview.slice(0, 72)}
                    </option>
                  ))}
                </select>
              </div>
              <div
                className="padded row"
                style={{ borderBottom: "1px solid var(--line)" }}
              >
                <select
                  aria-label="Модель"
                  value={role}
                  onChange={(e) => setRole(e.target.value as typeof role)}
                >
                  <option value="baseline">Экономичная модель</option>
                  <option value="strong">Сильная модель</option>
                </select>
                <label className="row">
                  <input
                    type="checkbox"
                    checked={rag}
                    onChange={(e) => setRag(e.target.checked)}
                  />{" "}
                  RAG включён
                </label>
                <span className="badge">
                  {role === "baseline" ? "01" : "02"} /{" "}
                  {rag ? "с RAG" : "без RAG"}
                </span>
              </div>
              {!messages.length ? (
                <div className="empty">
                  <div className="orb">✳</div>
                  <h2>Чем помочь?</h2>
                  <p>
                    Ответы по базе знаний с проверяемыми ссылками. Начните с
                    вопроса или проверьте поиск без вызова модели.
                  </p>
                  <div className="suggestions">
                    {[
                      "Что означает AD-413?",
                      "Сколько документов в Team?",
                      "Как восстановить пароль?",
                    ].map((q) => (
                      <button key={q} onClick={() => setQuestion(q)}>
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="messages" data-testid="chat-messages">
                  {messages.map((m, i) => (
                    <article key={i} className={"message " + m.role}>
                      <small>{m.role === "user" ? "Вы" : "AI-оператор"}</small>
                      {m.result ? (
                        <Markdown
                          text={m.text}
                          sources={m.result.sources}
                          idPrefix={`message-${i}`}
                          onSource={(source) => {
                            const article = articles.find(
                              (a) => a.articleId === source.articleId,
                            );
                            if (article) {
                              setSelected(article);
                              setActiveSource(source);
                              setTab("knowledge");
                              setMobile("knowledge");
                            } else {
                              setSources([source]);
                              setMobile("diagnostics");
                            }
                          }}
                        />
                      ) : (
                        <p>{m.text}</p>
                      )}
                      {m.result && (
                        <>
                          <span className="badge">
                            {m.result.citations.length
                              ? m.result.citations.join(" · ")
                              : "Ответ без проверенных источников"}
                          </span>
                          <div style={{ marginTop: 8 }}>
                            <small>
                              {m.result.latencyMs} мс ·{" "}
                              {money(m.result.cost, m.result.currency)}
                            </small>
                            <button
                              style={{
                                marginLeft: 8,
                                padding: 4,
                                fontSize: 11,
                              }}
                              onClick={() => {
                                setDiagnostic(m.result!);
                                setSources(m.result!.sources);
                                setMobile("diagnostics");
                              }}
                            >
                              Диагностика ↗
                            </button>
                          </div>
                          {m.result.invalidCitations.length > 0 && (
                            <div className="notice">
                              Ответ содержит неподтверждённые ссылки; они
                              скрыты.
                            </div>
                          )}
                          {rag &&
                            m.result.mode.endsWith("-rag") &&
                            !m.result.citations.length &&
                            m.result.status === "ok" && (
                              <div className="notice">
                                В ответе нет ссылок на подтверждающие фрагменты.
                                Проверьте сведения перед использованием.
                              </div>
                            )}
                          <details
                            className="source rag-diagnostics"
                            data-testid="rag-diagnostics"
                          >
                            <summary>
                              <strong>Диагностика RAG</strong> · Векторный поиск
                              ({m.result.retrieval.vectorResults.length}) · BM25
                              ({m.result.retrieval.bm25Results.length}) ·
                              Контекст LLM ({m.result.llmContext.length})
                            </summary>
                            <div
                              className="row rag-diagnostic-tabs"
                              role="tablist"
                              aria-label="Вкладки диагностики RAG"
                              style={{ margin: "10px 0" }}
                            >
                              {(
                                [
                                  ["vector", "Векторный поиск"],
                                  ["bm25", "BM25"],
                                  ["context", "Контекст LLM"],
                                ] as const
                              ).map(([key, label]) => (
                                <button
                                  key={key}
                                  type="button"
                                  role="tab"
                                  id={`rag-${i}-${key}-tab`}
                                  aria-controls={`rag-${i}-panel`}
                                  onClick={() => setRagDiagnosticTab(key)}
                                  aria-selected={ragDiagnosticTab === key}
                                  aria-pressed={ragDiagnosticTab === key}
                                  data-testid={`rag-tab-${key}`}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                            {m.result.retrieval.overlapIds.length > 0 && (
                              <p className="muted">
                                Найдены обоими методами:{" "}
                                {m.result.retrieval.overlapIds
                                  .map(
                                    (id) =>
                                      m.result!.sources.find((s) => s.id === id)
                                        ?.articleId || id,
                                  )
                                  .join(", ")}
                              </p>
                            )}
                            <div className="rag-diagnostic-grid" data-testid="rag-diagnostic-panel">
                              {(["vector", "bm25", "context"] as const).map((key) => (
                                <section key={key} className={`rag-column ${ragDiagnosticTab === key ? "selected" : ""}`}>
                                  <h4>{key === "vector" ? `Векторный поиск (${m.result!.retrieval.vectorResults.length})` : key === "bm25" ? `BM25 (${m.result!.retrieval.bm25Results.length})` : `Контекст LLM (${m.result!.llmContext.length})`}</h4>
                                  {key === "context" && <p className="muted">Показаны только фрагменты из фактического запроса модели.</p>}
                                  {m.result!.mode.endsWith("-plain") ? <p data-testid="rag-disabled">Поиск по базе знаний отключён.</p> : <Sources idPrefix={`message-${i}-${key}`} sources={key === "vector" ? m.result!.retrieval.vectorResults : key === "bm25" ? m.result!.retrieval.bm25Results : m.result!.llmContext} />}
                                </section>
                              ))}
                            </div>
                          </details>
                        </>
                      )}
                    </article>
                  ))}
                  <div ref={messagesEndRef} aria-hidden="true" />
                </div>
              )}
              <form className="composer" onSubmit={send}>
                <textarea
                  aria-label="Ваш вопрос"
                  placeholder="Задайте вопрос о продукте AgentDesk…"
                  value={question}
                  maxLength={4000}
                  onChange={(e) => setQuestion(e.target.value)}
                />
                <div className="row">
                  <button
                    type="button"
                    disabled={busy || question.trim().length < 2}
                    onClick={() => void search()}
                  >
                    ⌕ Только поиск
                  </button>
                  <button
                    className="primary"
                    disabled={
                      busy || !keyConfigured || !database || !question.trim()
                    }
                  >
                    {busy ? "Обработка…" : "Отправить →"}
                  </button>
                </div>
                <div className="row">
                  <label className="row muted" style={{ fontSize: 11 }}>
                    <input
                      type="checkbox"
                      checked={offline}
                      onChange={(e) => setOffline(e.target.checked)}
                    />{" "}
                    Поиск по встроенному Markdown без БД
                  </label>
                </div>
                {!keyConfigured && (
                  <p
                    className="muted"
                    style={{ fontSize: 11, marginTop: 12, marginBottom: 0 }}
                  >
                    Ключ RouterAI отсутствует. Реальные ответы модели отключены.
                  </p>
                )}
              </form>
            </section>
            <aside
              className={
                "panel diagnostics " +
                (mobile !== "diagnostics" ? "mobilehidden" : "")
              }
            >
              <div className="panelhead">
                <h2>Диагностика</h2>
                <span className="badge">Live</span>
              </div>
              <div className="padded">
                <div className="tag">Параметры ответа</div>
                {[
                  [
                    "Модель",
                    diagnostic?.model || config?.[role] || "не выбрана",
                  ],
                  [
                    "Режим",
                    diagnostic?.mode || `${role} · ${rag ? "RAG" : "без RAG"}`,
                  ],
                  ["Время", diagnostic ? diagnostic.latencyMs + " мс" : "—"],
                  [
                    "Токены",
                    diagnostic?.usage?.total_tokens?.toString() || "нет данных",
                  ],
                  ["Стоимость", money(diagnostic?.cost, config?.currency)],
                  ["Найдено фрагментов", String(sources.length)],
                ].map(([label, value]) => (
                  <div className="metric" key={label}>
                    <span className="muted">{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
                <div className="divider" />
                <h3>Источники ответа</h3>
                {sources.length ? (
                  <Sources sources={sources} />
                ) : (
                  <p
                    className="muted"
                    style={{ fontSize: 12, lineHeight: 1.7 }}
                  >
                    После поиска здесь появятся релевантные фрагменты и версии
                    документов.
                  </p>
                )}
                {diagnostic?.invalidCitations.length ? (
                  <div className="notice">
                    Неподтверждённые ссылки скрыты:{" "}
                    {diagnostic.invalidCitations.length}
                  </div>
                ) : null}
                <div className="divider" />
                <small>
                  Релевантность — оценка поиска, а не вероятность правильного
                  ответа.
                </small>
              </div>
            </aside>
          </div>
        </>
      )}
      {tab === "knowledge" && (
        <div className="articles">
          <div className="panel">
            <div className="padded">
              <h2>35 статей AgentDesk</h2>
              <input
                style={{ width: "100%" }}
                aria-label="Фильтр статей"
                placeholder="Найти статью…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="articlelist">
              {articles
                .filter((a) =>
                  (a.title + a.articleId + a.content)
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((a) => (
                  <button
                    key={a.articleId}
                    style={{
                      background:
                        selected?.articleId === a.articleId
                          ? "#eaf1e5"
                          : undefined,
                    }}
                    onClick={() => setSelected(a)}
                  >
                    <strong>{a.articleId}</strong>
                    <br />
                    {a.title}
                  </button>
                ))}
            </div>
          </div>
          <article className="panel padded">
            <span className="badge">Встроенный источник · версия 1.0</span>
            <h2 style={{ marginTop: 18 }}>{selected?.title}</h2>
            <div className="articletext" id="knowledge-source">
              {selected?.content}
            </div>
            {activeSource && activeSource.articleId === selected?.articleId && (
              <div className="source-highlight" data-testid="source-highlight">
                <small>
                  Использованный фрагмент · {activeSource.section} · ID{" "}
                  {activeSource.id}
                </small>
                <p>
                  <mark>{activeSource.content}</mark>
                </p>
              </div>
            )}
          </article>
        </div>
      )}
      {tab === "settings" && config && (
        <>
          <div className="settings">
            <section className="panel padded">
              <h2>Модели и RouterAI</h2>
              <p className="muted">
                Секреты задаются в переменных среды. Настройки моделей
                сохраняются после проверки каталога RouterAI.
              </p>
              <div className="row" style={{ marginBottom: 18 }}>
                <span className={"badge " + (!keyConfigured ? "amber" : "")}>
                  {keyConfigured ? "Ключ задан" : "Ключ отсутствует"}
                </span>
                <button
                  disabled={busy || !keyConfigured}
                  onClick={() =>
                    void perform(async () =>
                      setModels(
                        (await api<{ models: string[] }>("models")).models,
                      ),
                    )
                  }
                >
                  Обновить каталог
                </button>
              </div>
              <datalist id="models">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {(["baseline", "strong"] as const).map((key, i) => (
                <label className="field" key={key}>
                  {i ? "Сильная модель — ID" : "Экономичная модель — ID"}
                  <input
                    list="models"
                    value={config[key]}
                    onChange={(e) =>
                      setConfig({ ...config, [key]: e.target.value })
                    }
                  />
                </label>
              ))}
              {field("temperature", "Температура", "number")}
              {field("maxTokens", "Максимум выходных токенов", "number")}
              <div className="notice">
                Недоступная модель вызовет явную ошибку. Автоматической замены
                моделей нет.
              </div>
            </section>
            <section className="panel padded">
              <h2>Поиск и стоимость</h2>
              {field("topK", "Число фрагментов (1–10)", "number")}
              {field("threshold", "Минимальная оценка (0–1)", "number")}
              {field(
                "semanticWeight",
                "Вес семантического поиска (0–1)",
                "number",
              )}
              <div className="row">
                {field("baselineInput", "Экономичная: вход / 1 млн", "number")}
                {field(
                  "baselineOutput",
                  "Экономичная: выход / 1 млн",
                  "number",
                )}
              </div>
              <div className="row">
                {field("strongInput", "Сильная: вход / 1 млн", "number")}
                {field("strongOutput", "Сильная: выход / 1 млн", "number")}
              </div>
              {field("currency", "Валюта: RUB / USD / EUR")}
              {field("pricingDate", "Дата актуальности цен", "date")}
              <small>
                Пустые цены означают «не рассчитано». Нулевые цены задавайте
                только для подтверждённо бесплатных моделей.
              </small>
            </section>
          </div>
          <button
            className="primary"
            style={{ marginTop: 20 }}
            disabled={busy || !database}
            onClick={() =>
              void perform(async () => {
                await api("settings", config, "PUT");
                setError("");
              })
            }
          >
            Проверить и сохранить настройки
          </button>
        </>
      )}
      {tab === "evaluation" && (
        <>
          <section className="panel padded">
            <h2>Один набор. Четыре режима.</h2>
            <p className="muted">
              48 dev + 12 holdout, фиксированное разделение. Качество ответов
              оценивайте по эталону вручную; retrieval hit@k и ссылки считаются
              автоматически.
            </p>
            <div className="row">
              <select
                aria-label="Подвыборка"
                value={split}
                onChange={(e) => {
                  setSplit(e.target.value);
                  setMaxRequests(
                    e.target.value === "dev"
                      ? 192
                      : e.target.value === "holdout"
                        ? 48
                        : 240,
                  );
                }}
              >
                <option value="dev">Dev · 48 вопросов</option>
                <option value="holdout">Holdout · 12 вопросов</option>
                <option value="all">Все · 60 вопросов</option>
              </select>
              <select
                aria-label="Вид теста"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="retrieval">Только поиск · без LLM</option>
                <option value="models">Все 4 режима · платный API</option>
              </select>
              <button
                className="primary"
                disabled={
                  busy ||
                  !database ||
                  (kind === "models" && (!keyConfigured || !paid))
                }
                onClick={() => void start()}
              >
                Запустить тест →
              </button>
            </div>
            {kind === "models" && (
              <div className="notice" style={{ marginTop: 14 }}>
                <label className="row">
                  <input
                    type="checkbox"
                    checked={paid}
                    onChange={(e) => setPaid(e.target.checked)}
                  />{" "}
                  Подтверждаю расход платных запросов. Лимит:{" "}
                  <input
                    aria-label="Лимит платных запросов"
                    style={{ width: 90 }}
                    type="number"
                    min={1}
                    max={240}
                    value={maxRequests}
                    onChange={(e) => setMaxRequests(Number(e.target.value))}
                  />
                </label>
                <small>
                  Денежный лимит задайте у провайдера. Тест выполнит до 240
                  запросов; одновременных — не более 2.
                </small>
              </div>
            )}
            <div className="row" style={{ marginTop: 18 }}>
              <select
                aria-label="История тестов"
                value={run?.id || ""}
                onChange={(e) => {
                  if (e.target.value)
                    void perform(async () =>
                      setRun(
                        await api<Run>("evaluation/runs/" + e.target.value),
                      ),
                    );
                }}
              >
                <option value="">История тестов</option>
                {runs.map((r) => (
                  <option value={r.id} key={r.id}>
                    {r.kind} · {r.split} ·{" "}
                    {new Date(r.createdAt).toLocaleString("ru-RU")} · {r.status}
                  </option>
                ))}
              </select>
              <button
                disabled={!database || busy}
                onClick={() =>
                  void perform(async () =>
                    setRuns(
                      (await api<{ runs: Run[] }>("evaluation/runs")).runs,
                    ),
                  )
                }
              >
                Обновить
              </button>
            </div>
          </section>
          {run ? (
            <>
              <section className="panel padded" style={{ marginTop: 18 }}>
                <div className="row">
                  <strong>{run.status}</strong>
                  <span className="badge">
                    {run.completed} / {run.total}
                  </span>
                  <div className="grow" />
                  {["queued", "running"].includes(run.status) ? (
                    <button
                      onClick={() =>
                        void perform(async () => {
                          await api(
                            "evaluation/runs/" + run.id + "/cancel",
                            {},
                          );
                          setRun(await api<Run>("evaluation/runs/" + run.id));
                        })
                      }
                    >
                      Остановить
                    </button>
                  ) : (
                    <button
                      disabled={busy || (run.kind === "models" && !paid)}
                      onClick={() => {
                        setKind(run.kind);
                        setSplit(run.split);
                        void start(run.id);
                      }}
                    >
                      Повторить ошибки
                    </button>
                  )}
                  <a
                    className="button"
                    href={"/api/evaluation/runs/" + run.id + "/export"}
                  >
                    Экспорт CSV ↓
                  </a>
                </div>
                <progress
                  value={run.completed}
                  max={run.total}
                  style={{
                    width: "100%",
                    marginTop: 16,
                    accentColor: "#166c55",
                  }}
                />
                <small>
                  Индекс: {run.indexHash?.slice(0, 16)} · набор:{" "}
                  {run.datasetHash?.slice(0, 16)}. Остановка действует после
                  завершения текущих запросов.
                </small>
              </section>
              {run.kind === "models" && (
                <>
                  <div className="charts">
                    {[
                      ["quality", "Точность · ручная оценка, %"],
                      ["time", "Среднее время, мс"],
                      ["cost", "Стоимость, " + (config?.currency || "")],
                    ].map(([key, title]) => (
                      <section className="panel chart" key={key}>
                        <h3>{title}</h3>
                        {groups.some(
                          (g) => g[key as "quality" | "time" | "cost"] !== null,
                        ) ? (
                          <ResponsiveContainer width="100%" height={175}>
                            <BarChart data={groups}>
                              <CartesianGrid
                                strokeDasharray="3 3"
                                vertical={false}
                              />
                              <XAxis
                                dataKey="name"
                                tick={{ fontSize: 9 }}
                                interval={0}
                              />
                              <YAxis tick={{ fontSize: 10 }} width={40} />
                              <Tooltip />
                              <Bar
                                dataKey={key}
                                fill="#27785d"
                                radius={[4, 4, 0, 0]}
                              />
                            </BarChart>
                          </ResponsiveContainer>
                        ) : (
                          <p
                            className="muted"
                            style={{ paddingTop: 44, textAlign: "center" }}
                          >
                            Нет измеренных данных
                          </p>
                        )}
                      </section>
                    ))}
                  </div>
                  <div className="panel tablewrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Режим</th>
                          <th>Ручных оценок</th>
                          <th>Retrieval hit@k</th>
                          <th>p95, мс</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groups.map((g) => (
                          <tr key={g.name}>
                            <td>{g.name}</td>
                            <td>{g.reviewed}</td>
                            <td>
                              {g.hitAtK == null
                                ? "—"
                                : g.hitAtK.toFixed(1) + "%"}
                            </td>
                            <td>{g.p95 ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              <div className="row" style={{ margin: "18px 0" }}>
                <h2 style={{ margin: 0 }}>Результаты</h2>
                <select
                  aria-label="Фильтр результатов"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">Все результаты</option>
                  <option value="error">Ошибки</option>
                  <option value="unreviewed">Без ручной оценки</option>
                  {[
                    "baseline-plain",
                    "baseline-rag",
                    "strong-plain",
                    "strong-rag",
                  ].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div className="panel tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Вопрос / режим</th>
                      <th>Ответ</th>
                      <th>Поиск и ссылки</th>
                      <th>Измерения</th>
                      <th>Оценка</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results
                      .filter(
                        (r) =>
                          filter === "all" ||
                          (filter === "error" && r.status === "error") ||
                          (filter === "unreviewed" && r.manualScore === null) ||
                          r.mode === filter,
                      )
                      .map((r) => (
                        <tr key={r.id}>
                          <td style={{ minWidth: 200 }}>
                            <strong>{r.caseId}</strong>
                            <p>{r.result.question}</p>
                            <span className="badge">{r.mode}</span>
                          </td>
                          <td className="answer">
                            {r.result.error ||
                              r.result.answer ||
                              "Тест поиска, без генерации"}
                            {run.references?.find((c) => c.id === r.caseId) && (
                              <details className="source">
                                <summary>Эталон для проверки</summary>
                                <p>
                                  {
                                    run.references.find(
                                      (c) => c.id === r.caseId,
                                    )?.reference
                                  }
                                </p>
                                <small>
                                  {run.references.find((c) => c.id === r.caseId)
                                    ?.sourceId || "Источник отсутствует"}
                                </small>
                              </details>
                            )}
                          </td>
                          <td>
                            {r.result.retrievalHit != null && (
                              <p>hit@k: {r.result.retrievalHit ? "✓" : "×"}</p>
                            )}
                            {r.result.correctRefusal != null && (
                              <p>
                                Отказ (эвристика):{" "}
                                {r.result.correctRefusal ? "да" : "нет"}
                              </p>
                            )}
                            <p>
                              Цитаты: {r.result.citations?.join(", ") || "—"}
                            </p>
                            <p>
                              Неверных:{" "}
                              {r.result.invalidCitations?.length ?? "—"}
                            </p>
                            <Sources sources={r.result.sources || []} />
                          </td>
                          <td>
                            {r.result.latencyMs ?? "—"} мс
                            <br />
                            {money(r.result.cost, r.result.currency)}
                            <br />
                            {r.result.usage?.total_tokens ?? "нет данных"}{" "}
                            токенов
                          </td>
                          <td>
                            <select
                              aria-label={"Оценка " + r.caseId + " " + r.mode}
                              value={r.manualScore ?? ""}
                              disabled={
                                run.kind !== "models" || r.status !== "ok"
                              }
                              onChange={(e) => {
                                if (e.target.value !== "")
                                  void perform(async () => {
                                    await api(
                                      "evaluation/runs/" + run.id + "/review",
                                      {
                                        resultId: r.id,
                                        score: Number(e.target.value),
                                      },
                                    );
                                    setRun(
                                      await api<Run>(
                                        "evaluation/runs/" + run.id,
                                      ),
                                    );
                                  });
                              }}
                            >
                              <option value="">Не проверен</option>
                              <option value="1">Верно</option>
                              <option value="0">Неверно</option>
                            </select>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {!results.length && (
                  <p className="padded muted">
                    Результатов пока нет. Для выполнения задания запустите
                    evaluation worker по README.
                  </p>
                )}
              </div>
            </>
          ) : (
            <section className="panel padded" style={{ marginTop: 18 }}>
              <h2>Вопросы dev-набора</h2>
              <p className="muted">
                Holdout скрыт из списка для разработки промпта.
              </p>
              <div className="tablewrap" style={{ maxHeight: 380 }}>
                <table>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Вопрос</th>
                      <th>Категория</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cases.map((c) => (
                      <tr key={c.id}>
                        <td>{c.id}</td>
                        <td>{c.question}</td>
                        <td>{c.category}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
      <footer className="footer">
        <span>
          AgentDesk — вымышленный учебный продукт. Ответы AI требуют проверки.
        </span>
        <span>Support RAG Lab · 2026</span>
      </footer>
    </div>
  );
}
