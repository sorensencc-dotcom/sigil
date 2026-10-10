/**
 * Sigil Biometric Gate Mod for Claude Code (TypeScript)
 * 
 * Enforces local zero-trust biometric verification (WebAuthn Touch ID / Windows Hello)
 * via the Sigil Local Connector before Claude Code can execute high-risk filesystem
 * writes, destructive shell commands, or outbound network actions.
 * 
 * Runtime: Claude Code Mods API (v2.1.287+), Node.js 20+ / 22+
 * Lifecycle Hooks: 'tool.check', 'tool.result'
 * Capabilities: Biometric Gate + Automated Secret Redaction (v2)
 */

import { canonicalJson } from "../../../relay/v1/jcs.mjs";

export interface ToolCheckEvent {
  tool: {
    name: string;
    input: Record<string, unknown>;
  };
  agentId?: string;
  ceiling?: string;
  conversationId?: string;
}

export interface ToolCheckResult {
  decision: "allow" | "deny" | "ask";
  reason?: string;
  sanitizedInput?: Record<string, unknown>;
}

export interface ToolResultEvent {
  tool: {
    name: string;
    input: Record<string, unknown>;
  };
  output: {
    stdout?: string;
    stderr?: string;
    content?: unknown;
    error?: string;
    [key: string]: unknown;
  };
  agentId?: string;
  conversationId?: string;
}

export interface ToolResultOutput {
  output: Record<string, unknown>;
  redactedCount?: number;
}

export interface SecretPatternRule {
  type: string;
  regex: RegExp;
  replace: string | ((substring: string, ...args: any[]) => string);
}

export interface SigilModOptions {
  connectorUrl?: string;
  connectorToken?: string;
  endpointIdentity?: string;
  timeoutMs?: number;
  shadowMode?: boolean;
  enableSecretRedaction?: boolean;
  redactLiveEnvValues?: boolean;
  customSentinels?: SecretPatternRule[];
}

export interface SigilModContext {
  ui?: {
    notify?: (options: { title: string; message: string; channel?: string }) => void;
  };
  http?: {
    fetch?: typeof fetch;
  };
  options?: SigilModOptions;
}

export interface SigilApprovalRequest {
  message_id: string;
  conversation_id: string;
  message_type: "approval.request";
  sender_endpoint: string;
  recipient_endpoint: string;
  content: {
    payload: {
      action_type: string;
      tool_name: string;
      parameters: Record<string, unknown>;
      risk_factors: string[];
      agent_id: string;
      secrets_intercepted?: string[];
    };
    text_summary: string;
  };
  requires_human_approval: boolean;
  timestamp: string;
}

