"use client";

import { Bell, Compass, FileText, House, Info, LogOut, Monitor, Moon, MoreHorizontal, Network, ScrollText, Settings, Sun, UserRound, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useState } from "react";
import { toast } from "sonner";
import { NewPublicationButton } from "@/components/publications/publication-actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { UserAvatar } from "@/components/user-avatar";
import { XiLogo } from "@/components/xi-logo";
import { Logout } from "@/lib/apis/auth";
import type { CurrentUser } from "@/lib/current-user";
import { cn } from "@/lib/utils";

type User = Pick<CurrentUser, "name" | "image" | "handle" | "bloubSeed">;
type NavItem = { label: string; icon: LucideIcon; href: string };

const NAV_ITEMS: NavItem[] = [
  { label: "Accueil", icon: House, href: "/dashboard" },
  { label: "Explorer", icon: Compass, href: "/dashboard/explore" },
  { label: "Publications", icon: FileText, href: "/dashboard/publications" },
  { label: "Notifications", icon: Bell, href: "/dashboard/notifications" },
  { label: "Profil", icon: UserRound, href: "/dashboard/profile" },
  { label: "Graphe", icon: Network, href: "/dashboard/graph" },
  { label: "Gestion des topics", icon: Compass, href: "/dashboard/topics" },
  { label: "ΞAgents", icon: UserRound, href: "/dashboard/xiagents" },
];
const SECONDARY_ITEMS: NavItem[] = [
  { label: "Paramètres du compte", icon: Settings, href: "/dashboard/settings" },
  { label: "À propos de Ξ", icon: Info, href: "/dashboard/about-us" },
  { label: "Utiliser Ξ", icon: ScrollText, href: "/dashboard/terms" },
];
const THEMES = [{ value: "light", label: "Clair", icon: Sun }, { value: "dark", label: "Sombre", icon: Moon }, { value: "system", label: "Système", icon: Monitor }];

const isActive = (pathname: string, href: string) => href === "/dashboard" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

function useLogout(onDone?: () => void) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function logOut() {
    setPending(true);
    try {
      const result = await Logout();
      if (!result.ok) return void toast.error(result.message);
      onDone?.();
      router.replace("/auth/login");
      router.refresh();
    } catch {
      toast.error("Déconnexion impossible. Veuillez réessayer.");
    } finally {
      setPending(false);
    }
  }
  return { pending, logOut };
}

/**
 * Left rail on tablet and desktop (icons, then labels from xl), bottom tab bar on mobile.
 * Both render the same destinations; account actions live in a menu (desktop) or a sheet (mobile).
 */
export function Navigation({ user }: { user: User }) {
  const pathname = usePathname();
  return (
    <>
      <header className="sticky top-0 hidden h-dvh w-[72px] shrink-0 flex-col items-center gap-1 overflow-y-auto px-2 py-2 sm:flex xl:w-[275px] xl:items-stretch xl:px-3">
        <Link href="/dashboard" aria-label="Ξ — Accueil" className="mb-1 inline-flex size-12 items-center justify-center rounded-full hover:bg-accent xl:ml-0.5">
          <XiLogo size={28} aria-hidden="true" />
        </Link>
        <nav aria-label="Navigation principale" className="flex flex-col items-center gap-1 xl:items-stretch">
          {NAV_ITEMS.map((item) => <RailLink key={item.href} item={item} active={isActive(pathname, item.href)} />)}
        </nav>
        <NewPublicationButton className="mt-4 hidden h-[52px] w-full rounded-full text-[17px] font-bold xl:inline-flex" />
        <NewPublicationButton compact className="mt-4 size-[52px] rounded-full xl:hidden" />
        <div className="mt-auto pt-4 xl:w-full"><AccountMenu user={user} /></div>
      </header>
      <MobileBar user={user} pathname={pathname} />
    </>
  );
}

function RailLink({ item: { label, icon: Icon, href }, active }: { item: NavItem; active: boolean }) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} title={label}
      className="group inline-flex items-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
      <span className={cn("inline-flex items-center gap-5 rounded-full p-3 text-xl transition-colors group-hover:bg-accent xl:pr-6", active ? "font-bold text-foreground" : "text-foreground/80")}>
        <Icon aria-hidden="true" className="size-[26px]" strokeWidth={active ? 2.6 : 1.9} />
        <span className="hidden xl:inline">{label}</span>
      </span>
    </Link>
  );
}

