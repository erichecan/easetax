-- AlterTable
ALTER TABLE "ClassificationRule" ADD COLUMN     "confirmedCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "autoPostEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoPostThreshold" DECIMAL(14,2),
ADD COLUMN     "province" TEXT,
ADD COLUMN     "taxNumber" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "qboEntity" TEXT,
ADD COLUMN     "settlement" TEXT;

-- AlterTable
ALTER TABLE "Extraction" ADD COLUMN     "paymentTerms" TEXT,
ADD COLUMN     "recipientName" TEXT,
ADD COLUMN     "supplierTaxNumber" TEXT;

-- CreateTable
CREATE TABLE "TaxCodeCache" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "qboTaxCodeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(6,3),
    "isGroup" BOOLEAN NOT NULL DEFAULT false,
    "purchaseUse" BOOLEAN NOT NULL DEFAULT true,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxCodeCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxCodeCache_clientId_qboTaxCodeId_key" ON "TaxCodeCache"("clientId", "qboTaxCodeId");

-- AddForeignKey
ALTER TABLE "TaxCodeCache" ADD CONSTRAINT "TaxCodeCache_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
