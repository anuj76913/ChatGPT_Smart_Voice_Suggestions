import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

/**
 * Pill-shaped composer. The round button on the right is "Practise speaking" while the box is empty (voice
 * without a card, entry_point = mic_button), turns into Send once there is text, and into Stop while an
 * answer streams. Icons are SVG, not emoji: emoji fonts vary by device and can render faint or missing.
 */
export function Composer({
  busy,
  maxChars,
  onSend,
  onStop,
  onMic,
  prefill,
}: {
  busy: boolean;
  maxChars: number;
  onSend: (text: string) => void;
  onStop: () => void;
  onMic?: () => void;
  /** Example prompt typed into the box on a first visit, so a newcomer sees what the prototype is for. */
  prefill?: string;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  /** The learner typed or edited: the example animation must never overwrite their text. */
  const touched = useRef(false);

  // Types the example prompt in, letter by letter (instantly with reduced motion). Stops as soon as the learner types.
  useEffect(() => {
    if (!prefill) {
      // The example was withdrawn (e.g. an old chat was opened): drop it unless the learner made it their own.
      if (!touched.current) setText('');
      return;
    }
    touched.current = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const focusIfDesktop = () => {
      // Desktop only: focusing on a phone would pop the keyboard over the screen.
      if (window.matchMedia?.('(pointer: fine)').matches) ref.current?.focus();
    };
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setText(prefill);
      return;
    }
    let i = 0;
    const start = setTimeout(() => {
      timer = setInterval(() => {
        if (touched.current) return clearInterval(timer);
        i += 1;
        setText(prefill.slice(0, i));
        if (i >= prefill.length) {
          clearInterval(timer);
          focusIfDesktop();
        }
      }, 35);
    }, 700);
    return () => {
      clearTimeout(start);
      clearInterval(timer);
    };
  }, [prefill]);

  // Grow with content up to ~8 lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const hasText = text.trim().length > 0;
  const canSend = !busy && hasText && text.length <= maxChars;
  const send = () => {
    if (!canSend) return;
    onSend(text.trim());
    touched.current = true;
    setText('');
    ref.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <label className="sr-only" htmlFor="composer-input">
        Message
      </label>
      <textarea
        id="composer-input"
        ref={ref}
        className="composer-input"
        rows={1}
        value={text}
        maxLength={maxChars}
        placeholder="Ask anything"
        aria-describedby="composer-hint"
        onChange={(e) => {
          touched.current = true;
          setText(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <span id="composer-hint" className="sr-only">
        Enter to send, Shift+Enter for a new line.
      </span>
      {!busy && hasText && onMic && (
        <button type="button" className="icon-btn composer-mic" aria-label="Practise speaking" title="Practise speaking" onClick={onMic}>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
          </svg>
        </button>
      )}
      {busy ? (
        <button type="button" className="round-btn" aria-label="Stop answer" title="Stop" onClick={onStop}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14">
            <rect width="14" height="14" rx="2" fill="currentColor" />
          </svg>
        </button>
      ) : hasText || !onMic ? (
        <button type="submit" className="round-btn" aria-label="Send" title="Send" disabled={!canSend}>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      ) : (
        <button type="button" className="round-btn" aria-label="Practise speaking" title="Practise speaking" onClick={onMic}>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
          </svg>
        </button>
      )}
    </form>
  );
}
