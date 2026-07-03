import { useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ElicitationRequestMsg } from '@aasis21/helm-shared';

type FieldValue = string | number | boolean | string[];

interface Option {
  value: string;
  label: string;
}

type Field =
  | { name: string; title: string; description?: string; required: boolean; control: 'text'; format?: string; minLength?: number; maxLength?: number; default: string }
  | { name: string; title: string; description?: string; required: boolean; control: 'number'; integer: boolean; min?: number; max?: number; default: string }
  | { name: string; title: string; description?: string; required: boolean; control: 'boolean'; default: boolean }
  | { name: string; title: string; description?: string; required: boolean; control: 'select'; options: Option[]; default: string }
  | { name: string; title: string; description?: string; required: boolean; control: 'multiselect'; options: Option[]; minItems?: number; maxItems?: number; default: string[] };

interface ElicitationCardProps {
  req: ElicitationRequestMsg;
  error?: string;
  disabled?: boolean;
  onSubmit(content: Record<string, FieldValue>): void;
  onDecline(): void;
  onCancel(): void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function titleFor(name: string, schema: Record<string, unknown>): string {
  const t = schema.title;
  if (typeof t === 'string' && t.trim()) return t.trim();
  // Fall back to a humanized field name: snake/camel -> spaced, capitalized.
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** Extract {value,label} options from enum(+enumNames) or oneOf/anyOf [{const,title}]. */
function optionsFrom(schema: Record<string, unknown>): Option[] {
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? (schema.enumNames as unknown[]) : [];
    return (schema.enum as unknown[]).map((v, i) => ({
      value: String(v),
      label: typeof names[i] === 'string' ? (names[i] as string) : String(v),
    }));
  }
  const variants = (Array.isArray(schema.oneOf) && schema.oneOf) || (Array.isArray(schema.anyOf) && schema.anyOf) || null;
  if (variants) {
    return (variants as unknown[])
      .map((v) => asRecord(v))
      .filter((v) => v.const != null)
      .map((v) => ({ value: String(v.const), label: typeof v.title === 'string' ? v.title : String(v.const) }));
  }
  return [];
}

function parseField(name: string, raw: unknown, required: boolean): Field {
  const schema = asRecord(raw);
  const title = titleFor(name, schema);
  const description = typeof schema.description === 'string' ? schema.description : undefined;
  const base = { name, title, description, required };

  if (schema.type === 'boolean') {
    return { ...base, control: 'boolean', default: schema.default === true };
  }
  if (schema.type === 'array') {
    const items = asRecord(schema.items);
    const options = optionsFrom(items);
    const def = Array.isArray(schema.default) ? (schema.default as unknown[]).map(String) : [];
    return {
      ...base,
      control: 'multiselect',
      options,
      minItems: typeof schema.minItems === 'number' ? schema.minItems : undefined,
      maxItems: typeof schema.maxItems === 'number' ? schema.maxItems : undefined,
      default: def,
    };
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return {
      ...base,
      control: 'number',
      integer: schema.type === 'integer',
      min: typeof schema.minimum === 'number' ? schema.minimum : undefined,
      max: typeof schema.maximum === 'number' ? schema.maximum : undefined,
      default: schema.default != null ? String(schema.default) : '',
    };
  }
  // string (or unspecified): a select when enumerated, else free text.
  const options = optionsFrom(schema);
  if (options.length > 0) {
    return { ...base, control: 'select', options, default: schema.default != null ? String(schema.default) : '' };
  }
  return {
    ...base,
    control: 'text',
    format: typeof schema.format === 'string' ? schema.format : undefined,
    minLength: typeof schema.minLength === 'number' ? schema.minLength : undefined,
    maxLength: typeof schema.maxLength === 'number' ? schema.maxLength : undefined,
    default: typeof schema.default === 'string' ? schema.default : '',
  };
}

function useFields(req: ElicitationRequestMsg): Field[] {
  return useMemo(() => {
    const props = asRecord(req.requestedSchema?.properties);
    const required = new Set(req.requestedSchema?.required ?? []);
    return Object.keys(props).map((name) => parseField(name, props[name], required.has(name)));
  }, [req]);
}

function initialValues(fields: Field[]): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of fields) out[f.name] = f.control === 'boolean' || f.control === 'multiselect' ? f.default : f.default;
  return out;
}

/** A required field is "missing" until answered; a boolean is always answered (false is valid). */
function fieldMissing(f: Field, v: FieldValue | undefined): boolean {
  if (!f.required) return false;
  if (f.control === 'multiselect') return !Array.isArray(v) || v.length === 0;
  if (f.control === 'boolean') return false;
  return v == null || String(v).trim() === '';
}

