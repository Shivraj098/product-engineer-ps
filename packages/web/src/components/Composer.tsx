import { useState, type FormEvent } from 'react';

const MAX_LENGTH = 2000;
const WARN_AT = MAX_LENGTH - 200;

export interface ComposerProps {
  disabled: boolean;
  onSend: (content: string) => void;
  error: string | undefined;
  /** Lets "example prompt" buttons elsewhere fill the box without lifting state up further. */
  value: string;
  onChange: (value: string) => void;
}

export function Composer({ disabled, onSend, error, value, onChange }: ComposerProps) {
  const [touched, setTouched] = useState(false);
  const trimmed = value.trim();
  const invalid = touched && trimmed.length === 0;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (disabled || trimmed.length === 0 || trimmed.length > MAX_LENGTH) {
      return;
    }
    onSend(trimmed);
    onChange('');
    setTouched(false);
  };

  return (
    <form className="composer" onSubmit={submit}>
      <label htmlFor="composer-input" className="visually-hidden">
        Message
      </label>
      <textarea
        id="composer-input"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            submit(event);
          }
        }}
        onBlur={() => setTouched(true)}
        placeholder={disabled ? 'Waiting for the current reply to finish…' : 'Send a message…'}
        rows={2}
        aria-invalid={invalid}
        aria-describedby={error ? 'composer-error' : undefined}
      />
      <div className="composer__row">
        {value.length > WARN_AT && (
          <span className="composer__counter">
            {value.length} / {MAX_LENGTH}
          </span>
        )}
        <button type="submit" disabled={disabled || trimmed.length === 0}>
          Send
        </button>
      </div>
      {invalid && <p className="composer__error">Type a message first.</p>}
      {error && (
        <p id="composer-error" className="composer__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
