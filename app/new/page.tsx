import { NewNoteFlow } from "@/components/new-note-flow";

export default async function NewPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  return (
    <main className="mx-auto max-w-6xl px-5 py-16 sm:px-8 md:py-24">
      <NewNoteFlow initialQuery={q ?? ""} />
    </main>
  );
}
