import FormattingTools from './FormattingTools';
import MediaTools from './MediaTools';
import { useAuth } from '../context/useAuth';
import { usePrefs } from '../context/usePrefs';
import { joinSounds, splitSounds } from '../utils/soundTags';

interface Props {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onBusyChange?: (busy: boolean) => void;
}

/** A note field: plain text in the box, its [sound:...] tags as playable chips, and the compact toolbar. */
export default function NoteFieldEditor({ id, label, value, disabled, onChange, onBusyChange }: Props) {
  const { t } = usePrefs();
  const { user } = useAuth();
  const { text, sounds } = splitSounds(value);
  const setText = (next: string) => onChange(joinSounds(next, sounds));
  const play = (name: string) => {
    if (!user) return;
    void new Audio(`/api/media/${user.id}/${encodeURIComponent(name)}`).play().catch(() => undefined);
  };
  return (
    <div className="form-group note-field-editor">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} className="editor-textarea" rows={4} value={text} disabled={disabled}
        onChange={e => setText(e.target.value)} />
      {sounds.length > 0 && (
        <ul className="sound-chips" aria-label={t('field.sounds')}>
          {sounds.map((name, index) => (
            <li key={`${name}-${index}`} className="sound-chip">
              <button type="button" onClick={() => play(name)} title={name} aria-label={t('field.playSound', { name })}>
                🔊 <span>{name.startsWith('tts-') ? t('field.pronunciation') : name}</span>
              </button>
              <button type="button" disabled={disabled} aria-label={t('field.removeSound', { name })} title={t('field.removeSound', { name })}
                onClick={() => onChange(joinSounds(text, sounds.filter((_, i) => i !== index)))}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <div className="field-tools">
        <FormattingTools targetId={id} disabled={disabled} onChange={setText} />
        <MediaTools disabled={disabled} onBusyChange={onBusyChange} onInsert={markup => onChange(value + markup)} />
      </div>
    </div>
  );
}
