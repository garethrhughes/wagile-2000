'use client'

interface ToggleChipProps {
  label: string
  selected: boolean
  disabled?: boolean
  onClick: () => void
}

export function ToggleChip({ label, selected, disabled = false, onClick }: ToggleChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
        disabled
          ? 'cursor-not-allowed border-border text-muted opacity-50'
          : selected
            ? 'border-interactive-selected-border bg-interactive-selected-bg text-interactive-selected-fg'
            : 'border-border text-muted hover:bg-interactive-hover-bg'
      }`}
    >
      {label}
    </button>
  )
}
