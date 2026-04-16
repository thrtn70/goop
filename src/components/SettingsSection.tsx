import type { ReactNode } from "react";

interface SettingsSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export default function SettingsSection({
  title,
  description,
  children,
}: SettingsSectionProps) {
  return (
    <section className="rounded-lg border border-subtle bg-surface-1 p-5">
      <header className="mb-4">
        <h3 className="font-display text-sm font-semibold text-fg">{title}</h3>
        {description && <p className="mt-1 text-xs text-fg-muted">{description}</p>}
      </header>
      <div className="space-y-5">{children}</div>
    </section>
  );
}
