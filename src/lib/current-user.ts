import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAvatarPreference } from "./avatar-preferences";
import { getAuth, getAppDatabase } from "./auth";
import { handleFor } from "./handle";

// React cache is scoped to one server render, never shared between users.
export const getCurrentUser = cache(async () => {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/auth/login");
  const { id, name, email } = session.user;
  const avatar = getAvatarPreference(getAppDatabase(), id);
  return { id, name, email, avatar, bloubSeed: avatar.seed, handle: handleFor(id) };
});

export type CurrentUser = Awaited<ReturnType<typeof getCurrentUser>>;
