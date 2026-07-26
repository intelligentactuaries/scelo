import type { SocietyParams } from '../../shared/types';
import { EditableNumber, pctEdit } from './EditableNumber';

const INCOME_KEYS = ['low', 'lower-mid', 'mid', 'upper-mid', 'high'] as const;
const EDU_KEYS = ['primary', 'secondary', 'tertiary', 'postgrad'] as const;
const EMP_KEYS = ['employed', 'self-employed', 'informal', 'unemployed', 'student', 'retired'] as const;

type Props = {
  value: SocietyParams;
  onChange: (next: SocietyParams) => void;
  societySize: number;
  onSizeChange: (n: number) => void;
};

// ─── back-compat: the original combined panel ────────────────────────────
// Old callers (tests, debug pages) can keep dropping the full block in.
// New shell in App.tsx uses the per-section components below.
export function SocietyParamsPanel({ value, onChange, societySize, onSizeChange }: Props) {
  return (
    <section className="panel society-params">
      <div className="panel-label">society parameters</div>
      <SocietyParamsSliders
        value={value}
        onChange={onChange}
        societySize={societySize}
        onSizeChange={onSizeChange}
      />
      <IncomeMixSliders value={value} onChange={onChange} />
      <EducationMixSliders value={value} onChange={onChange} />
      <EmploymentMixSliders value={value} onChange={onChange} />
      <CultureInput value={value} onChange={onChange} />
      <div className="muted small">
        mixes auto-normalise on the server — values are relative weights, not percentages.
      </div>
    </section>
  );
}

// ─── per-section pieces, each safe to render inside an AccordionSection ──

export function SocietyParamsSliders({
  value,
  onChange,
  societySize,
  onSizeChange,
}: Props) {
  const set = <K extends keyof SocietyParams>(k: K, v: SocietyParams[K]) =>
    onChange({ ...value, [k]: v });
  return (
    <div className="sliders-block">
      <Slider
        label="size"
        value={societySize}
        min={50}
        max={1000}
        step={50}
        format={(v) => String(v)}
        onChange={onSizeChange}
      />
      <Slider
        label="age mean"
        value={value.ageMean}
        min={18}
        max={70}
        step={1}
        format={(v) => `${v}y`}
        onChange={(v) => set('ageMean', v)}
      />
      <Slider
        label="age spread"
        value={value.ageSpread}
        min={4}
        max={30}
        step={1}
        format={(v) => `±${v}y`}
        onChange={(v) => set('ageSpread', v)}
      />
      <Slider
        label="urban ratio"
        value={value.urbanRatio}
        min={0}
        max={1}
        step={0.05}
        format={fmtPct}
        {...pctEdit}
        onChange={(v) => set('urbanRatio', v)}
      />
      <Slider
        label="risk tolerance"
        value={value.riskTolerance}
        min={0}
        max={1}
        step={0.05}
        format={fmtPct}
        {...pctEdit}
        onChange={(v) => set('riskTolerance', v)}
      />
      <Slider
        label="financial literacy"
        value={value.financialLiteracy}
        min={0}
        max={1}
        step={0.05}
        format={fmtPct}
        {...pctEdit}
        onChange={(v) => set('financialLiteracy', v)}
      />
    </div>
  );
}

type MixProps = { value: SocietyParams; onChange: (next: SocietyParams) => void };

function setMix<
  K extends 'incomeMix' | 'educationMix' | 'employmentMix',
>(props: MixProps, key: K, bucket: string, n: number) {
  const next = { ...props.value[key], [bucket]: clamp(n, 0, 1) } as SocietyParams[K];
  props.onChange({ ...props.value, [key]: next });
}

export function IncomeMixSliders({ value, onChange }: MixProps) {
  return (
    <div className="mix-block">
      {INCOME_KEYS.map((k) => (
        <Slider
          key={k}
          label={k}
          value={value.incomeMix[k]}
          min={0}
          max={1}
          step={0.05}
          format={fmtPct}
          {...pctEdit}
          onChange={(v) => setMix({ value, onChange }, 'incomeMix', k, v)}
          dense
        />
      ))}
    </div>
  );
}

export function EducationMixSliders({ value, onChange }: MixProps) {
  return (
    <div className="mix-block">
      {EDU_KEYS.map((k) => (
        <Slider
          key={k}
          label={k}
          value={value.educationMix[k]}
          min={0}
          max={1}
          step={0.05}
          format={fmtPct}
          {...pctEdit}
          onChange={(v) => setMix({ value, onChange }, 'educationMix', k, v)}
          dense
        />
      ))}
    </div>
  );
}

export function EmploymentMixSliders({ value, onChange }: MixProps) {
  return (
    <div className="mix-block">
      {EMP_KEYS.map((k) => (
        <Slider
          key={k}
          label={k}
          value={value.employmentMix[k]}
          min={0}
          max={1}
          step={0.05}
          format={fmtPct}
          {...pctEdit}
          onChange={(v) => setMix({ value, onChange }, 'employmentMix', k, v)}
          dense
        />
      ))}
    </div>
  );
}

export function CultureInput({ value, onChange }: MixProps) {
  return (
    <label className="culture-row">
      <span className="muted small">culture</span>
      <input
        type="text"
        value={value.culture}
        onChange={(e) => onChange({ ...value, culture: e.target.value })}
        placeholder="South Africa"
      />
    </label>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  dense,
  toEdit,
  fromEdit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  dense?: boolean;
  toEdit?: (v: number) => string;
  fromEdit?: (s: string) => number;
}) {
  return (
    <div className={`slider-row ${dense ? 'dense' : ''}`}>
      <label className="slider-label">{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <EditableNumber
        className="num slider-readout"
        value={value}
        min={min}
        max={max}
        step={step}
        format={format}
        onChange={onChange}
        toEdit={toEdit}
        fromEdit={fromEdit}
        ariaLabel={`${label} value`}
      />
    </div>
  );
}

function fmtPct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
