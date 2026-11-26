// The response both agent pages use (/AGENTS.md, /llms.txt): explicit type, an hour of caching, and CORS open so any
// agent can fetch them from a browser. X-Content-Type-Options: nosniff comes from next.config.js headers().
export function agentDocResponse(body: string, contentType: 'text/markdown' | 'text/plain'): Response {
  return new Response(body, {
    headers: {
      'content-type': `${contentType}; charset=utf-8`,
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
    },
  });
}
