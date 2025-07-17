-- DropForeignKey
ALTER TABLE "GoogleCampaign" DROP CONSTRAINT "GoogleCampaign_customer_account_id_fkey";

-- CreateTable
CREATE TABLE "GoogleCampaignConfig" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL DEFAULT 'single-org',
    "syncInterval" TEXT NOT NULL DEFAULT 'EVERY_HOUR',
    "autoSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleCampaignConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_GoogleCampaignConfigToAdAccount" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_GoogleCampaignConfigToAdAccount_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoogleCampaignConfig_orgId_key" ON "GoogleCampaignConfig"("orgId");

-- CreateIndex
CREATE INDEX "_GoogleCampaignConfigToAdAccount_B_index" ON "_GoogleCampaignConfigToAdAccount"("B");

-- AddForeignKey
ALTER TABLE "GoogleCampaignConfig" ADD CONSTRAINT "GoogleCampaignConfig_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleCampaign" ADD CONSTRAINT "GoogleCampaign_customer_account_id_fkey" FOREIGN KEY ("customer_account_id") REFERENCES "GoogleAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_GoogleCampaignConfigToAdAccount" ADD CONSTRAINT "_GoogleCampaignConfigToAdAccount_A_fkey" FOREIGN KEY ("A") REFERENCES "GoogleAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_GoogleCampaignConfigToAdAccount" ADD CONSTRAINT "_GoogleCampaignConfigToAdAccount_B_fkey" FOREIGN KEY ("B") REFERENCES "GoogleCampaignConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
