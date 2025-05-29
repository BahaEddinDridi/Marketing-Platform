-- CreateTable
CREATE TABLE "LinkedInCampaignConfig" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL DEFAULT 'single-org',
    "syncInterval" TEXT NOT NULL DEFAULT 'EVERY_15_MINUTES',
    "adAccounts" JSONB NOT NULL,
    "campaignGroups" JSONB NOT NULL,
    "autoSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedInCampaignConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkedInCampaignConfig_orgId_key" ON "LinkedInCampaignConfig"("orgId");

-- AddForeignKey
ALTER TABLE "LinkedInCampaignConfig" ADD CONSTRAINT "LinkedInCampaignConfig_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