export interface SigilApprovalResponse {
  approved: boolean;
  signature?: string;
  timestamp?: string;
  decisionRecord?: Record<string, unknown>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Automated Secret Redaction Engine
// ---------------------------------------------------------------------------

export const KNOWN_SECRET_PATTERNS: SecretPatternRule[] = [
  // Anthropic API Keys (e.g. sk-ant-api03-..., sk-ant-admin-...)
  {
    type: "ANTHROPIC_KEY",
    regex: /\bsk-ant-(?:api\d{2}-)?[a-zA-Z0-9_\-]{20,}\b/g,
    replace: "[REDACTED_ANTHROPIC_KEY]"
  },
  // OpenAI API Keys & Project Keys (e.g. sk-proj-..., sk-...)
  {
    type: "OPENAI_KEY",
    regex: /\bsk-(?:proj-)?[a-zA-Z0-9_\-]{32,}\b/g,
    replace: "[REDACTED_OPENAI_KEY]"
  },
  // GitHub Personal Access Tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  {
    type: "GITHUB_TOKEN",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}\b/g,
    replace: "[REDACTED_GITHUB_TOKEN]"
  },
  // GitHub Fine-grained PATs
  {
    type: "GITHUB_FINE_GRAINED_PAT",
    regex: /\bgithub_pat_[a-zA-Z0-9_]{50,}\b/g,
    replace: "[REDACTED_GITHUB_PAT]"
  },
  // AWS Access Key IDs
  {
    type: "AWS_ACCESS_KEY",
    regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    replace: "[REDACTED_AWS_KEY]"
  },
  // AWS Secret Access Key assignment
  {
    type: "AWS_SECRET_KEY",
    regex: /(aws_secret_access_key|aws_secret_key)\s*[:=]\s*["']?([a-zA-Z0-9/+=]{40})["']?/gi,
    replace: (_match: string, p1: string) => `${p1}="[REDACTED_AWS_SECRET_KEY]"`
  },
  // Private Key Blocks
  {
    type: "PRIVATE_KEY_BLOCK",
    regex: new RegExp("-----" + "BEGIN (?:[A-Z ]+ )?" + "PRIVATE KEY-----[\\s\\S]*?-----" + "END (?:[A-Z ]+ )?" + "PRIVATE KEY-----", "g"),
    replace: "[REDACTED_PRIVATE_KEY_BLOCK]"
  },
  // Slack API / Bot Tokens
  {
    type: "SLACK_TOKEN",
    regex: /\bxox[baprs]-[0-9a-zA-Z]{10,}(?:-[0-9a-zA-Z]{10,})?(?:-[0-9a-zA-Z]{16,})?\b/g,
    replace: "[REDACTED_SLACK_TOKEN]"
  },
  // Google API Keys
  {
    type: "GOOGLE_API_KEY",
    regex: /\bAIza[0-9A-Za-z-_]{35}\b/g,
    replace: "[REDACTED_GOOGLE_API_KEY]"
  },
  // JSON Web Tokens (JWT) / Bearer tokens
  {
    type: "JWT_TOKEN",
    regex: /\beyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{12,}\b/g,
    replace: "[REDACTED_JWT_TOKEN]"
  },
  // Database Connection URIs with embedded passwords (postgres://user:pass@host)
  {
    type: "DATABASE_CREDENTIALS",
    regex: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/([^:\s\/]+):([^@\s\/]+)@([^\s\/]+)/gi,
    replace: (_match: string, proto: string, user: string, _pass: string, host: string) =>
      `${proto}://${user}:[REDACTED_PASSWORD]@${host}`
  },
  // Key-value Database connection strings (e.g. host=... password=... or DSN)
  {
    type: "DATABASE_DSN_PASSWORD",
    regex: /(password|pwd)\s*=\s*['"]?([^;\s'"]{4,})['"]?/gi,
    replace: (_match: string, key: string) => `${key}=[REDACTED_PASSWORD]`
  },
  // HTTP Authorization Bearer headers
  {
    type: "AUTH_BEARER_HEADER",
    regex: /(Authorization:\s*Bearer\s+)[a-zA-Z0-9_\-\.]{16,}/gi,
    replace: (_match: string, prefix: string) => `${prefix}[REDACTED_BEARER_TOKEN]`
  },
  // Sigil Internal Connector / Peer Tokens
  {
    type: "SIGIL_TOKEN",
    regex: /\bsigil_[a-zA-Z0-9_-]{20,}\b/gi,
    replace: "[REDACTED_SIGIL_TOKEN]"
  },
  // Generic high-entropy assignment patterns (api_key="...", auth_token="...")
  {
    type: "GENERIC_API_KEY",
    regex: /((?:api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|sigil[_-]?token)\s*[:=]\s*["'])([a-zA-Z0-9_\-\.]{16,})(["'])/gi,
    replace: (_match: string, prefix: string, _val: string, suffix: string) => `${prefix}[REDACTED_SECRET]${suffix}`
  }
];

/**
 * Builds dynamic redaction rules from active environment variables that contain sensitive names
 * (e.g., _KEY, _TOKEN, _SECRET, _PASSWORD, _PASS, _AUTH, _CREDENTIALS, _PRIVATE).
 */
export function buildLiveEnvironmentRules(): SecretPatternRule[] {
  const envRules: SecretPatternRule[] = [];
  if (typeof process === "undefined" || !process.env) {
    return envRules;
  }

  const sensitivePattern = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_AUTH|_CREDENTIALS|_PRIVATE)/i;
  for (const [key, value] of Object.entries(process.env)) {
    if (!sensitivePattern.test(key)) continue;
    if (!value || typeof value !== "string") continue;

    const trimmed = value.trim();
    // Guard against redacting trivial single words or short numbers
    if (trimmed.length < 8) continue;

    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    envRules.push({
      type: `LIVE_ENV_${key.toUpperCase()}`,
      regex: new RegExp(escaped, "g"),
      replace: `[REDACTED_ENV_${key.toUpperCase()}]`
    });
  }

  return envRules;
}

/**
 * Resolves active rules combining default patterns, live environment sentinels,
 * and user-supplied custom rules.
 */
export function resolveRules(options: SigilModOptions = {}): SecretPatternRule[] {
  const rules = [...KNOWN_SECRET_PATTERNS];

  if (options.redactLiveEnvValues ?? true) {
    rules.push(...buildLiveEnvironmentRules());
  }

  if (options.customSentinels && Array.isArray(options.customSentinels)) {
    rules.push(...options.customSentinels);
  }

  return rules;
}

/**
 * Sanitizes a string by stripping out secret patterns according to configured rules.
 */
export function redactSecretsFromString(
  text: string,
  rules: SecretPatternRule[] = KNOWN_SECRET_PATTERNS
): { sanitized: string; count: number; matchedTypes: string[] } {
  if (!text || typeof text !== "string") {
    return { sanitized: text, count: 0, matchedTypes: [] };
  }

  let sanitized = text;
  let count = 0;
  const matchedTypes: Set<string> = new Set();

  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    const matches = sanitized.match(rule.regex);
    if (matches && matches.length > 0) {
      count += matches.length;
      matchedTypes.add(rule.type);
      sanitized = sanitized.replace(rule.regex, rule.replace as any);
    }
  }

  return { sanitized, count, matchedTypes: Array.from(matchedTypes) };
}

