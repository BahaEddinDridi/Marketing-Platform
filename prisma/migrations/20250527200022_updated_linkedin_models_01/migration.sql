/*
  Warnings:

  - You are about to drop the column `adAccounts` on the `LinkedInCampaignConfig` table. All the data in the column will be lost.
  - You are about to drop the column `campaignGroups` on the `LinkedInCampaignConfig` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "LinkedInCampaignConfig" DROP COLUMN "adAccounts",
DROP COLUMN "campaignGroups";

-- CreateTable
CREATE TABLE "_LinkedInCampaignConfigToAdAccount" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_LinkedInCampaignConfigToAdAccount_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_LinkedInCampaignConfigToCampaignGroup" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_LinkedInCampaignConfigToCampaignGroup_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_LinkedInCampaignConfigToAdAccount_B_index" ON "_LinkedInCampaignConfigToAdAccount"("B");

-- CreateIndex
CREATE INDEX "_LinkedInCampaignConfigToCampaignGroup_B_index" ON "_LinkedInCampaignConfigToCampaignGroup"("B");

-- AddForeignKey
ALTER TABLE "_LinkedInCampaignConfigToAdAccount" ADD CONSTRAINT "_LinkedInCampaignConfigToAdAccount_A_fkey" FOREIGN KEY ("A") REFERENCES "AdAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LinkedInCampaignConfigToAdAccount" ADD CONSTRAINT "_LinkedInCampaignConfigToAdAccount_B_fkey" FOREIGN KEY ("B") REFERENCES "LinkedInCampaignConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LinkedInCampaignConfigToCampaignGroup" ADD CONSTRAINT "_LinkedInCampaignConfigToCampaignGroup_A_fkey" FOREIGN KEY ("A") REFERENCES "CampaignGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LinkedInCampaignConfigToCampaignGroup" ADD CONSTRAINT "_LinkedInCampaignConfigToCampaignGroup_B_fkey" FOREIGN KEY ("B") REFERENCES "LinkedInCampaignConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
