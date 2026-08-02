-- CreateTable
CREATE TABLE "ChaseNotice" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "bankTxnId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "sentBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChaseNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChaseNotice_clientId_bankTxnId_idx" ON "ChaseNotice"("clientId", "bankTxnId");

-- AddForeignKey
ALTER TABLE "ChaseNotice" ADD CONSTRAINT "ChaseNotice_bankTxnId_fkey" FOREIGN KEY ("bankTxnId") REFERENCES "BankTxn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
