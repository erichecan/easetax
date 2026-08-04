import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { getDocumentForReview } from "@/lib/queries";
import { ReviewWorkbench } from "@/components/review-workbench";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const data = await getDocumentForReview(session.firmId, id);
  if (!data) notFound();

  return (
    <ReviewWorkbench
      doc={data.doc}
      client={data.client}
      accounts={data.accounts}
      taxCodes={data.taxCodes}
      ocrText={data.ocrText}
      nextDocId={data.nextDocId}
      remainingCount={data.remainingCount}
    />
  );
}
