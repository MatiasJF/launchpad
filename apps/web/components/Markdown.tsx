import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Safe markdown renderer for user-authored project descriptions. react-markdown
 * builds React elements (never injects raw HTML), and we further restrict links
 * to http(s) and images to https only — so a description can carry headings,
 * lists, links and inline images without any XSS surface.
 */
const httpish = (u: unknown) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : undefined);
const httpsOnly = (u: unknown) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : undefined);

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={`md ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            const safe = httpish(href);
            return safe ? (
              <a href={safe} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          img({ src, alt }) {
            const safe = httpsOnly(src);
            return safe ? <img src={safe} alt={typeof alt === 'string' ? alt : ''} loading="lazy" /> : null;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
