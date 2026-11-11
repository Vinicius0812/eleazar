import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function AgentMarkdown({ children }: { children: string }) {
  return (
    <div className="markdown-output">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: label }) => href
            ? <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>
            : <span>{label}</span>,
          img: ({ alt }) => <span>{alt ? `[Imagem: ${alt}]` : "[Imagem]"}</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
