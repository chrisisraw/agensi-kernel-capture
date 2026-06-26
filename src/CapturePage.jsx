import { useState, useRef, useEffect, useCallback } from 'react';

const FN_URL = import.meta.env.VITE_LEDGER_FN_URL;
const CAP_KEY = import.meta.env.VITE_CAPTURE_KEY;

// ── shared fetch helper ────────────────────────────────────────────────────────

function apiFetch(path, opts = {}) {
  return fetch(`${FN_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-capture-key': CAP_KEY, ...opts.headers },
  });
}

async function safeJson(res) {
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

// ── formatters ────────────────────────────────────────────────────────────────

function fmtAmt(cents) {
  return cents != null ? `$${Math.round(cents / 100)}` : '(no $)';
}

function fmtToast(row) {
  const dir = row.direction === 'expense' ? 'exp' : 'inc';
  return `✓ ${fmtAmt(row.actual_cents)} · ${dir}/${row.stream ?? 'pedicab'} → ${row.ts}`;
}

// ── webkitSpeechRecognition (progressive enhancement only) ────────────────────

function useSpeech(onResult) {
  const recRef = useRef(null);
  const [listening, setListening] = useState(false);
  const supported = typeof window !== 'undefined' && 'webkitSpeechRecognition' in window;

  function toggle() {
    if (!supported) return;
    if (listening) { recRef.current?.stop(); return; }
    const R = new window.webkitSpeechRecognition();
    R.lang = 'en-US';
    R.interimResults = false;
    R.maxAlternatives = 1;
    R.onresult = (e) => onResult(e.results[0][0].transcript);
    R.onend = () => setListening(false);
    R.onerror = () => setListening(false);
    recRef.current = R;
    R.start();
    setListening(true);
  }

  return { supported, listening, toggle };
}

// ── main component ────────────────────────────────────────────────────────────

export default function CapturePage() {
  const [text, setText] = useState('');
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const toastTimer = useRef(null);

  // Disambiguation: set when server returns needsChoice:true
  const [pendingChoice, setPendingChoice] = useState(null); // { venture, text, raw } | null

  // Recent rows + inline editor state
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null);
  const [editDraft, setEditDraft] = useState({});
  const [saving, setSaving] = useState(false);

  const { supported: speechSupported, listening, toggle: toggleSpeech } = useSpeech((t) =>
    setText((prev) => (prev ? `${prev} ${t}` : t))
  );

  // ── recent rows ─────────────────────────────────────────────────────────────

  const loadRecent = useCallback(async () => {
    try {
      const res = await apiFetch('?action=recent');
      if (res.ok) setRows(await res.json());
    } catch (_) { /* non-fatal — list stays stale */ }
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
    loadRecent();
  }, [loadRecent]);

  // ── toast helper ─────────────────────────────────────────────────────────────

  function showToast(msg, ok) {
    clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }

  // ── LOG submit ───────────────────────────────────────────────────────────────

  async function submit() {
    const raw = text.trim();
    if (!raw || busy) return;
    setBusy(true);
    try {
      const res = await apiFetch('', { method: 'POST', body: JSON.stringify({ raw }) });
      const data = await safeJson(res);

      if (data.needsChoice) {
        setPendingChoice({ venture: data.venture, text: data.text, raw });
        setText('');
        return;
      }

      if (data.action === 'move') {
        showToast(`✓ logged to ${data.venture} moves → ${data.text}`, true);
        setText('');
        return;
      }

      if (data.action === 'life') {
        showToast(`✓ ${data.area}${data.value ? ` · ${data.value}` : ''} → life log`, true);
        setText('');
        return;
      }

      showToast(fmtToast(data), true);
      setText('');
      loadRecent();
    } catch (err) {
      showToast(`✗ ${err.message}`, false);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  // ── disambiguation choice ─────────────────────────────────────────────────

  async function chooseRoute(type) {
    if (!pendingChoice || busy) return;
    setBusy(true);
    try {
      let res, data;
      if (type === 'money') {
        res = await apiFetch('', {
          method: 'POST',
          body: JSON.stringify({ action: 'ledger', raw: pendingChoice.raw }),
        });
      } else {
        res = await apiFetch('', {
          method: 'POST',
          body: JSON.stringify({ action: 'move', venture: pendingChoice.venture, text: pendingChoice.text }),
        });
      }
      data = await safeJson(res);

      if (type === 'money') {
        showToast(fmtToast(data), true);
        loadRecent();
      } else {
        showToast(`✓ logged to ${data.venture} moves → ${data.text}`, true);
      }
      setPendingChoice(null);
    } catch (err) {
      showToast(`✗ ${err.message}`, false);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  }

  // ── inline editor ────────────────────────────────────────────────────────────

  function openEdit(row) {
    setEditing(row.id);
    setEditDraft({
      dollars: row.actual_cents != null ? String(Math.round(row.actual_cents / 100)) : '',
      direction: row.direction ?? 'income',
      stream: row.stream ?? '',
      entity_id: row.entity_id ?? 'cab',
      item: row.item ?? '',
    });
  }

  function closeEdit() {
    setEditing(null);
    setEditDraft({});
  }

  async function saveEdit(id) {
    if (saving) return;
    setSaving(true);

    const cents = editDraft.dollars !== '' ? Math.round(parseFloat(editDraft.dollars) * 100) : null;
    const fields = {
      actual_cents: cents,
      direction: editDraft.direction,
      stream: editDraft.stream || null,
      entity_id: editDraft.entity_id || 'cab',
      item: editDraft.item || 'capture',
    };

    // optimistic update
    const snapshot = rows;
    setRows((rs) => rs.map((r) => r.id === id ? { ...r, ...fields } : r));

    try {
      const res = await apiFetch('', {
        method: 'POST',
        body: JSON.stringify({ action: 'correct', id, fields }),
      });
      const data = await safeJson(res);
      setRows((rs) => rs.map((r) => r.id === id ? data : r));
      closeEdit();
      showToast('✓ corrected', true);
    } catch (err) {
      setRows(snapshot);
      showToast(`✗ ${err.message}`, false);
    } finally {
      setSaving(false);
    }
  }

  const canSubmit = text.trim().length > 0 && !busy && !pendingChoice;
  const visible = rows.slice(0, 5);

  return (
    <div style={s.screen}>
      <div style={s.card}>
        {/* ── label ── */}
        <div style={s.eyebrow}>LOG IT</div>

        {/* ── input — textarea so iOS dictation mic works on the field ── */}
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={'$30 two fares downtown @cab\nwrote 800 words · surfed dawn patrol\nslept 7h · called mom'}
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

        {/* ── disambiguation choice ── */}
        {pendingChoice && (
          <div style={s.choiceWrap}>
            <div style={s.choiceLabel}>
              → <span style={s.amber}>{pendingChoice.venture}</span> · money or move?
            </div>
            <div style={s.row}>
              <button
                type="button"
                onClick={() => chooseRoute('money')}
                disabled={busy}
                style={s.choiceBtn}
              >
                MONEY
              </button>
              <button
                type="button"
                onClick={() => chooseRoute('move')}
                disabled={busy}
                style={{ ...s.choiceBtn, ...s.choiceBtnMove }}
              >
                MOVE
              </button>
            </div>
          </div>
        )}

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
          <span style={s.legendItem}><span style={s.amber}>$NN</span> money</span>
          <span style={s.legendItem}><span style={s.amber}>@cab</span> entity</span>
          <span style={s.legendItem}><span style={s.amber}>wrote/surf/slept</span> life</span>
          <span style={s.legendItem}><span style={s.amber}>Enter</span> log</span>
        </div>

        {/* ── recent rows + inline editor ── */}
        {visible.length > 0 && (
          <div style={s.recentWrap}>
            <div style={s.recentLabel}>RECENT</div>

            {visible.map((row) =>
              editing === row.id ? (
                /* ── expanded inline editor ── */
                <div key={row.id} style={s.editPanel}>
                  {/* amount + direction on one line */}
                  <div style={s.editRow}>
                    <span style={s.editPrefix}>$</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={editDraft.dollars}
                      onChange={(e) => setEditDraft((d) => ({ ...d, dollars: e.target.value }))}
                      style={{ ...s.editInput, width: 72 }}
                      placeholder="0"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setEditDraft((d) => ({
                          ...d,
                          direction: d.direction === 'income' ? 'expense' : 'income',
                        }))
                      }
                      style={{
                        ...s.dirToggle,
                        color: editDraft.direction === 'expense' ? '#e57373' : AMBER,
                        borderColor: editDraft.direction === 'expense' ? '#e57373' : AMBER,
                      }}
                    >
                      {editDraft.direction === 'expense' ? 'exp' : 'inc'}
                    </button>
                  </div>

                  {/* stream + entity on one line */}
                  <div style={s.editRow}>
                    <input
                      value={editDraft.stream}
                      onChange={(e) => setEditDraft((d) => ({ ...d, stream: e.target.value }))}
                      style={{ ...s.editInput, flex: 1 }}
                      placeholder="stream"
                      autoCapitalize="none"
                    />
                    <input
                      value={editDraft.entity_id}
                      onChange={(e) => setEditDraft((d) => ({ ...d, entity_id: e.target.value }))}
                      style={{ ...s.editInput, width: 80 }}
                      placeholder="entity"
                      autoCapitalize="none"
                    />
                  </div>

                  {/* item — full width */}
                  <input
                    value={editDraft.item}
                    onChange={(e) => setEditDraft((d) => ({ ...d, item: e.target.value }))}
                    style={{ ...s.editInput, width: '100%' }}
                    placeholder="item"
                  />

                  {/* save / cancel */}
                  <div style={s.editActions}>
                    <button
                      type="button"
                      onClick={() => saveEdit(row.id)}
                      disabled={saving}
                      style={s.saveBtn}
                    >
                      {saving ? '…' : 'SAVE'}
                    </button>
                    <button type="button" onClick={closeEdit} style={s.cancelBtn}>
                      cancel
                    </button>
                  </div>
                </div>
              ) : (
                /* ── compact row — tap to edit ── */
                <button
                  key={row.id}
                  type="button"
                  onClick={() => openEdit(row)}
                  style={s.recentRow}
                >
                  <span style={{ ...s.recentAmt, color: row.direction === 'expense' ? '#e57373' : AMBER }}>
                    {row.direction === 'expense' ? `-${fmtAmt(row.actual_cents)}` : fmtAmt(row.actual_cents)}
                  </span>
                  <span style={s.recentMeta}>
                    {' '}· {row.direction === 'expense' ? 'exp' : 'inc'}/{row.stream ?? '?'}
                  </span>
                  <span style={s.recentItem}> · {row.item}</span>
                </button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── design tokens ─────────────────────────────────────────────────────────────

const AMBER = '#f5a623';
const BG = '#0a0a0a';
const SURFACE = '#111111';
const BORDER = '#2a2a2a';
const TEXT = '#f4f0e8';
const MUTED = '#666';

// ── styles ────────────────────────────────────────────────────────────────────

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
  row: { display: 'flex', gap: 10 },
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
  micBtnActive: { borderColor: '#e53935', background: '#1f0d0d' },
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
  logBtnDisabled: { background: '#3a3a3a', color: MUTED, cursor: 'default' },
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
  legendItem: { fontFamily: 'monospace', fontSize: 10, color: MUTED },
  amber: { color: AMBER },

  // ── recent strip ──
  recentWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    borderTop: `1px solid ${BORDER}`,
    paddingTop: 10,
  },
  recentLabel: {
    fontFamily: 'monospace',
    fontSize: 9,
    letterSpacing: '0.28em',
    color: MUTED,
    marginBottom: 4,
  },
  recentRow: {
    width: '100%',
    background: 'transparent',
    border: `1px solid transparent`,
    borderRadius: 5,
    padding: '7px 8px',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 1.3,
    color: TEXT,
    display: 'block',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  recentAmt: { color: AMBER, fontWeight: 700 },
  recentMeta: { color: MUTED },
  recentItem: { color: TEXT },

  // ── disambiguation choice ──
  choiceWrap: {
    background: '#161616',
    border: `1px solid ${AMBER}44`,
    borderRadius: 6,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  choiceLabel: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: TEXT,
    lineHeight: 1.4,
  },
  choiceBtn: {
    flex: 1,
    height: 44,
    background: SURFACE,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    color: TEXT,
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.15em',
    cursor: 'pointer',
  },
  choiceBtnMove: {
    borderColor: AMBER,
    color: AMBER,
  },

  // ── inline editor ──
  editPanel: {
    background: '#161616',
    border: `1px solid ${AMBER}44`,
    borderRadius: 6,
    padding: '10px 10px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
  },
  editRow: { display: 'flex', alignItems: 'center', gap: 6 },
  editPrefix: { fontFamily: 'monospace', fontSize: 14, color: MUTED, flexShrink: 0 },
  editInput: {
    background: '#1e1e1e',
    border: `1px solid ${BORDER}`,
    borderRadius: 4,
    color: TEXT,
    fontFamily: 'monospace',
    fontSize: 13,
    padding: '5px 8px',
    outline: 'none',
    minWidth: 0,
    boxSizing: 'border-box',
  },
  dirToggle: {
    background: 'transparent',
    border: `1px solid ${AMBER}`,
    borderRadius: 4,
    color: AMBER,
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.06em',
    padding: '5px 9px',
    cursor: 'pointer',
    flexShrink: 0,
  },
  editActions: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 },
  saveBtn: {
    background: AMBER,
    border: 'none',
    borderRadius: 4,
    color: BG,
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.15em',
    padding: '6px 14px',
    cursor: 'pointer',
  },
  cancelBtn: {
    background: 'transparent',
    border: 'none',
    color: MUTED,
    fontFamily: 'monospace',
    fontSize: 11,
    cursor: 'pointer',
    padding: '6px 4px',
  },
};
