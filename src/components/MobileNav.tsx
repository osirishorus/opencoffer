"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, LogOut } from "lucide-react";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";
import {
  WORKSPACE_NAV,
  SETTINGS_NAV,
  BOTTOM_NAV,
  isActive,
  type NavItem,
} from "@/components/nav-config";
import { useDrawer } from "@/components/DrawerContext";

/** Hamburger trigger — rendered inside AppBar on mobile. */
export function DrawerTrigger() {
  const { setOpen } = useDrawer();
  return (
    <button
      onClick={() => setOpen(true)}
      className="btn-icon md:hidden"
      aria-label="Open menu"
    >
      <Menu size={22} strokeWidth={1.75} />
    </button>
  );
}

/** Slide-in drawer + fixed bottom nav. No standalone top bar — the page's
 *  AppBar hosts the hamburger button via <DrawerTrigger /> so there's
 *  only one header on mobile. */
export function MobileChrome({
  email,
  signOutAction,
}: {
  email?: string | null;
  signOutAction: () => Promise<void>;
}) {
  const { open, setOpen } = useDrawer();
  const path = usePathname();

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/40 animate-in fade-in"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-[78%] max-w-[320px] flex-col border-r border-outline-variant bg-surface-low shadow-2xl animate-in slide-in-from-left">
            <div className="flex items-center justify-between px-4 pt-5 pb-4">
              <Link href="/dashboard" prefetch className="flex items-center gap-3">
                <Logo size={32} priority />
                <div>
                  <div className="title-m coffer-serif">OpenCoffer</div>
                  <div className="body-s text-on-surface-variant">Self-hosted</div>
                </div>
              </Link>
              <button onClick={() => setOpen(false)} className="btn-icon" aria-label="Close menu">
                <X size={22} strokeWidth={1.75} />
              </button>
            </div>

            <nav className="flex-1 overflow-y-auto px-2 pb-4">
              <div className="eyebrow px-5 pb-2 pt-2">Workspace</div>
              {WORKSPACE_NAV.map((n) => (
                <DrawerLink key={n.href} {...n} path={path} />
              ))}
              <div className="eyebrow px-5 pb-2 pt-6">Settings</div>
              {SETTINGS_NAV.map((n) => (
                <DrawerLink key={n.href} {...n} path={path} />
              ))}
            </nav>

            <div className="border-t border-outline-variant px-3 py-3">
              <div className="flex items-center gap-3 px-2 py-1">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container">
                  <span className="title-s">{(email ?? "?").charAt(0).toUpperCase()}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="body-m truncate text-on-surface">{email ?? "—"}</div>
                  <div className="body-s text-on-surface-variant">Signed in</div>
                </div>
                <form action={signOutAction}>
                  <button type="submit" className="btn-icon" aria-label="Sign out">
                    <LogOut size={18} strokeWidth={1.75} />
                  </button>
                </form>
              </div>
            </div>
          </aside>
        </div>
      )}

      <nav
        className="coffer-glass mobile-dock fixed left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full px-1.5 py-1.5 md:hidden"
        style={{ bottom: "calc(env(safe-area-inset-bottom) + 8px)" }}
      >
        {BOTTOM_NAV.map((n) => {
          const active = isActive(path, n.href);
          const isChat = n.href === "/chat";
          return (
            <Link
              key={n.href}
              href={n.href}
              prefetch
              className={cn(
                "flex h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-full px-2 transition-colors",
                isChat
                  ? "mx-1 bg-primary text-on-primary shadow-[0_0_24px_hsl(var(--md-primary)/0.45)]"
                  : active
                    ? "bg-primary-container text-on-primary-container"
                    : "text-on-surface-variant hover:bg-on-surface/[0.05] hover:text-on-surface",
              )}
              aria-current={active ? "page" : undefined}
            >
              <n.Icon size={22} strokeWidth={active ? 2.2 : 1.75} />
              <span className={cn("text-[10px] font-medium leading-none", isChat && "sr-only")}>
                {n.label}
              </span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}

function DrawerLink({ href, label, Icon, path }: NavItem & { path: string }) {
  const active = isActive(path, href);
  return (
    <Link
      href={href}
      prefetch
      className={cn(
        "flex items-center gap-3 rounded-2xl px-4 py-3 text-on-surface transition-colors",
        active
          ? "bg-primary-container text-on-primary-container"
          : "hover:bg-on-surface/[0.04]",
      )}
      aria-current={active ? "page" : undefined}
    >
      <Icon size={20} strokeWidth={1.75} />
      <span className="body-l flex-1">{label}</span>
    </Link>
  );
}
