import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
export type MessageScope =
  | { conversationId: string; taskId?: never }
  | { taskId: string; conversationId?: never };
interface Preview {
  kind: "file" | "directory";
  path: string;
  line?: number;
  column?: number;
  startLine?: number;
  lines?: string[];
  lineCount?: number;
  lineMissing?: boolean;
  truncated: boolean;
  entries?: { name: string; path: string; directory: boolean }[];
}
function allowedUrl(url: string) {
  if (/^(?:javascript|data|vbscript):/i.test(url) || /^[\\/]{2}/.test(url))
    return "";
  if (/^[^:]+:\d+(?::\d+)?(?:#.*)?$/.test(url)) return url;
  if (/^(?:https?:\/\/|file:\/\/\/|[a-z]:[\\/]|\.{0,2}\/|#)/i.test(url))
    return url;
  if (!/^[a-z][a-z\d+.-]*:/i.test(url) && !/^[\\/]{2}/.test(url)) return url;
  return "";
}
function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((value) =>
      typeof value === "string" || typeof value === "number"
        ? String(value)
        : isValidElement<{ children?: ReactNode }>(value)
          ? textOf(value.props.children)
          : "",
    )
    .join("");
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const [state, setState] = useState("");
  const child = Children.toArray(children).find((value) =>
    isValidElement(value),
  );
  const language = isValidElement<{ className?: string }>(child)
    ? /language-([\w+-]+)/.exec(child.props.className || "")?.[1]
    : undefined;
  return (
    <div className="markdown-code">
      <div className="markdown-code-heading">
        <span>{language || "代码"}</span>
        <button
          type="button"
          className="secondary compact"
          onClick={async () => {
            try {
              await window.cooperation.request("content.copy", {
                text: textOf(children),
              });
              setState("已复制");
            } catch {
              setState("复制失败");
            }
          }}
        >
          {state || "复制代码"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}
function FilePreview({
  value,
  load,
  close,
  scope,
}: {
  value: Preview;
  load: (href: string) => void;
  close: () => void;
  scope?: MessageScope;
}) {
  const active = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    active.current?.scrollIntoView({ block: "center" });
    setNotice("");
  }, [value.path, value.line]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [close]);
  return (
    <div className="modal-overlay file-preview-overlay">
      <section
        className="file-preview modal"
        role="dialog"
        aria-modal="true"
        aria-label="项目文件预览"
      >
        <header className="modal-heading">
          <div>
            <h2>{value.path.split(/[\\/]/).at(-1)}</h2>
            <p className="mono">
              {value.path}
              {value.kind === "file" ? `:${value.line}` : ""}
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭文件预览"
            onClick={close}
          >
            ×
          </button>
        </header>
        <div className="file-preview-note">
          只读预览
          {value.kind === "file"
            ? ` · 第 ${value.line} 行${value.column && value.column > 1 ? `，第 ${value.column} 列` : ""}`
            : " · 项目目录"}
          {value.truncated && " · 内容较多，当前显示部分内容"}
          {value.lineMissing && ` · 链接行号超出已读取的 ${value.lineCount} 行`}
        </div>
        <div className="file-preview-body">
          {value.kind === "directory" ? (
            <ul className="preview-entries">
              {value.entries?.map((entry) => (
                <li key={entry.path}>
                  <button type="button" onClick={() => load(entry.path)}>
                    {entry.directory ? "▱" : "▤"} {entry.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="source-lines">
              {value.lines?.map((line, i) => {
                const number = (value.startLine || 1) + i;
                return (
                  <div
                    className={`source-line ${number === value.line ? "target-line" : ""}`}
                    key={number}
                    ref={number === value.line ? active : undefined}
                    aria-label={
                      number === value.line
                        ? `定位到第 ${number} 行`
                        : undefined
                    }
                  >
                    <span className="source-line-number">{number}</span>
                    <code>{line || " "}</code>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <footer className="modal-footer">
          <span className="hint" role="status">
            {notice}
          </span>
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              try {
                await window.cooperation.request("content.copy", {
                  text: `${value.path}${value.kind === "file" ? `:${value.line}` : ""}`,
                });
                setNotice("文件位置已复制");
              } catch {
                setNotice("复制失败");
              }
            }}
          >
            复制文件位置
          </button>
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              try {
                await window.cooperation.request("content.reveal", {
                  ...scope,
                  href: value.path,
                });
              } catch (error) {
                setNotice(
                  error instanceof Error ? error.message : String(error),
                );
              }
            }}
          >
            在文件管理器中显示
          </button>
        </footer>
      </section>
    </div>
  );
}
function MarkdownMessageView({
  text,
  scope,
  copy = false,
}: {
  text: string;
  scope?: MessageScope;
  copy?: boolean;
}) {
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  async function activate(href: string) {
    if (loading) return;
    setLoading(true);
    setNotice("");
    try {
      if (/^https?:\/\//i.test(href))
        await window.cooperation.request("content.external", { href });
      else {
        const result = await window.cooperation.request<Preview>(
          "content.preview",
          { ...scope, href },
        );
        setPreview(result);
      }
    } catch (error) {
      setNotice(
        (error instanceof Error ? error.message : String(error)).replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="markdown-message">
      {copy && (
        <div className="markdown-toolbar">
          <button
            type="button"
            className="secondary compact"
            onClick={async () => {
              try {
                await window.cooperation.request("content.copy", { text });
                setNotice("原文已复制");
              } catch {
                setNotice("复制失败");
              }
            }}
          >
            复制原文
          </button>
        </div>
      )}
      <div className="markdown-body">
        <Markdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          urlTransform={allowedUrl}
          components={{
            a: ({ href, children }) =>
              href ? (
                <a
                  href={href}
                  onClick={(event) => {
                    if (href.startsWith("#")) return;
                    event.preventDefault();
                    void activate(href);
                  }}
                  onAuxClick={(event) => event.preventDefault()}
                >
                  {children}
                </a>
              ) : (
                <span>{children}</span>
              ),
            table: ({ children }) => (
              <div className="markdown-table">
                <table>{children}</table>
              </div>
            ),
            pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
            img: ({ alt }) => (
              <span className="hint">
                [图片：{alt || "附件"}，请在原软件查看]
              </span>
            ),
          }}
        >
          {text}
        </Markdown>
      </div>
      {(notice || loading) && (
        <p className="markdown-notice hint" role="status">
          {loading ? "正在读取项目文件…" : notice}
        </p>
      )}
      {preview && (
        <FilePreview
          value={preview}
          load={(href) => void activate(href)}
          close={() => setPreview(null)}
          scope={scope}
        />
      )}
    </div>
  );
}
export const MarkdownMessage = memo(
  MarkdownMessageView,
  (a, b) =>
    a.text === b.text &&
    a.copy === b.copy &&
    a.scope?.conversationId === b.scope?.conversationId &&
    a.scope?.taskId === b.scope?.taskId,
);
