import { AlertOctagon, AlertTriangle, Info, ShieldCheck } from 'lucide-react';
import type { RiskCategory } from '../types/roadshadow';

const RISK_META: Record<
  RiskCategory,
  { colorClass: string; Icon: typeof AlertOctagon; label: string }
> = {
  Critical: {
    colorClass: 'text-[#E5484D]',
    Icon: AlertOctagon,
    label: 'Critical risk',
  },
  High: {
    colorClass: 'text-[#F97316]',
    Icon: AlertTriangle,
    label: 'High risk',
  },
  Medium: {
    colorClass: 'text-[#EAB308]',
    Icon: Info,
    label: 'Medium risk',
  },
  Low: {
    colorClass: 'text-[#22C55E]',
    Icon: ShieldCheck,
    label: 'Low risk',
  },
};

export function RiskIndicator({
  category,
  score,
  compact = false,
}: {
  category: RiskCategory;
  score?: number;
  compact?: boolean;
}) {
  const { colorClass, Icon, label } = RISK_META[category];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${colorClass}`}
      aria-label={score !== undefined ? `${label}, provisional score ${score} of 100` : label}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span>{compact ? category : label}</span>
      {score !== undefined && (
        <span className="font-mono tabular-nums text-[#A9B8CA]">· {score}/100</span>
      )}
    </span>
  );
}

export function getRiskColorHex(category: RiskCategory): string {
  switch (category) {
    case 'Critical':
      return '#E5484D';
    case 'High':
      return '#F97316';
    case 'Medium':
      return '#EAB308';
    case 'Low':
      return '#22C55E';
  }
}
