import { useState, useRef, useEffect } from 'react';

const FN_URL = import.meta.env.VITE_LEDGER_FN_URL;
const CAP_KEY = import.meta.env.VITE_CAPTURE_KEY;

function fmtToast(row) {
  const amt = row.actual_cents != null
    ? `$${Math.round(row.actual_cents / 100)}`
    : '(no $)';
  const dir = row.direction === 'expense' ? 'exp' : 'inc';
  return `✓ ${amt} · ${dir} / ${row.stream ?? 'pedicab'} → ${row.ts}`;
}

// Progressive enhancement: webkitSpeechRecognition only where available.
// Primary path is native keyboard dictation mic on iOS/Android.
function useSpeech(onResult) {
  const recRef = useRef(null);
  const [listening, setListening] = useState(false);

  const supported = typeof window !== 'undefined' && 'webkitSpeechRecognition' in window;

  function toggle() {
    if (!supported) return;
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const R = new window.webkitSpeechRecognition();
    R.lang = 'en-US';
    R.interimResults = false;
    R.maxAlternatives = 1;
    R.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      onResult(transcript);
    };
    R.onend = () => setListening(false);
    R.onerror = () => setListening(false);
    recRef.current = R;
    R.start();
    setListening(true);
  }

  return { supported, listening, toggle };
}

export default function CapturePage() {
  const [text, setText] = useState('');
  const [toast, setToast] = useState(null); // { msg, ok }
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const toastTimer = useRef(null);

  const { supported: speechSupported, listening, toggle: toggleSpeech } = useSpeech((transcript) => {
    setText((prev) => (prev ? prev + ' ' + transcript : transcript));
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function showToast(msg, ok) {
    clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }

  async function submit() {
    const raw = text.trim();
    if (!raw || busy) return;
    setBusy(true);
    try {
      const res = await fetch(FN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-capture-key': CAP_KEY,
        },
        body: JSON.stringify({ raw }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      showToast(fmtToast(data), true);
      setText('');
    } catch (err) {
      showToast(`✗ ${err.message}`, false);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const canSubmit = text.trim().length > 0 && !busy;

  return (
    <div style={s.screen}>
      <div style={s.card}>
        {/* ── label ── */}
        <div style={s.eyebrow}>LOG IT</div>

        {/* ── input ──
            Textarea so iOS/Android keyboard dictation mic works on the field.
            enterKeyHint="send" shows a Send key on iOS soft keyboard.
        */}
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={'$30 two fares downtown @cab\nexpense parking $12 @cab\n$177 bula sign @agensi'}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          inputMode="text"
          style={s.input}
          rows={4}
        />

        {/* ── actions ── */}
        <div style={s.row}>
          {/* webkitSpeechRecognition fallback — hidden when not available */}
          {speechSupported && (
            <button
              type="button"
              onClick={toggleSpeech}
              style={{ ...s.micBtn, ...(listening ? s.micBtnActive : {}) }}
              aria-label={listening ? 'Stop listening' : 'Start voice capture'}
            >
              {listening ? '⬛' : '🎤'}
            </button>
          )}

          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            style={{ ...s.logBtn, ...(canSubmit ? {} : s.logBtnDisabled) }}
          >
            {busy ? '…' : 'LOG'}
          </button>
        </div>

        {/* ── toast ── */}
        {toast && (
          <div
            role="status"
            style={{
              ...s.toast,
              background: toast.ok ? '#0d1f0d' : '#1f0d0d',
              borderColor: toast.ok ? '#3a7a3a' : '#7a3a3a',
            }}
          >
            {toast.msg}
          </div>
        )}

        {/* ── parse legend ── */}
        <div style={s.legend}>
          <span style={s.legendItem}><span style={s.amber}>$NN</span> amount</span>
          <span style={s.legendItem}><span style={s.amber}>@cab</span> entity</span>
          <span style={s.legendItem}><span style={s.amber}>expense</span> direction</span>
          <span style={s.legendItem}><span style={s.amber}>Enter</span> log</span>
        </div>
      </div>
    </div>
  );
}

const AMBER = '#f5a623';
const BG = '#0a0a0a';
const SURFACE = '#111111';
const BORDER = '#2a2a2a';
const TEXT = '#f4f0e8';
const MUTED = '#666';

const s = {
  screen: {
    minHeight: '100dvh',
    background: BG,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px 16px',
    paddingTop: 'max(24px, env(safe-area-inset-top))',
    paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
  },
  card: {
    width: '100%',
    maxWidth: 440,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  eyebrow: {
    fontFamily: 'monospace',
    fontSize: 10,
    letterSpacing: '0.3em',
    color: AMBER,
    textAlign: 'center',
    userSelect: 'none',
  },
  input: {
    width: '100%',
    background: SURFACE,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    color: TEXT,
    fontFamily: 'monospace',
    fontSize: 20,
    lineHeight: 1.5,
    padding: '14px 16px',
    resize: 'none',
    outline: 'none',
    caretColor: AMBER,
    transition: 'border-color 0.15s',
  },
  row: {
    display: 'flex',
    gap: 10,
  },
  micBtn: {
    flexShrink: 0,
    width: 52,
    height: 52,
    background: SURFACE,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    fontSize: 20,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  micBtnActive: {
    borderColor: '#e53935',
    background: '#1f0d0d',
  },
  logBtn: {
    flex: 1,
    height: 52,
    background: AMBER,
    border: 'none',
    borderRadius: 8,
    color: BG,
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.2em',
    cursor: 'pointer',
  },
  logBtnDisabled: {
    background: '#3a3a3a',
    color: MUTED,
    cursor: 'default',
  },
  toast: {
    border: '1px solid',
    borderRadius: 6,
    color: TEXT,
    fontFamily: 'monospace',
    fontSize: 13,
    padding: '11px 14px',
    textAlign: 'center',
    lineHeight: 1.4,
  },
  legend: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px 18px',
    justifyContent: 'center',
  },
  legendItem: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: MUTED,
  },
  amber: {
    color: AMBER,
  },
};