/**
 * Recursively inspects and sanitizes objects, arrays, and strings.
 */
export function deepRedactSecrets<T>(
  data: T,
  rules: SecretPatternRule[] = KNOWN_SECRET_PATTERNS
): { sanitized: T; count: number; matchedTypes: string[] } {
  if (data === null || data === undefined) {
    return { sanitized: data, count: 0, matchedTypes: [] };
  }

  if (typeof data === "string") {
    const res = redactSecretsFromString(data, rules);
    return { sanitized: res.sanitized as unknown as T, count: res.count, matchedTypes: res.matchedTypes };
  }

  if (Array.isArray(data)) {
    let totalCount = 0;
    const allTypes: Set<string> = new Set();
    const sanitizedArray = data.map((item) => {
      const res = deepRedactSecrets(item, rules);
      totalCount += res.count;
      res.matchedTypes.forEach((t) => allTypes.add(t));
      return res.sanitized;
    });
    return { sanitized: sanitizedArray as unknown as T, count: totalCount, matchedTypes: Array.from(allTypes) };
  }

  if (typeof data === "object") {
    let totalCount = 0;
    const allTypes: Set<string> = new Set();
    const sanitizedObj: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
      const isSensitiveKey = /^(password|secret|api[_-]?key|token|auth|credential|private[_-]?key)$/i.test(key);
      if (isSensitiveKey && typeof val === "string" && val.length > 0) {
        sanitizedObj[key] = `[REDACTED_${key.toUpperCase()}]`;
        totalCount += 1;
        allTypes.add("SENSITIVE_KEY_VALUE");
        continue;
      }

      const res = deepRedactSecrets(val, rules);
      totalCount += res.count;
      res.matchedTypes.forEach((t) => allTypes.add(t));
      sanitizedObj[key] = res.sanitized;
    }

    return { sanitized: sanitizedObj as unknown as T, count: totalCount, matchedTypes: Array.from(allTypes) };
  }

  return { sanitized: data, count: 0, matchedTypes: [] };
}

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) serializer using canonical relay/v1/jcs.mjs.
 */
export function canonicalizeJCS(value: unknown): string {
  return canonicalJson(value);
}

/**
 * Evaluates whether a tool call represents a high-risk mutation or network egress
 * requiring Sigil biometric authorization.
 */
