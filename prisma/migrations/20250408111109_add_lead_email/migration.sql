-- CreateTable
CREATE TABLE "LeadEmail" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyPreview" TEXT NOT NULL,
    "hasAttachments" BOOLEAN NOT NULL,
    "receivedDateTime" TIMESTAMP(3) NOT NULL,
    "emailId" TEXT NOT NULL,
    "senderName" TEXT,
    "senderEmail" TEXT NOT NULL,

    CONSTRAINT "LeadEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadEmail_leadId_key" ON "LeadEmail"("leadId");

-- CreateIndex
CREATE INDEX "LeadEmail_leadId_idx" ON "LeadEmail"("leadId");

-- AddForeignKey
ALTER TABLE "LeadEmail" ADD CONSTRAINT "LeadEmail_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("lead_id") ON DELETE RESTRICT ON UPDATE CASCADE;
