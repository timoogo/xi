import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { SourceDetailView } from "@/components/sources/source-detail";
import { getAccountStore } from "@/lib/accounts/server";
import { getAppDatabase } from "@/lib/auth";
import { getCurrentUser } from "@/lib/current-user";
import { getTopicStore } from "@/lib/topics/server";
import { TopicError } from "@/lib/topics/types";
import { sourceDetail } from "@/lib/watch/source-admin";
import { getWatchServices } from "@/lib/watch/server";

export const metadata = { title: "Ξ | Source" };
export const dynamic = "force-dynamic";

export default async function SourcePage({ params }: { params: Promise<{ sourceId: string }> }) {
  const user = await getCurrentUser();
  const { sourceId } = await params;
  const [accounts, topics, { sources }] = await Promise.all([getAccountStore(), getTopicStore(), getWatchServices()]);
  const detail = await sourceDetail({ db: getAppDatabase(), accounts, topics, sources }, user.id, sourceId)
    .catch(error => { if (error instanceof TopicError && error.status === 404) notFound(); throw error; });
  return <>
    <PageHeader title={detail.source.publisher} subtitle={detail.source.domain} back={{ href: "/dashboard/sources", label: "Retour aux sources" }} />
    <SourceDetailView initial={detail} />
  </>;
}
