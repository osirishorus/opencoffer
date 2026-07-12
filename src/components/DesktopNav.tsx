"use client";

import { DesktopNavLink } from "@/components/DesktopNavLink";
import { WORKSPACE_NAV, SETTINGS_NAV } from "@/components/nav-config";

export function DesktopNav() {
  return (
    <>
      <nav className="mt-8 flex flex-col gap-2">
        <div className="overline px-3 pb-1">Workspace</div>
        {WORKSPACE_NAV.map((n) => (
          <DesktopNavLink key={n.href} {...n} />
        ))}
      </nav>

      <nav className="mt-auto flex flex-col gap-2">
        <div className="overline px-3 pb-1">Settings</div>
        {SETTINGS_NAV.map((n) => (
          <DesktopNavLink key={n.href} {...n} />
        ))}
      </nav>
    </>
  );
}
