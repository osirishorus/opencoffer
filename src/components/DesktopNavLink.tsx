"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  SETTINGS_NAV,
  WORKSPACE_NAV,
  isActive,
  type NavItem,
} from "@/components/nav-config";

/**
 * Renders the desktop rail's nav lists.
 *
 * This lives on the client and reads nav-config itself on purpose. `nav-config`
 * is a shared module, so its `Icon` entries are real component functions when a
 * server component imports it — mapping over them in AppShell and spreading
 * `{...item}` into a client component pushed those functions across the RSC
 * boundary, which React refuses to serialize ("Functions cannot be passed
 * directly to Client Components"). Keeping the iteration on this side of the
 * boundary means only the rendered output crosses it.
 */
export function DesktopNav() {
  return (
    <>
      <nav className="mt-8 flex flex-col gap-2">
        <div className="eyebrow px-3 pb-1">Workspace</div>
        {WORKSPACE_NAV.map((n) => (
          <DesktopNavLink key={n.href} {...n} />
        ))}
      </nav>

      <nav className="mt-auto flex flex-col gap-2">
        <div className="eyebrow px-3 pb-1">Settings</div>
        {SETTINGS_NAV.map((n) => (
          <DesktopNavLink key={n.href} {...n} />
        ))}
      </nav>
    </>
  );
}

export function DesktopNavLink({ href, label, Icon }: NavItem) {
  const path = usePathname();
  const active = isActive(path, href);

  return (
    <Link
      href={href}
      prefetch
      className={cn(
        "flex h-11 items-center gap-3 rounded-2xl px-3 text-on-surface-variant transition-colors hover:bg-on-surface/[0.06] hover:text-on-surface",
        active && "bg-primary-container text-on-primary-container hover:bg-primary-container hover:text-on-primary-container",
      )}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
    >
      <Icon size={20} strokeWidth={active ? 2.1 : 1.9} />
      <span className="body-m text-inherit">{label}</span>
    </Link>
  );
}
