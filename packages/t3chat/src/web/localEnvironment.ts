// OrangeAgent: there is no same-origin t3 server, so the connection runtime must never probe
// /.well-known/t3/environment. Every conversation reaches its server through ChatSurface's transport.
export function isLocalEnvironmentDisabled(): boolean {
  return true;
}
