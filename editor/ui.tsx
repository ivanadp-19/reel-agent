import React from 'react';

// Small atoms the Inspector tabs share (Obsidian Edit tokens, see tailwind.config.js).

export const Row: React.FC<{k: string; v: string}> = ({k, v}) => (
  <div className="flex justify-between py-1 text-body-sm border-b border-outline-variant/15">
    <span className="text-on-surface-variant">{k}</span>
    <span className="text-on-surface font-mono">{v}</span>
  </div>
);

export const IconBtn: React.FC<{icon: string; title: string; onClick: () => void; danger?: boolean; disabled?: boolean}> = ({icon, title, onClick, danger, disabled}) => (
  <button
    title={title}
    onClick={onClick}
    disabled={disabled}
    className={`material-symbols-outlined text-[18px] disabled:opacity-30 ${danger ? 'text-on-surface-variant hover:text-error' : 'text-on-surface-variant hover:text-on-surface'}`}
  >
    {icon}
  </button>
);

export const Section: React.FC<{title: string; children: React.ReactNode; hint?: string}> = ({title, children, hint}) => (
  <div className="pt-4 first:pt-0 border-t first:border-t-0 border-outline-variant/30">
    <label className="text-label-bold font-label-bold uppercase text-on-surface-variant">{title}</label>
    {hint && <p className="text-[11px] text-on-surface-variant/60 mt-1">{hint}</p>}
    <div className="mt-2 space-y-2">{children}</div>
  </div>
);

export const Label: React.FC<{children: React.ReactNode}> = ({children}) => <label className="text-[11px] text-on-surface-variant block">{children}</label>;

export const Select: React.FC<{value: string; onChange: (v: string) => void; options: {value: string; label?: string; title?: string}[]; title?: string; className?: string}> = ({value, onChange, options, title, className = ''}) => (
  <select
    value={value}
    title={title}
    onChange={(e) => onChange(e.target.value)}
    className={`w-full bg-surface-container-lowest text-on-surface border border-outline-variant/40 focus:border-primary focus:outline-none rounded px-2 py-1 text-[12px] ${className}`}
  >
    {options.map((o) => (
      <option key={o.value} value={o.value} title={o.title}>{o.label ?? o.value}</option>
    ))}
  </select>
);

export const TextInput: React.FC<{value: string; onChange: (v: string) => void; placeholder?: string; maxLength?: number; className?: string; type?: string; min?: number; max?: number; step?: number; title?: string}> = ({className = '', ...rest}) => (
  <input
    {...rest}
    onChange={(e) => rest.onChange(e.target.value)}
    className={`w-full bg-surface-container-lowest text-on-surface border border-outline-variant/40 focus:border-primary focus:outline-none rounded px-2 py-1 text-[12px] ${className}`}
  />
);

export const NumberInput: React.FC<{value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; title?: string; className?: string}> = ({value, onChange, className = '', ...rest}) => (
  <input
    type="number"
    value={Number.isFinite(value) ? value : ''}
    onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(n); }}
    className={`w-full bg-surface-container-lowest text-on-surface border border-outline-variant/40 focus:border-primary focus:outline-none rounded px-2 py-1 text-[12px] font-mono ${className}`}
    {...rest}
  />
);

export const Toggle: React.FC<{on: boolean; onChange: (on: boolean) => void; title?: string}> = ({on, onChange, title}) => (
  <button
    onClick={() => onChange(!on)}
    title={title}
    className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${on ? 'bg-primary-container' : 'bg-surface-container-lowest border border-outline-variant/50'}`}
  >
    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
  </button>
);

export const Btn: React.FC<{onClick: () => void; children: React.ReactNode; primary?: boolean; disabled?: boolean; title?: string; className?: string}> = ({onClick, children, primary, disabled, title, className = ''}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={`px-3 py-1.5 rounded-lg text-[12px] font-bold transition-all disabled:opacity-40 flex items-center justify-center gap-1.5 ${
      primary ? 'bg-primary-container text-on-primary-container hover:brightness-110' : 'border border-outline-variant text-on-surface-variant hover:bg-surface-variant'
    } ${className}`}
  >
    {children}
  </button>
);

export const fmtSec = (ms: number) => (ms / 1000).toFixed(2) + 's';