/** Whether a field has been given a value at all (drives the "answered" dot in the stepper). */
function hasValue(f: Field, v: FieldValue | undefined): boolean {
  if (f.control === 'multiselect') return Array.isArray(v) && v.length > 0;
  if (f.control === 'boolean') return true;
  return v != null && String(v).trim() !== '';
}

const HTML_INPUT_TYPE: Record<string, string> = {
  email: 'email',
  uri: 'url',
  date: 'date',
  'date-time': 'datetime-local',
};

/**
 * Renders an `ask_user` elicitation as an answerable form: it maps the request's JSON Schema
 * to native inputs (enum -> select, boolean -> toggle, array -> multi-select, number -> number,
 * string -> text honoring `format`), validates required fields, and reports the answer as
 * accept (with content), decline, or cancel — mirroring the terminal's ask_user choices.
 */
export function ElicitationCard({ req, error, disabled = false, onSubmit, onDecline, onCancel }: ElicitationCardProps): JSX.Element {
  const fields = useFields(req);
  const [values, setValues] = useState<Record<string, FieldValue>>(() => initialValues(fields));
  const [touched, setTouched] = useState(false);
  const [step, setStep] = useState(0);
  const swipeStartX = useRef<number | null>(null);

  const setValue = (name: string, value: FieldValue): void =>
    setValues((prev) => ({ ...prev, [name]: value }));

  const missing = useMemo(
    () => fields.filter((f) => fieldMissing(f, values[f.name])).map((f) => f.name),
    [fields, values],
  );

  const isUrlMode = req.mode === 'url';
  // Present many questions as a horizontal one-at-a-time slider so the card stays compact
  // instead of growing into one tall scroll; a single question keeps the plain stacked form.
  const isWizard = !isUrlMode && fields.length > 1;
  const clampedStep = Math.min(step, Math.max(0, fields.length - 1));
  const atLast = clampedStep >= fields.length - 1;

  const goPrev = (): void => {
    setTouched(false);
    setStep((s) => Math.max(0, Math.min(s, fields.length - 1) - 1));
  };
  const goNext = (): void => {
    const f = fields[clampedStep];
    if (f && fieldMissing(f, values[f.name])) {
      setTouched(true); // block advancing past an unanswered required question
      return;
    }
    setTouched(false);
    setStep(() => Math.min(clampedStep + 1, fields.length - 1));
  };
  const goTo = (i: number): void => {
    setTouched(false);
    setStep(Math.max(0, Math.min(i, fields.length - 1)));
  };

  const onTouchStart = (e: React.TouchEvent): void => {
    swipeStartX.current = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: React.TouchEvent): void => {
    const start = swipeStartX.current;
    swipeStartX.current = null;
    if (start == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? start) - start;
    if (Math.abs(dx) < 45) return;
    if (dx < 0) goNext();
    else goPrev();
  };

  const submit = (): void => {
    if (missing.length > 0) {
      setTouched(true);
      if (isWizard) goTo(fields.findIndex((f) => missing.includes(f.name))); // jump to the gap
      return;
    }
    const content: Record<string, FieldValue> = {};
    for (const f of fields) {
      const v = values[f.name];
      if (f.control === 'number') {
        if (String(v).trim() === '') continue;
        const num = f.integer ? Number.parseInt(String(v), 10) : Number(v);
        if (Number.isFinite(num)) content[f.name] = num;
      } else if (f.control === 'boolean') {
        content[f.name] = Boolean(v);
      } else if (f.control === 'multiselect') {
        content[f.name] = Array.isArray(v) ? v : [];
      } else {
        if (String(v).trim() === '' && !f.required) continue;
        content[f.name] = String(v);
      }
    }
    onSubmit(content);
  };

  const renderField = (f: Field): JSX.Element => {
    const showError = touched && f.required && missing.includes(f.name);
    const fieldId = `elicit-${req.requestId}-${f.name}`;
    return (
      <div className={`elicit-field${showError ? ' invalid' : ''}`}>
        <label className="elicit-label" htmlFor={fieldId}>
          {f.title}
          {f.required ? <span className="elicit-req" aria-hidden="true"> *</span> : null}
        </label>
        {f.description ? <p className="elicit-desc">{f.description}</p> : null}

        {f.control === 'text' ? (
          <input
            id={fieldId}
            className="elicit-input"
            type={f.format ? HTML_INPUT_TYPE[f.format] ?? 'text' : 'text'}
            value={String(values[f.name] ?? '')}
            maxLength={f.maxLength}
            minLength={f.minLength}
            onChange={(e) => setValue(f.name, e.target.value)}
          />
        ) : null}

        {f.control === 'number' ? (
          <input
            id={fieldId}
            className="elicit-input"
            type="number"
            inputMode={f.integer ? 'numeric' : 'decimal'}
            value={String(values[f.name] ?? '')}
            min={f.min}
            max={f.max}
            step={f.integer ? 1 : 'any'}
            onChange={(e) => setValue(f.name, e.target.value)}
          />
        ) : null}

        {f.control === 'boolean' ? (
          <label className="elicit-toggle">
            <input
              id={fieldId}
              type="checkbox"
              checked={Boolean(values[f.name])}
              onChange={(e) => setValue(f.name, e.target.checked)}
            />
            <span>{Boolean(values[f.name]) ? 'Yes' : 'No'}</span>
          </label>
        ) : null}

        {f.control === 'select' ? (
          <select
            id={fieldId}
            className="elicit-input"
            value={String(values[f.name] ?? '')}
            onChange={(e) => setValue(f.name, e.target.value)}
          >
            <option value="" disabled={f.required}>
              {f.required ? 'Select…' : '— none —'}
            </option>
            {f.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : null}

        {f.control === 'multiselect' ? (
          <div className="elicit-checks" role="group" aria-labelledby={fieldId}>
            {f.options.map((opt) => {
              const selected = Array.isArray(values[f.name]) && (values[f.name] as string[]).includes(opt.value);
              return (
                <label key={opt.value} className={`elicit-check${selected ? ' on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(e) => {
                      const cur = Array.isArray(values[f.name]) ? (values[f.name] as string[]) : [];
                      setValue(
                        f.name,
                        e.target.checked ? [...cur, opt.value] : cur.filter((v) => v !== opt.value),
                      );
                    }}
                  />
                  <span>{opt.label}</span>
                </label>
              );
            })}
          </div>
        ) : null}

        {showError ? <p className="elicit-field-error" role="alert">Please answer this question.</p> : null}
      </div>
    );
  };

  return (
    <div className="elicit-card" role="group" aria-label={`Copilot asks: ${req.message}`}>
      <div className="elicit-head">
        <span className="elicit-icon" aria-hidden="true">?</span>
        <p className="elicit-message">{req.message || 'Copilot needs your input.'}</p>
      </div>

      {isUrlMode ? (
        <p className="elicit-url-note">
          This step opens a page on your computer{req.url ? ':' : '.'}
          {req.url ? <code className="elicit-url">{req.url}</code> : null}
        </p>
      ) : isWizard ? (
        <div className="elicit-wizard">
          <div className="elicit-progress">
            <span className="elicit-step-count">
              Question {clampedStep + 1} of {fields.length}
            </span>
            <div className="elicit-dots" role="tablist" aria-label="Questions">
              {fields.map((f, i) => (
                <button
                  key={f.name}
                  type="button"
                  role="tab"
                  aria-selected={i === clampedStep}
                  aria-label={`Question ${i + 1}: ${f.title}`}
                  className={`elicit-dot${i === clampedStep ? ' on' : ''}${
                    hasValue(f, values[f.name]) ? ' done' : ''
                  }${touched && missing.includes(f.name) ? ' bad' : ''}`}
                  onClick={() => goTo(i)}
                />
              ))}
            </div>
          </div>

          <div className="elicit-viewport" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
            <div className="elicit-track" style={{ transform: `translateX(-${clampedStep * 100}%)` }}>
              {fields.map((f) => (
                <div key={f.name} className="elicit-slide" aria-hidden={fields[clampedStep]?.name !== f.name}>
                  {renderField(f)}
                </div>
              ))}
            </div>
          </div>

          <div className="elicit-nav">
            <button
              type="button"
              className="elicit-nav-btn"
              onClick={goPrev}
              disabled={clampedStep === 0}
            >
              ← Back
            </button>
            {atLast ? (
              <button type="button" className="elicit-btn submit" onClick={submit} disabled={disabled}>
                <span className="elicit-btn-icon" aria-hidden="true">✓</span>
                Submit
              </button>
            ) : (
              <button type="button" className="elicit-nav-btn next" onClick={goNext}>
                Next →
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="elicit-fields">{fields.map((f) => <div key={f.name}>{renderField(f)}</div>)}</div>
      )}

      {error ? (
        <p className="elicit-error" role="alert">
          ⚠ {error}
        </p>
      ) : null}

      <div className="elicit-actions">
        {!isUrlMode && !isWizard ? (
          <button type="button" className="elicit-btn submit" onClick={submit} disabled={disabled}>
            <span className="elicit-btn-icon" aria-hidden="true">✓</span>
            Submit
          </button>
        ) : null}
        <button type="button" className="elicit-btn decline" onClick={onDecline} disabled={disabled}>
          Decline
        </button>
        <button type="button" className="elicit-btn cancel" onClick={onCancel} disabled={disabled}>
          Cancel
        </button>
      </div>
    </div>
  );
}
