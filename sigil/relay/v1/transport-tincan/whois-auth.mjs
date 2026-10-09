function refuse(code, message, details = {}) { return Object.assign(new Error(message), { code, details }); }

export async function verifyTailscaleWhoIs({ remoteAddress, senderEndpoint, targetEndpoint }, allowlist, tailscale) {
  const whois = await tailscale.whois(remoteAddress);
  if (!whois?.Node?.Key) throw refuse('UNAUTHORIZED_NODE', 'Connection is not from a Tailnet node');
  const nodeKey = whois.Node.Key;
  const config = allowlist.get(nodeKey);
  if (!config) throw refuse('NODE_NOT_IN_ALLOWLIST', `Node ${nodeKey} is not in the allowlist`, { nodeKey });
  for (const endpoint of [senderEndpoint, targetEndpoint]) {
    if (endpoint && !config.permitted_endpoints.includes(endpoint)) {
      throw refuse('NODE_NOT_AUTHORIZED_FOR_ENDPOINT', `Node ${nodeKey} is not authorized for ${endpoint}`, { nodeKey, endpoint });
    }
  }
  return { nodeKey, machineName: whois.Node.Name, loginName: whois.UserProfile?.LoginName, allowedRoles: config.allowed_host_roles };
}
