import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Memoized: while one message streams, the finished ones are not parsed again. */
export const AgentMarkdown = memo(function AgentMarkdown({ children }: { children: string }) {
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
});
