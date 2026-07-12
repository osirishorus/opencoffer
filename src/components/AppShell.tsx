import Link from "next/link";
import { LogOut } from "lucide-react";
import { Logo } from "@/components/Logo";
import { MobileChrome } from "@/components/MobileNav";
import { DrawerProvider } from "@/components/DrawerContext";
import { DataAutoRefresh } from "@/components/DataAutoRefresh";
import { DesktopNav } from "@/components/DesktopNav";
import { ToasterProvider } from "@/components/Toaster";
import { ConfirmProvider } from "@/components/ConfirmDialog";

async function signOutAction() {
  "use server";
  const { signOut } = await import("@/auth");
  await signOut({ redirectTo: "/login" });
}

export function AppShell({
  children,
  email,
}: {
  children: React.ReactNode;
  email?: string | null;
}) {
  return (
    <DrawerProvider>
    <ToasterProvider>
    <ConfirmProvider>
    <div className="min-h-screen bg-surface text-on-surface md:grid md:grid-cols-[244px_1fr]">
      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-outline-variant bg-surface/70 px-4 py-5 backdrop-blur-xl md:flex">
        <Link
          href="/dashboard"
          prefetch
          className="coffer-glass flex h-12 items-center gap-3 rounded-2xl px-3 text-on-surface"
          title="OpenCoffer"
        >
          <Logo size={34} priority withWordmark />
        </Link>

        <DesktopNav />

        <div className="mt-4 flex items-center gap-3 border-t border-outline-variant pt-4">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-on-surface/10 text-on-surface"
            title={email ?? "Signed in"}
          >
            <span className="title-s">{(email ?? "?").charAt(0).toUpperCase()}</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="body-m truncate text-on-surface">{email ?? "Signed in"}</div>
            <div className="body-s text-on-surface-variant">Local vault</div>
          </div>
            <form action={signOutAction}>
              <button type="submit" className="btn-icon" title="Sign out" aria-label="Sign out">
                <LogOut size={18} strokeWidth={1.75} />
              </button>
            </form>
        </div>
      </aside>

      <MobileChrome email={email} signOutAction={signOutAction} />
      <DataAutoRefresh />

      {/* Pages add their own bottom clearance (pb-24 md:pb-0) for the mobile
          bottom nav. The chat page opts out because it computes its own
          viewport-bound layout. */}
      <main className="min-h-screen">{children}</main>
    </div>
    </ConfirmProvider>
    </ToasterProvider>
    </DrawerProvider>
  );
}
