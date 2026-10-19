import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import { XiLogo } from "@/components/xi-logo";
import React, { ReactNode } from "react";

interface AuthLayoutProps {
  children: ReactNode;
}

/**
 * Auth layout component
 * - Left side: branding image (hidden on small screens)
 * - Right side: renders the auth form (login/register)
 */
export default async function AuthLayout({ children }: AuthLayoutProps) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session) redirect("/dashboard");
  return (
    <div className="flex justify-between items-center">
      {/* Left side image (visible only on large screens) */}
      <div className="hidden lg:flex w-1/2 h-screen items-center bg-black">
        <XiLogo className="w-full h-80 text-white" />
      </div>

      {/* Right side content (auth forms) */}
      <div className="flex items-center w-full mx-auto lg:w-1/2">
        {children}
      </div>
    </div>
  );
}

