import { useState, type ReactNode } from "react";
import { toast } from "../../lib/legacy";

/**
 * 回答的 Markdown 渲染（轻量白名单子集，由原 src/legacy/ai.ts 迁移而来）。
 *
 * 只做「让回答更好读」的那几样：代码块、行内 code、加粗/斜体/删除线、列表、标题、
 * 引用、分隔线、http(s) 链接。整棵 DOM 都用 JSX / 文本节点构建，不拼 HTML 串、
 * 不用 dangerouslySetInnerHTML——模型输出里的标签只会当纯文本显示，没有注入面。
 *
 * 只在回答结束后渲染一次：流式期间仍用 <pre> 逐字更新，半截的 ``` 会渲染成乱码块。
 */

/** 关键字集合：仅用于代码块着色，命中就给主色，不命中按正文色。 */
const MD_KEYWORDS = new Set(
  (
    "if else elif fi then for while until do done in case esac function func return break continue " +
    "import from export default class struct interface def new this self super try except catch finally " +
    "throw raise with as pass lambda yield global local async await defer go select " +
    "and or not is none null nil true false undefined var let const int float string bool void " +
    "public private protected static echo cd sudo rm cp mv mkdir source cat grep sed awk"
  ).split(" ")
);

/** 通用词法：注释 / 字符串 / 数字 / 标识符。注释前缀按语言家族区分，免得把 CSS 的 # 颜色值当注释。 */
function mdLexer(lang: string): RegExp {
  const hash = /^(sh|bash|zsh|shell|fish|yaml|yml|py|python|rb|ruby|toml|ini|conf|cfg|env|dockerfile|makefile|mk|perl|r|plist)$/.test(lang);
  const dash = /^(sql|lua|hs|haskell)$/.test(lang);
  const comment = hash ? "#[^\\n]*" : dash ? "--[^\\n]*" : "//[^\\n]*|/\\*[\\s\\S]*?\\*/";
  return new RegExp(
    "(" + comment + ")|(\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)" +
      "|\\b(\\d+(?:\\.\\d+)?)\\b|\\b([A-Za-z_][A-Za-z0-9_]*)\\b",
    "g"
  );
}

/** 代码块的基础着色：注释 / 字符串 / 数字 / 关键字，其余保持正文色。 */
function highlight(code: string, lang: string): ReactNode {
  if (!code) return null;
  // 纯文本类语言不着色，免得把中文说明里的数字、单词染得花花绿绿
  if (!lang || /^(text|txt|plain|log|output|console|markdown|md|diff|patch)$/.test(lang)) {
    return code;
  }
  const re = mdLexer(lang);
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) out.push(code.slice(last, m.index));
    let cls = "";
    if (m[1]) cls = "cmt";
    else if (m[2]) cls = "str";
    else if (m[3]) cls = "num";
    else if (MD_KEYWORDS.has(m[4])) cls = "kw";
    out.push(cls ? <span key={k++} className={"md-t-" + cls}>{m[0]}</span> : m[0]);
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

/** 复制按钮：写完剪贴板把文字短暂改成「已复制」，不弹 toast 打断阅读。 */
function MdCopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="md-copy"
      type="button"
      onClick={() => {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
          toast("当前环境不支持剪贴板", "error");
          return;
        }
        navigator.clipboard.writeText(code).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => toast("复制失败", "error")
        );
      }}
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}

/** 一个代码块：语言标签 + 复制按钮 + 代码体（不折行，长命令横向滚动，保持原样）。 */
function MdCodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || "text"}</span>
        <MdCopyButton code={code} />
      </div>
      <pre className="md-code-body">
        <code className="md-code-text">{highlight(code, lang)}</code>
      </pre>
    </div>
  );
}

/** 行内标记：不做嵌套，按「先匹配先赢」拆成文本节点与行内元素。 */
const MD_INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;

