import { ConversationView } from "@/components/publications/conversation-view";
import { getCurrentUser } from "@/lib/current-user";
import { notFound } from "next/navigation";
export default async function ConversationPage({ params }: { params: Promise<{ id: string; number: string }> }) {
  const [{ id, number }] = await Promise.all([params, getCurrentUser()]);
  if (!/^[1-9]\d*$/.test(number)) notFound();
  return <ConversationView key={`${id}/${number}`} messageRef={`${id}/${number}`} />;
}