function AccountMenu({ user }: { user: User }) {
  const { theme, setTheme } = useTheme();
  const { pending, logOut } = useLogout();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Compte et réglages"
        className="flex w-full items-center gap-3 rounded-full p-2 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 xl:p-3">
        <UserAvatar name={user.name} image={user.image} bloubSeed={user.bloubSeed} size={40} />
        <span className="hidden min-w-0 flex-1 xl:block">
          <span className="block truncate text-[15px] font-bold leading-5">{user.name}</span>
          <span className="block truncate text-[15px] leading-5 text-muted-foreground">{user.handle}</span>
        </span>
        <MoreHorizontal aria-hidden="true" className="hidden size-5 shrink-0 xl:block" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64">
        <DropdownMenuLabel className="truncate">{user.name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {SECONDARY_ITEMS.map(({ label, icon: Icon, href }) => (
          <DropdownMenuItem key={href} asChild><Link href={href}><Icon aria-hidden="true" />{label}</Link></DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Thème</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
          {THEMES.map(({ value, label }) => <DropdownMenuRadioItem key={value} value={value}>{label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={pending} onSelect={() => void logOut()}>
          <LogOut aria-hidden="true" />{pending ? "Déconnexion…" : "Se déconnecter"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MobileBar({ user, pathname }: { user: User; pathname: string }) {
  const [open, setOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const { pending, logOut } = useLogout(() => setOpen(false));
  const tabs = NAV_ITEMS.filter((item) => item.href !== "/dashboard/profile" && item.href !== "/dashboard/topics" && item.href !== "/dashboard/xiagents");
  // The editor has its own sticky actions: a floating button there would hide them.
  const editing = pathname.endsWith("/edit");
  return (
    <>
      {editing ? null : <NewPublicationButton compact className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-40 size-14 rounded-full shadow-lg sm:hidden" />}
      <nav aria-label="Navigation principale" className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md sm:hidden">
        {tabs.map(({ label, icon: Icon, href }) => {
          const active = isActive(pathname, href);
          return (
            <Link key={href} href={href} aria-label={label} aria-current={active ? "page" : undefined}
              className="flex h-14 flex-1 items-center justify-center text-foreground/80 aria-[current=page]:text-foreground">
              <Icon aria-hidden="true" className="size-[26px]" strokeWidth={active ? 2.6 : 1.9} />
            </Link>
          );
        })}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <button type="button" aria-label="Ouvrir le menu" className="flex h-14 flex-1 items-center justify-center">
              <UserAvatar name={user.name} image={user.image} bloubSeed={user.bloubSeed} size={30} />
            </button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[85vw] max-w-xs gap-0 overflow-y-auto p-0">
            <SheetTitle className="sr-only">Menu Ξ</SheetTitle>
            <SheetDescription className="sr-only">Votre compte, vos pages et vos réglages</SheetDescription>
            <div className="border-b p-4">
              <UserAvatar name={user.name} image={user.image} bloubSeed={user.bloubSeed} size={44} />
              <p className="mt-2 truncate font-bold">{user.name}</p>
              <p className="truncate text-sm text-muted-foreground">{user.handle}</p>
            </div>
            <nav aria-label="Menu du compte" className="flex flex-col py-2">
              {[NAV_ITEMS[4], NAV_ITEMS[6], NAV_ITEMS[7], ...SECONDARY_ITEMS].map(({ label, icon: Icon, href }) => (
                <Link key={href} href={href} onClick={() => setOpen(false)} aria-current={isActive(pathname, href) ? "page" : undefined}
                  className="flex items-center gap-4 px-4 py-3 text-lg font-semibold hover:bg-accent aria-[current=page]:font-bold">
                  <Icon aria-hidden="true" className="size-6" />{label}
                </Link>
              ))}
            </nav>
            <fieldset className="border-t px-4 py-3">
              <legend className="sr-only">Thème</legend>
              <p aria-hidden="true" className="mb-2 text-sm text-muted-foreground">Thème</p>
              <div className="flex gap-2">
                {THEMES.map(({ value, label, icon: Icon }) => (
                  <Button key={value} size="sm" variant={theme === value ? "default" : "outline"} aria-pressed={theme === value} onClick={() => setTheme(value)} className="flex-1 rounded-full">
                    <Icon aria-hidden="true" />{label}
                  </Button>
                ))}
              </div>
            </fieldset>
            <div className="border-t p-4">
              <Button variant="ghost" onClick={logOut} disabled={pending} className="w-full justify-start text-destructive hover:bg-destructive/10 hover:text-destructive">
                <LogOut aria-hidden="true" />{pending ? "Déconnexion…" : "Se déconnecter"}
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </nav>
    </>
  );
}
