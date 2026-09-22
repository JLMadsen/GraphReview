import { redirect } from "next/navigation";

// Repo detail has no index view of its own — it always opens on the
// Branches tab (DESIGN.md §4).
export default async function RepoDetailIndexPage({
  params,
}: {
  params: Promise<{ repoId: string }>;
}) {
  const { repoId } = await params;
  redirect(`/repo/${repoId}/branches`);
}
