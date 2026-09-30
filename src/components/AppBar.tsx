import type { ReactNode } from "react";
import { ThemeToggle } from "./ThemeToggle";
import { DrawerTrigger } from "./MobileNav";

/** M3-style top app bar. On mobile it also hosts the drawer hamburger so the
 *  page doesn't need a second header above it. */
export function AppBar({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-outline-variant bg-surface/76 px-2 backdrop-blur-xl md:h-16 md:gap-4 md:px-8">
      <DrawerTrigger />
      <div className="min-w-0 flex-1">
        <div className="title-l coffer-serif truncate text-on-surface">{title}</div>
        {subtitle && (
          <div className="body-s -mt-0.5 hidden truncate text-on-surface-variant sm:block">
            {subtitle}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pr-2 md:gap-2 md:pr-0">
        {actions}
        <ThemeToggle />
      </div>
    </header>
  );
}

export function PageHeader({
  overline,
  title,
  description,
  actions,
}: {
  overline?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
      <div>
        {overline && <div className="eyebrow mfade mfade-1">{overline}</div>}
        <h1 className="coffer-serif mfade mfade-2 mt-2 text-4xl leading-tight text-on-surface md:text-5xl">{title}</h1>
        {description && (
          <p className="body-l mfade mfade-3 mt-3 max-w-2xl text-on-surface-variant">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="mfade mfade-3 flex items-start gap-2">{actions}</div>}
    </div>
  );
}
