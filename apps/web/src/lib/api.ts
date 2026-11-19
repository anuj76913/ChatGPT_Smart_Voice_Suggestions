import {
  readSseData,
  type ChatMessage,
  type ChatStreamEvent,
  type ClientConfig,
  type ClientEventInput,
  type ConversationSummary,
  type Me,
  type SendMessageRequest,
  type VoicePreferences,
  type CreateVoiceSessionRequest,
  type CreateVoiceSessionResponse,
  type VoiceSessionStats,
  type SessionSummary,
  type MetricsReport,
  type FeedbackReportRequest,
} from '@svs/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

/** Fired when any request comes back 401, so the app can return to the login screen. */
export const onUnauthorized = new EventTarget();

async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      code = ((await res.json()) as { error?: string }).error ?? code;
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401) onUnauthorized.dispatchEvent(new Event('unauthorized'));
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => request<Me>('GET', '/v1/me'),
  login: (handle: string) => request<Me>('POST', '/v1/auth/dev-login', { handle }),
  logout: () => request<{ ok: true }>('POST', '/v1/auth/logout'),
  listConversations: () => request<{ conversations: ConversationSummary[] }>('GET', '/v1/conversations'),
  createConversation: () => request<ConversationSummary>('POST', '/v1/conversations'),
  listMessages: (id: string) => request<{ messages: ChatMessage[] }>('GET', `/v1/conversations/${id}/messages`),
  clientConfig: () => request<ClientConfig>('GET', '/v1/config/client'),
  postEvents: (events: ClientEventInput[], keepalive = false) =>
    request<{ accepted: number; duplicates: number; rejected: unknown[] }>('POST', '/v1/events', { events }, { keepalive }),
  dismissSuggestion: (id: string, keepalive = false) =>
    request<{ counted: boolean; consecutive_dismissals?: number; paused?: boolean }>('POST', `/v1/suggestions/${id}/dismiss`, undefined, { keepalive }),
  tapSuggestion: (id: string) => request<{ tapped: boolean; intent: string }>('POST', `/v1/suggestions/${id}/tap`),
  getVoicePrefs: () => request<VoicePreferences>('GET', '/v1/me/voice-preferences'),
  putVoicePrefs: (body: Partial<Pick<VoicePreferences, 'suggestions_enabled' | 'voice_speed' | 'voice_accent' | 'voice_quiet'>> & { suggestion_id?: string }) =>
    request<VoicePreferences>('PUT', '/v1/me/voice-preferences', body),
  ackPrivacyNotice: () => request<{ privacy_notice_seen: true }>('POST', '/v1/me/privacy-notice-ack'),
  createVoiceSession: (body: CreateVoiceSessionRequest) => request<CreateVoiceSessionResponse>('POST', '/v1/voice/sessions', body),
  endVoiceSession: (id: string) => request<VoiceSessionStats>('POST', `/v1/voice/sessions/${id}/end`, {}),
  continueInText: (id: string) =>
    request<{ conversation_id: string | null; message_id: string | null; stats: VoiceSessionStats }>('POST', `/v1/voice/sessions/${id}/continue-in-text`, {}),
  getVoiceSummary: (id: string) => request<SessionSummary>('GET', `/v1/voice/sessions/${id}/summary`),
  /** P8.2 research consent (dogfood participants). */
  setResearchConsent: (granted: boolean) => request<{ research_consent: 'granted' | 'declined' }>('POST', '/v1/me/research-consent', { granted }),
  /** P8.3 Report a problem (dogfood participants and admins). */
  sendFeedback: (body: FeedbackReportRequest) => request<{ id: string }>('POST', '/v1/feedback', body),
  /** P6.3 admin analytics (403 for non-admins). */
  analyticsReport: (q: { from: string; to: string; experiment_id?: string }) =>
    request<{ report: MetricsReport; decision: { decision: string; reasons: string[]; checks: Array<{ name: string; pass: boolean | null; detail: string }> } | null }>(
      'GET',
      `/v1/admin/analytics/report?${new URLSearchParams(q).toString()}`,
    ),
  recapVoiceSession: (id: string) => request<{ message_id: string | null }>('POST', `/v1/voice/sessions/${id}/recap`, {}),
};

/** POST a message and read the SSE answer stream (architecture §9.1). Resolves when the stream ends. */
export async function streamMessage(
  conversationId: string,
  body: SendMessageRequest,
  onEvent: (e: ChatStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`/v1/conversations/${conversationId}/messages`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let code = `http_${res.status}`;
    try {
      code = ((await res.json()) as { error?: string }).error ?? code;
    } catch {
      /* ignore */
    }
    if (res.status === 401) onUnauthorized.dispatchEvent(new Event('unauthorized'));
    throw new ApiError(res.status, code);
  }
  for await (const data of readSseData(res.body)) onEvent(JSON.parse(data) as ChatStreamEvent);
}
