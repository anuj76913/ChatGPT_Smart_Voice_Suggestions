import { memo, useState } from 'react';
import Markdown from 'react-markdown';
import type { EntryPoint, SuggestionCardPayload } from '@svs/shared';
import { events } from '../lib/events';
import { SuggestionCard, type CardStatus } from './SuggestionCard';

export type UiStatus = 'streaming' | 'complete' | 'aborted' | 'error';

export interface UiMessage {
  key: string;
  /** Server id once known. */
  id: string | null;
  role: 'user' | 'assistant';
  content: string;
  status: UiStatus;
  errorCode?: string;
  /** For assistant replies: the request to resend on Retry (same client_msg_id → idempotent). */
  retry?: { text: string; clientMsgId: string };
  /** Assistant replies: the Smart Voice Suggestion card under this answer (treatment only). */
  suggestion?: (SuggestionCardPayload & { status: CardStatus }) | null;
  /** A voice-session recap: not a model answer, so it can't be rated. */
  kind?: 'voice_recap';
}

const ERROR_TEXT: Record<string, string> = {
  rate_limited: 'Too many requests right now. Please wait a moment and retry.',
  in_progress: 'This question is still being answered in another tab.',
  llm_unavailable: "Couldn't get an answer right now.",
};

function Feedback({ messageId, hadSuggestion }: { messageId: string; hadSuggestion: boolean }) {
  const [value, setValue] = useState<'up' | 'down' | null>(null);
  const vote = (thumbs: 'up' | 'down') => {
    setValue(thumbs);
    // Guardrail metric input (thumbs-down rate). No content, only ids and enums.
    events.log('answer_feedback', { props: { message_id: messageId, thumbs, had_suggestion: hadSuggestion } });
  };
  return (
    <div className="feedback" role="group" aria-label="Rate this answer">
      <button type="button" className="icon-btn" aria-label="Good answer" aria-pressed={value === 'up'} onClick={() => vote('up')}>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 10v11H4V10h3Zm0 0 4-8a3 3 0 0 1 3 3v4h5.5a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.1 21H7" />
        </svg>
      </button>
      <button type="button" className="icon-btn" aria-label="Bad answer" aria-pressed={value === 'down'} onClick={() => vote('down')}>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 14V3h3v11h-3Zm0 0-4 8a3 3 0 0 1-3-3v-4H4.5a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.9 3H17" />
        </svg>
      </button>
    </div>
  );
}

export const MessageView = memo(function MessageView({
  m,
  onRetry,
  onOptedOut,
  onStartVoice,
}: {
  m: UiMessage;
  onRetry: (m: UiMessage) => void;
  onOptedOut: () => void;
  onStartVoice: (card: SuggestionCardPayload, entryPoint: EntryPoint) => void;
}) {
  if (m.role === 'user') {
    return (
      <div className="row row-user">
        <div className="bubble bubble-user">{m.content}</div>
      </div>
    );
  }
  const thinking = m.status === 'streaming' && m.content === '';
  return (
    <div className="row row-assistant">
      <div className="bubble bubble-assistant" aria-busy={m.status === 'streaming'}>
        {thinking ? (
          <span className="thinking">
            <span className="thinking-dot" aria-hidden="true" />
            <span className="sr-only">Thinking…</span>
          </span>
        ) : (
          <div className="markdown">
            <Markdown>{m.content}</Markdown>
          </div>
        )}
        {m.status === 'aborted' && <p className="note">Stopped.</p>}
        {m.status === 'error' && (
          <div className="note note-error" role="alert">
            <span>{ERROR_TEXT[m.errorCode ?? ''] ?? ERROR_TEXT.llm_unavailable}</span>
            {m.retry && (
              <button type="button" className="btn btn-small" onClick={() => onRetry(m)}>
                Retry
              </button>
            )}
          </div>
        )}
        {m.status === 'complete' && m.id && m.kind !== 'voice_recap' && <Feedback messageId={m.id} hadSuggestion={!!m.suggestion} />}
      </div>
      {/* Smart Voice Suggestion card: only below a completed answer (FR-2). */}
      <div className="suggestion-slot" data-message-id={m.id ?? undefined}>
        {m.status === 'complete' && m.suggestion && <SuggestionCard card={m.suggestion} status={m.suggestion.status} onOptedOut={onOptedOut} onStartVoice={onStartVoice} />}
      </div>
    </div>
  );
});