function inlineNodes(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  MD_INLINE.lastIndex = 0;
  while ((m = MD_INLINE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (m[1]) out.push(<code key={k++} className="md-code-inline">{token.slice(1, -1)}</code>);
    else if (m[2] || m[3]) out.push(<strong key={k++}>{token.slice(2, -2)}</strong>);
    else if (m[4]) out.push(<del key={k++} className="md-del">{token.slice(2, -2)}</del>);
    else if (m[5]) out.push(<em key={k++}>{token.slice(1, -1)}</em>);
    else {
      // 链接：正则已限定 http/https。应用没装 opener 插件，点击没法唤起系统浏览器，
      // 而放任默认行为有可能在本窗口内导航、把界面顶掉，所以改成复制链接。
      const hit = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const url = hit ? hit[2] : "";
      const label = hit ? hit[1] : token;
      out.push(
        <a
          key={k++}
          className="md-link"
          href={url}
          title={url}
          onClick={(event) => {
            event.preventDefault();
            if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
              toast("当前环境不支持剪贴板", "error");
              return;
            }
            navigator.clipboard.writeText(url).then(
              () => toast("链接已复制到剪贴板", "ok"),
              () => toast("复制失败", "error")
            );
          }}
        >
          {label}
        </a>
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 逐行解析块级结构：围栏代码 / 标题 / 列表 / 引用 / 分隔线 / 段落。 */
function blockNodes(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let para: ReactNode[] | null = null;
  let list: { tag: string; items: ReactNode[] } | null = null;
  let k = 0;

  const flushPara = () => {
    if (!para) return;
    out.push(
      <p className="md-p" key={k++}>
        {para}
      </p>
    );
    para = null;
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.tag as "ul" | "ol";
    out.push(
      <Tag className="md-list" key={k++}>
        {list.items}
      </Tag>
    );
    list = null;
  };
  const flushAll = () => {
    flushPara();
    flushList();
  };

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(/^\s*```+\s*([A-Za-z0-9+#._-]*)\s*$/);
    if (fence) {
      flushAll();
      const lang = (fence[1] || "").toLowerCase();
      const buf: string[] = [];
      i += 1;
      // 未闭合的围栏按「到文末为止」处理，否则残缺的 ``` 会把后面全部吞进代码块
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(<MdCodeBlock key={k++} code={buf.join("\n")} lang={lang} />);
      continue;
    }

    if (!line.trim()) {
      flushAll();
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll();
      out.push(<hr className="md-hr" key={k++} />);
      i += 1;
      continue;
    }

    // 标题：最多认到 4 级，聊天面板里再深就没有层级意义了
    const head = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (head) {
      flushAll();
      const Tag = ("h" + Math.min(head[1].length, 4)) as "h1";
      out.push(
        <Tag className="md-h" key={k++}>
          {inlineNodes(head[2].trim())}
        </Tag>
      );
      i += 1;
      continue;
    }

    // 引用：连续多行合成一块，内部再按块级规则解析
    if (/^\s{0,3}>\s?/.test(line)) {
      flushAll();
      const buf: string[] = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i += 1;
      }
      out.push(
        <blockquote className="md-quote" key={k++}>
          <div className="md">{blockNodes(buf.join("\n"))}</div>
        </blockquote>
      );
      continue;
    }

    // 列表：有序 / 无序各自成块，切换类型时收掉上一块
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const tag = ul ? "ul" : "ol";
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(<li key={list.items.length}>{inlineNodes((ul || ol)![1])}</li>);
      i += 1;
      continue;
    }

    // 普通段落：连续非空行合成一段，段内换行按 <br> 保留（终端类回答依赖换行分层）
    if (!para) para = [];
    else para.push(<br key={"br" + k++} />);
    inlineNodes(line).forEach((node, idx) => para!.push(<span key={`${k++}-${idx}`}>{node}</span>));
    i += 1;
  }

  flushAll();
  return out;
}

/** 渲染一段 Markdown 文本。 */
export function Markdown({ text }: { text: string }) {
  // 注意：每次渲染重新解析，模型回答结束后才会走到这里，开销可接受
  return <div className="md">{blockNodes(text)}</div>;
}
