-- CreateTable
CREATE TABLE "MetaCampaignConfig" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL DEFAULT 'single-org',
    "syncInterval" TEXT NOT NULL DEFAULT 'EVERY_HOUR',
    "adAccountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "autoSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaCampaignConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MetaCampaignConfig_orgId_key" ON "MetaCampaignConfig"("orgId");

-- AddForeignKey
ALTER TABLE "MetaCampaignConfig" ADD CONSTRAINT "MetaCampaignConfig_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
