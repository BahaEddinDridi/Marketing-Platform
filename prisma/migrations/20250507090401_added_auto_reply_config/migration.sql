-- CreateTable
CREATE TABLE "AutoReplyConfig" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "triggerValue" TEXT,
    "templateId" TEXT NOT NULL,
    "mailbox" TEXT,
    "schedule" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoReplyConfig_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "AutoReplyConfig" ADD CONSTRAINT "AutoReplyConfig_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
