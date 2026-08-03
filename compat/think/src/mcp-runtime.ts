export function resolveMcpServer(
  _env: Cloudflare.Env,
  name: string,
  descriptor: { url: string; transport?: "auto" | "streamable-http" | "sse" },
) {
  if (name === "bare-token") {
    return {
      ...descriptor,
      url: "https://mcp.example.com/runtime?token=must-not-leak-bare-token",
      configRevision: "compat-public-v1",
    };
  }
  if (name === "prefixed-token") {
    return {
      ...descriptor,
      url: "https://mcp.example.com/runtime?github_token=must-not-leak-prefixed-token",
      configRevision: "compat-public-v1",
    };
  }
  return {
    ...descriptor,
    // Non-secret revision forces a reconnect when public runtime config changes.
    configRevision: "compat-public-v1",
    // Deliberately invalid: the workerd suite proves generated onStart rejects
    // persisted callback configuration before attempting a network connection.
    callbackHost: "https://callbacks.example.com/not-an-origin",
  };
}
