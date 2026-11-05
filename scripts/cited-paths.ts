// The repository paths a document cites: backticked spans that look like a path
// in this tree. Another repository's path is written `owner/repo:path`, and the
// colon keeps it out. A span with a placeholder such as `<id>` is a pattern.
const pathShape = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\/?$/;
const fileShape = /[^/]\.(md|ts|json|jsonl|yml|yaml|html|mjs|sh|css|js)$/;

export function citedPaths(text: string): string[] {
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");
  return spans.filter((span) => pathShape.test(span) && (span.includes("/") || fileShape.test(span)));
}
