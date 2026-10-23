import { redirect } from "next/navigation";
export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const { run } = await searchParams;
  redirect(`/dashboard/xiagents${typeof run === "string" ? `?run=${encodeURIComponent(run)}` : ""}`);
}
