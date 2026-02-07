import type {
  AgentHandle,
  OpenClawSessionsHistoryResult,
  OpenClawToolEnvelope,
} from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function extractToolText(envelope: unknown): string | undefined {
  if (!isRecord(envelope)) return undefined;
  const result = envelope.result;
  if (!isRecord(result)) return undefined;
  const content = result.content;
  if (!Array.isArray(content)) return undefined;

  for (const chunk of content) {
    if (!isRecord(chunk)) continue;
    if (chunk.type === "text" && typeof chunk.text === "string") {
      return chunk.text;
    }
  }

  return undefined;
}

function resolveGatewayEnv(handle: AgentHandle): {
  url: string;
  token: string;
} {
  const upper = handle.toUpperCase();

  const url =
    process.env[`OPENCLAW_GATEWAY_URL_${upper}`] ??
    process.env.OPENCLAW_GATEWAY_URL ??
    "";

  const token =
    process.env[`OPENCLAW_GATEWAY_TOKEN_${upper}`] ??
    process.env.OPENCLAW_GATEWAY_TOKEN ??
    "";

  return { url, token };
}

export function isGatewayConfigured(handle: AgentHandle): boolean {
  const { url, token } = resolveGatewayEnv(handle);
  return Boolean(url && token);
}

async function invokeOpenClawTool<T>(params: {
  handle: AgentHandle;
  tool: string;
  args: Record<string, unknown>;
}): Promise<T> {
  const { url, token } = resolveGatewayEnv(params.handle);

  if (!url || !token) {
    throw new Error(`OpenClaw gateway not configured for @${params.handle}`);
  }

  const res = await fetch(`${url}/tools/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ tool: params.tool, args: params.args }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${params.tool} failed: ${res.status} ${text.slice(0, 300)}`,
    );
  }

  let envelope: OpenClawToolEnvelope;
  try {
    envelope = JSON.parse(text) as OpenClawToolEnvelope;
  } catch {
    throw new Error(
      `${params.tool} failed: non-JSON response: ${text.slice(0, 300)}`,
    );
  }

  // Treat HTTP 200 + { ok:false } as failure.
  if (envelope.ok === false) {
    throw new Error(
      `${params.tool} failed: ${envelope.errorCode ?? ""} ${envelope.errorMessage ?? ""}`.trim(),
    );
  }

  // Prefer parsing the tool's JSON payload embedded in result.content[0].text
  const toolText = extractToolText(envelope);
  const parsedPayload: unknown = (() => {
    if (typeof toolText !== "string") return undefined;
    try {
      return JSON.parse(toolText);
    } catch {
      return toolText;
    }
  })();

  // Treat tool-level status errors as failures (even if HTTP 200).
  if (isRecord(parsedPayload) && typeof parsedPayload.status === "string") {
    const status = parsedPayload.status;
    if (status === "error" || status === "forbidden" || status === "timeout") {
      const err =
        typeof parsedPayload.error === "string" ? parsedPayload.error : "";
      throw new Error(
        `${params.tool} failed: ${status}${err ? `: ${err}` : ""}`,
      );
    }
  }

  return (parsedPayload ?? envelope) as T;
}

export function getTaskSessionKey(taskId: string): string {
  // Canonical session key (no resolution; auto-creates on first send)
  return `agent:main:void:task:${taskId}`;
}

export async function sessionsSend(params: {
  handle: AgentHandle;
  sessionKey: string;
  message: string;
  timeoutSeconds?: number;
}): Promise<void> {
  await invokeOpenClawTool({
    handle: params.handle,
    tool: "sessions_send",
    args: {
      sessionKey: params.sessionKey,
      message: params.message,
      timeoutSeconds: params.timeoutSeconds ?? 0,
    },
  });
}

export async function sessionsHistory(params: {
  handle: AgentHandle;
  sessionKey: string;
  limit?: number;
}): Promise<OpenClawSessionsHistoryResult> {
  return await invokeOpenClawTool<OpenClawSessionsHistoryResult>({
    handle: params.handle,
    tool: "sessions_history",
    args: {
      sessionKey: params.sessionKey,
      limit: params.limit ?? 200,
      includeTools: false,
    },
  });
}