export function assessToolRisk(toolName: string, input: Record<string, unknown>): { isHighRisk: boolean; riskFactors: string[] } {
  const riskFactors: string[] = [];

  // 1. Filesystem Mutation Tools
  if (["Write", "Edit", "NotebookEdit"].includes(toolName)) {
    const targetPath = String(input.file_path || input.path || "");
    riskFactors.push(`Filesystem mutation via ${toolName} on target: ${targetPath}`);

    // Critical configuration files carry elevated risk
    if (
      targetPath.includes(".github/workflows") ||
      targetPath.includes(".env") ||
      targetPath.includes("package.json") ||
      targetPath.includes("settings.json") ||
      targetPath.includes("herdr-config.toml")
    ) {
      riskFactors.push("High-impact infrastructure or configuration file modification");
    }
    return { isHighRisk: true, riskFactors };
  }

  // 2. Terminal Shell Command Execution (Bash)
  if (toolName === "Bash") {
    const command = String(input.command || "").trim();

    // Destructive file deletion / repository resets
    if (/(\brm\s+-rf|\bgit\s+reset\s+--hard|\bgit\s+clean\s+-f|\bdrop\s+database|\btruncate\b)/i.test(command)) {
      riskFactors.push("Destructive filesystem or database purge command detected");
    }

    // Outbound network egress / publish commands
    if (/(\bgit\s+push\b|\bcurl\b|\bwget\b|\bssh\b|\bscp\b|\brsync\b|\bnpm\s+publish\b|\bdocker\s+push\b)/i.test(command)) {
      riskFactors.push("Outbound network egress or remote repository push command detected");
    }

    // Privilege escalation or process manipulation
    if (/(\bsudo\b|\bchmod\b|\bchown\b|\bkill\s+-9\b|\bpkill\b)/i.test(command)) {
      riskFactors.push("System permission mutation or process kill command detected");
    }

    if (riskFactors.length > 0) {
      return { isHighRisk: true, riskFactors };
    }
  }

  // 3. Destructive MCP Tools
  if (toolName.startsWith("mcp__") && /(\bwrite|\bdelete|\bupdate|\bexecute|\bpost|\bpatch)/i.test(toolName)) {
    riskFactors.push(`External MCP action with mutation semantics: ${toolName}`);
    return { isHighRisk: true, riskFactors };
  }

  // Read-only tools pass through smoothly
  return { isHighRisk: false, riskFactors: [] };
}

/**
 * Dispatches an RFC 8785 canonicalized approval request to the Sigil Local Connector.
 */
