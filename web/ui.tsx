import { useId, useLayoutEffect, useRef } from 'react';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { Icon } from './icons.js';

const classes = (...values: (string | undefined | false)[]) => values.filter(Boolean).join(' ');
type ButtonProps = ComponentPropsWithRef<'button'> & { variant?: 'ghost' | 'primary' | 'outline'; density?: 'default' | 'compact'; loading?: boolean };
export function Button({ variant = 'ghost', density = 'default', loading = false, disabled, type = 'button', className, ...props }: ButtonProps) {
  return <button {...props} type={type} disabled={disabled || loading} aria-busy={loading || props['aria-busy']} className={classes('ui-button', `ui-button--${variant}`, density === 'compact' && 'ui-control--compact', className)} />;
}
export function IconButton({ label, shape = 'square', className, ...props }: Omit<ButtonProps, 'aria-label'> & { label: string; shape?: 'square' | 'round' }) {
  return <Button {...props} aria-label={label} className={classes('ui-icon-button', shape === 'round' && 'ui-icon-button--round', className)} />;
}
type FieldControl = { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true };
export function Field({ label, description, error, children, className, labelHidden = false }: {
  label: string; description?: string; error?: string; className?: string; labelHidden?: boolean;
  children: (props: FieldControl) => ReactNode;
}) {
  const id = useId(), describedBy = [description && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return <div className={classes('ui-field', labelHidden && 'ui-field--label-hidden', className)}><label htmlFor={id}>{label}</label>
    {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
    {description && <p className="ui-field-hint" id={`${id}-hint`}>{description}</p>}
    {error && <p className="ui-field-error" id={`${id}-error`} role="alert">{error}</p>}
  </div>;
}
export function Input({ className, ...props }: ComponentPropsWithRef<'input'>) { return <input {...props} className={classes('ui-input', className)} />; }
export function TextArea({ className, presentation = 'field', ...props }: ComponentPropsWithRef<'textarea'> & { presentation?: 'field' | 'plain' }) { return <textarea {...props} className={classes('ui-textarea', presentation === 'plain' && 'ui-textarea--plain', className)} />; }
export function Select({ className, compact = false, leadingIcon, ...props }: ComponentPropsWithRef<'select'> & { compact?: boolean; leadingIcon?: ReactNode }) {
  const control = <select {...props} className={classes('ui-select', compact && 'ui-select--inline ui-control--compact', !!leadingIcon && 'ui-select--has-icon', className)} />;
  return compact ? <span className="ui-select-shell">{leadingIcon && <span className="ui-select-icon" aria-hidden="true">{leadingIcon}</span>}{control}<span className="ui-select-chevron" aria-hidden="true">⌄</span></span> : control;
}

export function Dialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      dialog.close();
      // A replacement dialog gets first refusal; never focus behind an open modal.
      queueMicrotask(() => {
        if (document.querySelector('dialog[open]')) return;
        if (opener?.isConnected && !opener.closest('[inert]') && !opener.matches(':disabled')) opener.focus();
        else [...document.querySelectorAll<HTMLElement>('[data-focus-fallback]')].find(element => element.getClientRects().length > 0)?.focus();
      });
    };
  }, []);
  return <dialog ref={ref} className="ui-dialog dialog" aria-label={title}
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      // Edge may send Tab to browser chrome at the modal boundary. Keep the
      // established in-dialog cycle while native showModal owns background inertness.
      const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]')]
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <div className="panel-heading"><strong>{title}</strong><IconButton density="compact" label={`${title} 닫기`} onClick={close} autoFocus><Icon name="close" /></IconButton></div>
    {children}
  </dialog>;
}

export function MainPanel({ title, children, back }: { title: string; children: ReactNode; back?: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { heading.current?.focus(); }, []);
  return <section className="main-panel" aria-label={title}><header className="main-panel-heading"><h1 ref={heading} tabIndex={-1}>{title}</h1>{back && <Button onClick={back}>Chat으로 돌아가기</Button>}</header>{children}</section>;
}
