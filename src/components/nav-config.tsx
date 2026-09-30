import {
  LayoutDashboard,
  MessageSquare,
  Repeat,
  LineChart,
  PieChart,
  Plug,
  Cpu,
  Network,
  Wallet,
  Bell,
  Users,
  Landmark,
  Gem,
  Receipt,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
};

/** Full workspace navigation — desktop sidebar and mobile drawer. */
export const WORKSPACE_NAV: NavItem[] = [
  { href: "/dashboard", label: "Overview", Icon: LayoutDashboard },
  { href: "/dashboard/transactions", label: "Transactions", Icon: Receipt },
  { href: "/dashboard/charts", label: "Charts", Icon: PieChart },
  { href: "/chat", label: "Chat", Icon: MessageSquare },
  { href: "/dashboard/subscriptions", label: "Recurring", Icon: Repeat },
  { href: "/dashboard/investments", label: "Holdings", Icon: LineChart },
  { href: "/dashboard/assets", label: "Assets", Icon: Gem },
  { href: "/alerts", label: "Alerts", Icon: Bell },
];

export const SETTINGS_NAV: NavItem[] = [
  { href: "/settings/connections", label: "Connections", Icon: Plug },
  { href: "/settings/accounts", label: "Accounts", Icon: Landmark },
  { href: "/settings/budgets", label: "Budgets", Icon: Wallet },
  { href: "/settings/household", label: "Household", Icon: Users },
  { href: "/settings/notifications", label: "Notifications", Icon: Bell },
  { href: "/settings/llm", label: "Models", Icon: Cpu },
  { href: "/settings/mcp", label: "MCP", Icon: Network },
];

/** Bottom-bar destinations. Five slots — drawer lives on the AppBar hamburger,
 *  no duplicate "More" button here. Transactions earns a slot over Holdings:
 *  it's the page people reach for most, and Holdings stays in the drawer. */
export const BOTTOM_NAV: NavItem[] = [
  { href: "/dashboard", label: "Overview", Icon: LayoutDashboard },
  { href: "/dashboard/transactions", label: "Activity", Icon: Receipt },
  { href: "/chat", label: "Chat", Icon: MessageSquare },
  { href: "/dashboard/charts", label: "Charts", Icon: PieChart },
  { href: "/dashboard/subscriptions", label: "Recurring", Icon: Repeat },
];

/** Routes the bottom-nav tab should highlight for, in addition to the literal href. */
const NAV_ALIASES: Record<string, string[]> = {
  "/dashboard": [],
  "/dashboard/transactions": [],
  "/dashboard/charts": [],
  "/chat": [],
  "/dashboard/subscriptions": [],
  "/dashboard/investments": [],
};

export function isActive(path: string, href: string): boolean {
  if (href === "/dashboard") return path === "/dashboard" || (NAV_ALIASES["/dashboard"]?.includes(path) ?? false);
  if (path === href) return true;
  if (path.startsWith(href + "/")) return true;
  return NAV_ALIASES[href]?.some((a) => path === a || path.startsWith(a + "/")) ?? false;
}