export async function requestSigilBiometricApproval(
  requestPayload: SigilApprovalRequest,
  fetchImpl: typeof fetch = fetch,
  options: SigilModOptions = {}
): Promise<SigilApprovalResponse> {
  const connectorUrl = options.connectorUrl || process.env.SIGIL_CONNECTOR_URL || "http://127.0.0.1:8787";
  const connectorToken = options.connectorToken ?? process.env.SIGIL_CONNECTOR_TOKEN ?? "";
  const timeoutMs = options.timeoutMs ?? parseInt(process.env.SIGIL_TIMEOUT_MS || "30000", 10);
  const shadowMode = options.shadowMode ?? (process.env.SIGIL_SHADOW_MODE === "true");

  if (shadowMode || (!connectorToken && process.env.SIGIL_ALLOW_UNCONFIGURED_SHADOW === "true")) {
    console.warn("[Sigil Gate Mod] [SHADOW MODE] Simulating biometric grant. JCS Envelope verified.");
    return {
      approved: true,
      signature: "0x_simulated_sigil_ed25519_biometric_passkey_signature",
      timestamp: new Date().toISOString()
    };
  }

  if (!connectorToken) {
    return {
      approved: false,
      error: "SIGIL_CONNECTOR_TOKEN is not configured. Biometric clearance required."
    };
  }

  const serializedJCS = canonicalizeJCS(requestPayload);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${connectorUrl}/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${connectorToken}`,
        "X-Sigil-Canonical-Format": "RFC-8785-JCS"
      },
      body: serializedJCS,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        approved: false,
        error: `Sigil Local Connector returned HTTP ${response.status}: ${response.statusText}`
      };
    }

    const result = (await response.json()) as SigilApprovalResponse;
    return result;
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      approved: false,
      error: `Sigil Local Connector communication failure: ${errorMsg}`
    };
  }
}

/**
 * Main Claude Code Mod entrypoint for the 'tool.check' lifecycle event.
 */
export async function handleToolCheck(
  event: ToolCheckEvent,
  next: (e: ToolCheckEvent) => Promise<ToolCheckResult>,
  context: SigilModContext = {}
): Promise<ToolCheckResult> {
  const toolName = event.tool?.name || "unknown";
  const rawInput = event.tool?.input || {};
  const agentId = event.agentId || "session-main";
  const conversationId = event.conversationId || `conv_${Date.now().toString(16)}`;

  // Step 1: Secret Redaction on Tool Input
  const enableRedaction = context.options?.enableSecretRedaction ?? true;
  let activeInput = rawInput;
  let interceptedSecrets: string[] = [];

  if (enableRedaction) {
    const activeRules = resolveRules(context.options);
    const redactionRes = deepRedactSecrets(rawInput, activeRules);
    activeInput = redactionRes.sanitized as Record<string, unknown>;
    interceptedSecrets = redactionRes.matchedTypes;

    if (redactionRes.count > 0) {
      console.warn(
        `[Sigil Gate Mod] Auto-redacted ${redactionRes.count} secret(s) [${interceptedSecrets.join(", ")}] from input of '${toolName}'`
      );
      event.tool.input = activeInput;
    }
  }

  // Step 2: Evaluate Risk Profile
  const { isHighRisk, riskFactors } = assessToolRisk(toolName, activeInput);

  if (!isHighRisk) {
    return next(event);
  }

  // Step 3: Trigger Sigil Biometric Gate
  if (context.ui?.notify) {
    context.ui.notify({
      title: "Sigil Biometric Gate",
      message: `Touch ID / Windows Hello required for high-risk action: ${toolName}`,
      channel: "sigil"
    });
  }

  const endpointIdentity = context.options?.endpointIdentity || process.env.SIGIL_ENDPOINT_IDENTITY || "operator:claude-code:local";

  const approvalRequest: SigilApprovalRequest = {
    message_id: `msg_${Date.now().toString(16)}${Math.random().toString(16).substring(2, 8)}`,
    conversation_id: conversationId,
    message_type: "approval.request",
    sender_endpoint: `${endpointIdentity}:${agentId}`,
    recipient_endpoint: "operator:human:webauthn",
    content: {
      payload: {
        action_type: "TOOL_EXECUTION_GATE",
        tool_name: toolName,
        parameters: activeInput,
        risk_factors: riskFactors,
        agent_id: agentId,
        secrets_intercepted: interceptedSecrets.length > 0 ? interceptedSecrets : undefined
      },
      text_summary: `Sigil Biometric Gate: Authorize execution of '${toolName}' (${riskFactors[0]})`
    },
    requires_human_approval: true,
    timestamp: new Date().toISOString()
  };

  const fetchImplementation = context.http?.fetch || fetch;
  const verification = await requestSigilBiometricApproval(approvalRequest, fetchImplementation, context.options);

  if (verification.approved && verification.signature) {
    console.info(`[Sigil Gate Mod] Biometric consent granted. Signature: ${verification.signature.slice(0, 18)}...`);
    return { decision: "allow", sanitizedInput: activeInput };
  }

  const failureReason = verification.error || "WebAuthn biometric verification rejected or timed out by operator.";
  console.warn(`[Sigil Gate Mod] Execution blocked by Sigil Gate: ${failureReason}`);
  
  return {
    decision: "deny",
    reason: `[Sigil Security Gate] Action blocked: ${failureReason}`
  };
}

/**
 * Lifecycle Hook 2: 'tool.result'
 * Intercepts tool outputs (stdout, stderr, error logs, command outputs)
 * before context injection.
 */
export async function handleToolResult(
  event: ToolResultEvent,
  next: (e: ToolResultEvent) => Promise<ToolResultOutput>,
  context: SigilModContext = {}
): Promise<ToolResultOutput> {
  const enableRedaction = context.options?.enableSecretRedaction ?? true;

  if (!enableRedaction || !event.output) {
    return next(event);
  }

  const activeRules = resolveRules(context.options);
  const redaction = deepRedactSecrets(event.output, activeRules);

  if (redaction.count > 0) {
    console.warn(
      `[Sigil Gate Mod] Sanitized ${redaction.count} secret(s) [${redaction.matchedTypes.join(", ")}] from output of '${event.tool?.name || "unknown"}' before context injection.`
    );
    event.output = redaction.sanitized as Record<string, unknown>;
  }

  const downstreamResult = await next(event);
  return {
    ...downstreamResult,
    redactedCount: redaction.count
  };
}

/**
 * Default Plugin Export for Claude Code Mod Registration.
 */
export default function registerSigilGateMod(api: {
  on: (event: string, handler: (...args: any[]) => Promise<any>) => void;
  ui?: SigilModContext["ui"];
  http?: SigilModContext["http"];
  options?: SigilModOptions;
}): void {
  // Hook 1: Pre-execution validation, Input sanitization & Biometric Gate
  api.on("tool.check", (event: ToolCheckEvent, next: (e: ToolCheckEvent) => Promise<ToolCheckResult>) =>
    handleToolCheck(event, next, { ui: api.ui, http: api.http, options: api.options })
  );

  // Hook 2: Post-execution output sanitization before context window injection
  api.on("tool.result", (event: ToolResultEvent, next: (e: ToolResultEvent) => Promise<ToolResultOutput>) =>
    handleToolResult(event, next, { ui: api.ui, http: api.http, options: api.options })
  );
}
