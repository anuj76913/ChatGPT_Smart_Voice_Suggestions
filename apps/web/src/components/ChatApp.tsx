import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_MESSAGE_CHARS, type ChatStreamEvent, type ConversationSummary, type CreateVoiceSessionRequest, type EntryPoint, type Me, type SuggestionCardPayload } from '@svs/shared';
import { api, ApiError, streamMessage } from '../lib/api';
import { getClientConfig } from '../lib/client-config';
import { Composer } from './Composer';
import { MessageView, type UiMessage } from './MessageView';
import { Settings } from './Settings';
import { FeaturesContext, type Features } from '../lib/features';
import { PracticePicker } from './PracticePicker';
import { ReportProblem } from './ReportProblem';
import { VoiceFlow } from './VoiceFlow';

/**
 * Typed into the box on a first visit so anyone opening the link sees what the prototype does: a practice
 * request that gets a real text answer (how to answer), with the voice suggestion card offered under it.
 */
export const EXAMPLE_PROMPT = "My PM interview is tomorrow. How should I answer 'Tell me about yourself'? I want to practise it.";

/** 24 px line icon (stroke paths). */
function Icon({ d }: { d: string }) {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

/** C1 Chat UI: conversations, streamed answers, stop/retry, feedback and the (empty) suggestion slot. */
export function ChatApp({ me }: { me: Me }) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [maxChars, setMaxChars] = useState(MAX_MESSAGE_CHARS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** `settings`: the toast offers a shortcut to Settings (e.g. after opting out). */
  const [toast, setToast] = useState<{ text: string; settings?: boolean } | null>(null);
  const [voice, setVoice] = useState<CreateVoiceSessionRequest | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [features, setFeatures] = useState<Features>({ preview_mode: false, quiet_mode: false });
  const [reportOpen, setReportOpen] = useState(false);
  const [consent, setConsent] = useState(me.research_consent);
  /** The example prompt shows until the learner sends their first message (this page load). */
  const [showExample, setShowExample] = useState(true);
  const canReport = me.is_dogfood || me.is_admin;
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations((await api.listConversations()).conversations);
    } catch {
      /* list is best-effort */
    }
  }, []);

  useEffect(() => {
    void refreshConversations();
    void getClientConfig().then((c) => {
      setMaxChars(c.max_message_chars);
      if (c.features) setFeatures(c.features);
    });
  }, [refreshConversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const openConversation = async (id: string) => {
    abortRef.current?.abort();
    setDrawerOpen(false);
    setActiveId(id);
    setLoadError(null);
    try {
      const { messages: rows } = await api.listMessages(id);
      setMessages(rows.map((r) => ({ key: r.id, id: r.id, role: r.role, content: r.content, status: r.status, suggestion: r.suggestion ?? null, kind: r.kind })));
    } catch {
      setMessages([]);
      setLoadError("Couldn't load this conversation.");
    }
  };

  const newChat = () => {
    abortRef.current?.abort();
    setActiveId(null);
    setMessages([]);
    setDrawerOpen(false);
    setLoadError(null);
  };

  const patch = (key: string, p: Partial<UiMessage>) => setMessages((ms) => ms.map((m) => (m.key === key ? { ...m, ...p } : m)));

  const run = async (text: string, clientMsgId: string, isRetry: boolean) => {
    let convId = activeId;
    setBusy(true);
    try {
      if (!convId) {
        const c = await api.createConversation();
        convId = c.id;
        setActiveId(c.id);
        setConversations((cs) => [c, ...cs]);
      }
      const assistantKey = `a-${clientMsgId}-${Date.now()}`;
      setMessages((ms) => [
        ...(isRetry ? ms.filter((m) => m.retry?.clientMsgId !== clientMsgId) : [...ms, { key: `u-${clientMsgId}`, id: null, role: 'user' as const, content: text, status: 'complete' as const }]),
        { key: assistantKey, id: null, role: 'assistant', content: '', status: 'streaming', retry: { text, clientMsgId } },
      ]);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      let ended = false;
      const onEvent = (e: ChatStreamEvent) => {
        if (e.type === 'answer.delta') setMessages((ms) => ms.map((m) => (m.key === assistantKey ? { ...m, id: e.message_id, content: m.content + e.text } : m)));
        else if (e.type === 'answer.complete') {
          patch(assistantKey, { id: e.message_id, status: 'complete', retry: undefined });
          setAnnounce('Answer ready.');
        } else if (e.type === 'answer.error') {
          patch(assistantKey, { status: 'error', errorCode: e.code });
          setAnnounce("Couldn't get an answer.");
        } else if (e.type === 'suggestion') {
          const { type: _t, message_id: _m, ...card } = e;
          patch(assistantKey, { suggestion: { ...card, status: 'shown' } });
          setAnnounce('Voice practice available.');
        } else if (e.type === 'stream.end') ended = true;
      };
      try {
        await streamMessage(convId, { text, client_msg_id: clientMsgId }, onEvent, ctrl.signal);
        if (!ended) patch(assistantKey, { status: 'error', errorCode: 'llm_unavailable' });
      } catch (err) {
        if (ctrl.signal.aborted) patch(assistantKey, { status: 'aborted', retry: undefined });
        else patch(assistantKey, { status: 'error', errorCode: err instanceof ApiError ? err.code : 'llm_unavailable' });
      }
    } catch {
      setLoadError("Couldn't start a conversation. Check your connection and try again.");
    } finally {
      abortRef.current = null;
      setBusy(false);
      void refreshConversations();
    }
  };

  const send = (text: string) => {
    setShowExample(false);
    void run(text, crypto.randomUUID(), false);
  };
  const retry = (m: UiMessage) => m.retry && void run(m.retry.text, m.retry.clientMsgId, true);
  const stop = () => abortRef.current?.abort();
  const onStartVoice = useCallback(
    (card: SuggestionCardPayload, entryPoint: EntryPoint) =>
      setVoice({ intent: card.intent, entry_point: entryPoint, suggestion_id: card.suggestion_id, ...(activeId ? { conversation_id: activeId } : {}) }),
    [activeId],
  );
  const closeVoice = useCallback(
    (reload: boolean) => {
      setVoice(null);
      if (reload && activeId) void openConversation(activeId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeId],
  );
  const onOptedOut = useCallback(() => setToast({ text: 'Voice suggestions are off. Turn them back on in Settings.', settings: true }), []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);


  const empty = messages.length === 0 && !loadError;

  return (
    <FeaturesContext.Provider value={features}>
    <div className={`app ${drawerOpen ? 'drawer-open' : ''}`}>
      <aside className="sidebar" aria-label="Chats">
        <div className="sidebar-top">
          <span className="sidebar-brand">ChatGPT</span>
          <button type="button" className="icon-btn close-drawer" aria-label="Close sidebar" onClick={() => setDrawerOpen(false)}>
            <Icon d="M6 6l12 12M18 6L6 18" />
          </button>
        </div>
        <nav className="side-nav" aria-label="Main">
          <button type="button" className="side-item" onClick={newChat}>
            <Icon d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            New chat
          </button>
          <button
            type="button"
            className="side-item"
            onClick={() => {
              setDrawerOpen(false);
              setPickerOpen(true);
            }}
          >
            <Icon d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
            Voice practice
          </button>
          {me.is_admin && (
            <a className="side-item" href="#/admin/analytics">
              <Icon d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
              Analytics
            </a>
          )}
        </nav>
        <h2 className="side-heading">Recents</h2>
        <nav className="conv-list" aria-label="Recent chats">
          {conversations.length === 0 && <p className="muted small pad">Your chats will show up here.</p>}
          {conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`conv-item ${c.id === activeId ? 'active' : ''}`}
              aria-current={c.id === activeId ? 'page' : undefined}
              onClick={() => void openConversation(c.id)}
            >
              {c.title ?? 'New conversation'}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          {canReport && (
            <button
              type="button"
              className="side-item"
              onClick={() => {
                setDrawerOpen(false);
                setReportOpen(true);
              }}
            >
              <Icon d="M4 21V4h12l-2 4 2 4H4" />
              Report a problem
            </button>
          )}
          <button type="button" className="side-item profile" onClick={() => setSettingsOpen(true)}>
            <span className="avatar" aria-hidden="true">
              {me.is_admin ? 'A' : 'S'}
            </span>
            <span className="profile-text">
              <span>Settings</span>
              <span className="muted small">{me.is_admin ? 'Admin' : 'Student · Free'}</span>
            </span>
          </button>
        </div>
      </aside>
      {drawerOpen && <div className="scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}

      <main className={`main ${empty ? 'main-empty' : ''}`}>
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" aria-label="Open conversations" aria-expanded={drawerOpen} onClick={() => setDrawerOpen((o) => !o)}>
            <Icon d="M4 7h16M4 12h16M4 17h10" />
          </button>
          <h1 className="brand">ChatGPT</h1>
          <button type="button" className="icon-btn new-btn" aria-label="New chat" onClick={newChat}>
            <Icon d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </button>
        </header>

        {me.is_dogfood && consent === null && (
          <section className="consent-banner" aria-labelledby="consent-title">
            <h2 id="consent-title" className="consent-title">Help improve voice suggestions?</h2>
            <p className="small">
              You're in the test group. With your OK, our team may read the questions you type here (not your voice recordings, which are never kept) to
              check when voice practice should be suggested. You can change this any time in Settings.
            </p>
            <p className="muted small">Draft wording, pending Legal / Trust &amp; Safety approval.</p>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => void api.setResearchConsent(false).then((r) => setConsent(r.research_consent)).catch(() => {})}>
                No thanks
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void api.setResearchConsent(true).then((r) => setConsent(r.research_consent)).catch(() => {})}>
                Yes, that's OK
              </button>
            </div>
          </section>
        )}
        {/* aria-live off: streamed tokens must not be read out one by one; the status line below announces completion. */}
        <div className="chat" role="log" aria-live="off" aria-label="Conversation">
          {empty && (
            <div className="empty">
              <h2>Ready when you are.</h2>
              {showExample && (
                <p className="empty-hint muted">
                  Press <kbd>Enter</kbd> to send the example below. When you ask to practise, a <strong>voice practice</strong> suggestion appears under the answer.
                </p>
              )}
            </div>
          )}
          {loadError && (
            <p className="error" role="alert">
              {loadError}
            </p>
          )}
          {messages.map((m) => (
            <MessageView key={m.key} m={m} onRetry={retry} onOptedOut={onOptedOut} onStartVoice={onStartVoice} />
          ))}
          <div ref={bottomRef} />
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {announce}
        </p>
        <div className="composer-wrap">
          <Composer
            busy={busy}
            maxChars={maxChars}
            onSend={send}
            onStop={stop}
            onMic={() => setPickerOpen(true)}
            prefill={showExample && empty ? EXAMPLE_PROMPT : undefined}
          />
          {!empty && <p className="disclaimer">AI answers can be wrong. Check important info.</p>}
        </div>
      </main>

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.settings && (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                setToast(null);
                setSettingsOpen(true);
              }}
            >
              Settings
            </button>
          )}
        </div>
      )}
      {settingsOpen && (
        <Settings
          onClose={() => setSettingsOpen(false)}
          research={me.is_dogfood ? { value: consent, onChange: (granted) => void api.setResearchConsent(granted).then((r) => setConsent(r.research_consent)).catch(() => {}) } : undefined}
        />
      )}
      {voice && <VoiceFlow request={voice} onClose={closeVoice} />}
      {pickerOpen && (
        <PracticePicker
          onClose={() => setPickerOpen(false)}
          onPick={(intent) => {
            setPickerOpen(false);
            setVoice({ intent, entry_point: 'mic_button', ...(activeId ? { conversation_id: activeId } : {}) });
          }}
        />
      )}
      {reportOpen && (
        <ReportProblem
          onClose={() => setReportOpen(false)}
          onSent={() => {
            setReportOpen(false);
            setToast({ text: 'Thanks, your report was sent.' });
          }}
        />
      )}
    </div>
    </FeaturesContext.Provider>
  );
}
