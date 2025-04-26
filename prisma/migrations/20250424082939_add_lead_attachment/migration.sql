-- DropForeignKey
ALTER TABLE "LeadEmail" DROP CONSTRAINT "LeadEmail_leadId_fkey";

-- CreateTable
CREATE TABLE "LeadAttachment" (
    "id" TEXT NOT NULL,
    "leadEmailId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "cloudinaryUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadAttachment_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "LeadAttachment" ADD CONSTRAINT "LeadAttachment_leadEmailId_fkey" FOREIGN KEY ("leadEmailId") REFERENCES "LeadEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEmail" ADD CONSTRAINT "LeadEmail_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("lead_id") ON DELETE CASCADE ON UPDATE CASCADE;
