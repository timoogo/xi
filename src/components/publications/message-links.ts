export function messageHref(ref: string) {
  const [id, number] = ref.split("/");
  return `/dashboard/publications/${id}/conversation/${number}`;
}
